const express = require('express');
const router = express.Router();
const { randomUUID: uuidv4 } = require('crypto');
const db = require('../db/database');
const geminiService = require('../services/gemini');

// Auth middleware
function isAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

const INSERT_ACTIVITY = `
  INSERT INTO trip_activities (trip_id, day_number, time_slot, activity_name, description, location, estimated_cost, category)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

function activityRows(tripId, itinerary) {
  const rows = [];
  if (!itinerary || !Array.isArray(itinerary.days)) return rows;

  itinerary.days.forEach((day, index) => {
    const dayNumber = Number(day.day) || index + 1;
    if (!Array.isArray(day.activities)) return;

    for (const act of day.activities) {
      rows.push([
        tripId,
        dayNumber,
        act.time || '',
        act.name || 'Activity',
        act.description || '',
        act.location || '',
        parseFloat(act.estimated_cost) || 0,
        act.category || 'general'
      ]);
    }
  });

  return rows;
}

// Uses the caller's transaction handle (`tx`) when one is supplied.
async function saveTripActivities(tripId, itinerary, tx = db) {
  for (const row of activityRows(tripId, itinerary)) {
    await tx.run(INSERT_ACTIVITY, row);
  }
}

// Generate new itinerary
router.post('/generate', isAuthenticated, async (req, res) => {
  try {
    const { destination, duration, mood, groupType, budget, interests, startDate, endDate, notes } = req.body;

    if (!destination || !duration) {
      return res.status(400).json({ error: 'Destination and duration are required' });
    }

    const days = parseInt(duration, 10);
    if (!Number.isFinite(days) || days < 1 || days > 30) {
      return res.status(400).json({ error: 'Duration must be between 1 and 30 days' });
    }

    // Get user preferences
    const prefs = await db.get('SELECT * FROM user_preferences WHERE user_id = ?', [req.user.id]);

    const result = await geminiService.generateItinerary({
      destination,
      duration: days,
      mood: mood || 'adventurous',
      groupType: groupType || 'solo',
      budget: budget || 'medium',
      interests: Array.isArray(interests) ? interests : [],
      preferences: prefs
    });

    const itinerary = { ...result.data, ai_generated: Boolean(result.aiGenerated) };
    const tripId = uuidv4();

    await db.transaction(async (tx) => {
      await tx.run(`
        INSERT INTO trips (id, user_id, destination, start_date, end_date, duration_days, mood, group_type, budget, interests, itinerary, notes, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        tripId,
        req.user.id,
        destination,
        startDate || null,
        endDate || null,
        days,
        mood || 'adventurous',
        groupType || 'solo',
        budget || 'medium',
        JSON.stringify(Array.isArray(interests) ? interests : []),
        JSON.stringify(itinerary),
        notes || '',
        'planned'
      ]);

      await saveTripActivities(tripId, itinerary, tx);
    });

    res.json({
      success: true,
      tripId,
      itinerary,
      aiGenerated: Boolean(result.aiGenerated),
      warning: result.warning || null
    });
  } catch (error) {
    console.error('Generate Error:', error);
    res.status(500).json({ error: 'Failed to generate itinerary' });
  }
});

// Rebuild an existing trip's itinerary with fresh places
router.post('/:id/regenerate', isAuthenticated, async (req, res) => {
  try {
    const trip = await db.get('SELECT * FROM trips WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!trip) return res.status(404).json({ error: 'Trip not found' });

    const prefs = await db.get('SELECT * FROM user_preferences WHERE user_id = ?', [req.user.id]);
    let previous = {};
    try { previous = JSON.parse(trip.itinerary || '{}'); } catch (_) { previous = {}; }

    const result = await geminiService.generateItinerary({
      destination: trip.destination,
      duration: trip.duration_days,
      mood: trip.mood,
      groupType: trip.group_type,
      budget: trip.budget,
      interests: JSON.parse(trip.interests || '[]'),
      preferences: prefs,
      previousPlan: previous
    });

    const itinerary = { ...result.data, ai_generated: Boolean(result.aiGenerated) };

    await db.transaction(async (tx) => {
      await tx.run('UPDATE trips SET itinerary = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
        JSON.stringify(itinerary),
        trip.id
      ]);
      await tx.run('DELETE FROM trip_activities WHERE trip_id = ?', [trip.id]);
      await saveTripActivities(trip.id, itinerary, tx);
    });

    res.json({
      success: true,
      tripId: trip.id,
      itinerary,
      aiGenerated: Boolean(result.aiGenerated),
      warning: result.warning || null
    });
  } catch (error) {
    console.error('Regenerate Error:', error);
    res.status(500).json({ error: 'Failed to regenerate itinerary' });
  }
});

// Get all trips for user
router.get('/', isAuthenticated, async (req, res) => {
  const trips = await db.all('SELECT * FROM trips WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);

  const tripsWithParsed = trips.map(t => ({
    ...t,
    interests: JSON.parse(t.interests || '[]'),
    itinerary: JSON.parse(t.itinerary || '{}')
  }));

  res.json({ trips: tripsWithParsed });
});

// Get single trip
router.get('/:id', isAuthenticated, async (req, res) => {
  const trip = await db.get('SELECT * FROM trips WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);

  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const activities = await db.all(
    'SELECT * FROM trip_activities WHERE trip_id = ? ORDER BY day_number, time_slot',
    [req.params.id]
  );

  res.json({
    trip: {
      ...trip,
      interests: JSON.parse(trip.interests || '[]'),
      itinerary: JSON.parse(trip.itinerary || '{}')
    },
    activities
  });
});

// Update trip status
router.patch('/:id/status', isAuthenticated, async (req, res) => {
  const { status } = req.body;
  const allowed = ['planned', 'ongoing', 'completed'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `Status must be one of: ${allowed.join(', ')}` });
  }
  const result = await db.run(
    'UPDATE trips SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
    [status, req.params.id, req.user.id]
  );
  if (result.changes === 0) return res.status(404).json({ error: 'Trip not found' });
  res.json({ success: true, status });
});

// Delete trip
router.delete('/:id', isAuthenticated, async (req, res) => {
  const result = await db.run('DELETE FROM trips WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (result.changes === 0) return res.status(404).json({ error: 'Trip not found' });
  res.json({ success: true });
});

// Toggle activity completion
router.patch('/activity/:id/toggle', isAuthenticated, async (req, res) => {
  const activity = await db.get(`
    SELECT ta.id FROM trip_activities ta
    JOIN trips t ON ta.trip_id = t.id
    WHERE ta.id = ? AND t.user_id = ?
  `, [req.params.id, req.user.id]);

  if (!activity) return res.status(404).json({ error: 'Activity not found' });

  // Portable boolean flip for both SQLite (0/1) and Postgres.
  await db.run('UPDATE trip_activities SET is_completed = 1 - is_completed WHERE id = ?', [activity.id]);
  const updated = await db.get('SELECT is_completed FROM trip_activities WHERE id = ?', [activity.id]);
  res.json({ success: true, is_completed: Boolean(Number(updated.is_completed)) });
});

// Get suggestions
router.post('/suggestions', isAuthenticated, async (req, res) => {
  try {
    const { mood, groupType, budget, currentLocation, season } = req.body;
    const result = await geminiService.getSuggestions({ mood, groupType, budget, currentLocation, season });
    res.json(result);
  } catch (error) {
    console.error('Suggestions Error:', error);
    res.status(500).json({ error: 'Failed to get suggestions' });
  }
});

// Get dashboard stats
router.get('/stats/dashboard', isAuthenticated, async (req, res) => {
  const userId = req.user.id;

  const [totalTrips, plannedTrips, completedTrips, totalActivities, recentTrips, topDestinations, savedPlaces] = await Promise.all([
    db.get('SELECT COUNT(*) as count FROM trips WHERE user_id = ?', [userId]),
    db.get("SELECT COUNT(*) as count FROM trips WHERE user_id = ? AND status = 'planned'", [userId]),
    db.get("SELECT COUNT(*) as count FROM trips WHERE user_id = ? AND status = 'completed'", [userId]),
    db.get(`
      SELECT COUNT(*) as count FROM trip_activities ta
      JOIN trips t ON ta.trip_id = t.id
      WHERE t.user_id = ?
    `, [userId]),
    db.all('SELECT * FROM trips WHERE user_id = ? ORDER BY created_at DESC LIMIT 5', [userId]),
    db.all(`
      SELECT destination, COUNT(*) as count FROM trips WHERE user_id = ? GROUP BY destination ORDER BY count DESC LIMIT 5
    `, [userId]),
    db.get('SELECT COUNT(*) as count FROM saved_places WHERE user_id = ?', [userId])
  ]);

  res.json({
    stats: {
      totalTrips: Number(totalTrips.count),
      plannedTrips: Number(plannedTrips.count),
      completedTrips: Number(completedTrips.count),
      totalActivities: Number(totalActivities.count),
      savedPlaces: Number(savedPlaces.count),
      topDestinations: topDestinations.map((row) => ({ ...row, count: Number(row.count) }))
    },
    recentTrips: recentTrips.map(t => ({
      ...t,
      interests: JSON.parse(t.interests || '[]'),
      itinerary: JSON.parse(t.itinerary || '{}')
    }))
  });
});

// Save a place
router.post('/places/save', isAuthenticated, async (req, res) => {
  const { placeName, country, description, category, rating } = req.body;
  if (!placeName) return res.status(400).json({ error: 'placeName is required' });

  const result = await db.run(`
    INSERT INTO saved_places (user_id, place_name, country, description, category, rating)
    VALUES (?, ?, ?, ?, ?, ?)
    RETURNING id
  `, [req.user.id, placeName, country || '', description || '', category || 'general', Number(rating) || 0]);

  res.json({ success: true, id: result.id });
});

// Get saved places
router.get('/places/saved', isAuthenticated, async (req, res) => {
  const places = await db.all('SELECT * FROM saved_places WHERE user_id = ? ORDER BY saved_at DESC', [req.user.id]);
  res.json({ places });
});

// Remove a saved place
router.delete('/places/:id', isAuthenticated, async (req, res) => {
  const result = await db.run('DELETE FROM saved_places WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (result.changes === 0) return res.status(404).json({ error: 'Saved place not found' });
  res.json({ success: true });
});

// Update preferences
router.put('/preferences', isAuthenticated, async (req, res) => {
  const { preferred_climate, budget_range, travel_style, dietary_restrictions, accessibility_needs, favorite_activities } = req.body;

  const values = [
    preferred_climate || 'any',
    budget_range || 'medium',
    travel_style || 'balanced',
    dietary_restrictions || '',
    accessibility_needs || '',
    JSON.stringify(favorite_activities || [])
  ];

  const existing = await db.get('SELECT id FROM user_preferences WHERE user_id = ?', [req.user.id]);

  if (existing) {
    await db.run(`
      UPDATE user_preferences SET
        preferred_climate = ?, budget_range = ?, travel_style = ?,
        dietary_restrictions = ?, accessibility_needs = ?, favorite_activities = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `, [...values, req.user.id]);
  } else {
    await db.run(`
      INSERT INTO user_preferences
        (preferred_climate, budget_range, travel_style, dietary_restrictions, accessibility_needs, favorite_activities, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [...values, req.user.id]);
  }

  res.json({ success: true });
});

module.exports = router;
