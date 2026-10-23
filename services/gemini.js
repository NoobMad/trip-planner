const { GoogleGenerativeAI } = require('@google/generative-ai');

// Names that describe a *category* of activity instead of a real place. These are
// what makes an itinerary feel like filler ("Breakfast in Goa", "Morning Exploration").
const GENERIC_NAME_PATTERNS = [
  /^(breakfast|brunch|lunch|dinner|supper|snack|coffee|tea|drinks?|meals?|meal break|food break)(\s+(break|stop|time|in town))?$/,
  /^(breakfast|brunch|lunch|dinner|supper|snack|coffee|drinks?)\s+(at|in|near)\s+(the\s+)?(hotel|hostel|airbnb|accommodation|local\s+\w+|caf[eé]|restaurant|market|city|town|centre|center)$/,
  /^(morning|afternoon|evening|night|sunrise|sunset)\s+(exploration|explore|walk|stroll|activity|activities|discovery|tour|sightseeing|free time|leisure|relaxation)\b/,
  /^(sightseeing|exploring|explore|exploration|free time|leisure|relaxation|rest|shopping|local exploring|city exploring)\b/,
  /^(visit|explore|discover|see)\s+(the\s+)?(city|town|village|destination|area|surroundings|old town|local area|local market|locals?)\b/,
  /^(local|traditional|regional)\s+(cuisine|food|meal|breakfast|lunch|dinner|market|culture|experience)\b/,
  /^(guided\s+)?(city|walking|sightseeing|boat|bus|bike)\s+(tour|walk|ride)$/,
  /^(day|morning|afternoon|evening)\s*\d*\s*[-–:]?\s*(exploration|explore|sightseeing|activities|adventure|discovery|free time)?$/,
  /^(activity|activities|adventure|discovery|exploration|experience|tour|excursion|attraction|landmark)s?$/,
  /^(tbd|to be decided|rest|check[- ]?in|check[- ]?out|free)$/
];

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

class GeminiService {
  constructor() {
    // .trim() also strips a BOM, which some CLIs leave at the start of pasted secrets.
    this.apiKey = (process.env.GEMINI_API_KEY || '').trim();
    this.modelName = (process.env.GEMINI_MODEL || 'gemini-3.5-flash').trim();
    // Tried in order when a model is retired, overloaded, or times out.
    this.modelChain = [...new Set([this.modelName, 'gemini-3.5-flash', 'gemini-3.1-flash-lite'])];
    this.requestOptions = { timeout: 60000 };
    this.genAI = this.apiKey ? new GoogleGenerativeAI(this.apiKey) : null;
  }

  async generateContent(prompt, { json = false, temperature = 0.85, maxOutputTokens = 8192 } = {}) {
    if (!this.genAI) throw new Error('GEMINI_API_KEY is not configured');

    const generationConfig = { temperature, maxOutputTokens };
    if (json) generationConfig.responseMimeType = 'application/json';

    let lastError;

    for (const name of this.modelChain) {
      try {
        const model = this.genAI.getGenerativeModel({ model: name, generationConfig }, this.requestOptions);
        const result = await model.generateContent(prompt);
        const text = result.response.text();

        if (name !== this.modelName) {
          console.warn(`Gemini fell back to "${name}".`);
          this.modelName = name;
        }

        return text;
      } catch (error) {
        lastError = error;
        const message = error.message || '';
        const retryable = /503|429|500|overload|high demand|timeout|timed out|deadline|not found|no longer available|not supported|invalid model/i.test(message);

        if (!retryable) throw error;
        console.warn(`Gemini model "${name}" unavailable (${message.slice(0, 140)}). Trying next model…`);
      }
    }

    throw lastError;
  }

  // Gemini occasionally wraps JSON in fences or adds prose; recover the object.
  parseJson(text) {
    const cleaned = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
    try {
      return JSON.parse(cleaned);
    } catch (_) {
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start !== -1 && end > start) {
        return JSON.parse(cleaned.slice(start, end + 1));
      }
      throw new Error('Model did not return valid JSON');
    }
  }

  /**
   * True when `name` describes a slot ("Breakfast", "Morning Exploration") rather
   * than an actual venue ("Breakfast at Café Central").
   */
  isGenericName(name, destination) {
    const raw = String(name || '').trim();
    if (raw.length < 4) return true;

    const dest = String(destination || '').trim().toLowerCase();
    const lower = raw.toLowerCase();

    if (dest && lower === dest) return true;

    // Judge "Breakfast in Goa" on the word "Breakfast" alone.
    const withoutDest = dest
      ? lower.replace(new RegExp(`[\\s,–-]+(in|at|near|around)\\s+${escapeRegExp(dest)}\\s*$`), '').trim()
      : lower;

    if (!withoutDest) return true;
    if (!GENERIC_NAME_PATTERNS.some((pattern) => pattern.test(withoutDest))) return false;

    // Escape hatch: the generic opener is followed by a real proper noun,
    // e.g. "Evening Stroll along Passeig de Gràcia" or "Lunch at Bar Cañete".
    const afterPreposition = raw.match(/\b(?:at|in|along|on|through|across|inside|near)\s+([A-ZÀ-Þ][^\s].*)$/);
    if (afterPreposition) {
      const target = afterPreposition[1].trim().toLowerCase();
      if (target && target !== dest && !target.startsWith(`${dest},`) && !dest.startsWith(target)) return false;
    }

    return true;
  }

  /**
   * Returns a list of problems with a generated itinerary. An empty list means the
   * plan is specific enough to show to a traveller.
   */
  validateItinerary(itinerary, destination, duration) {
    const issues = [];
    const days = Array.isArray(itinerary?.days) ? itinerary.days : [];

    if (!days.length) return ['"days" is empty — no day-by-day plan was returned.'];
    if (duration && days.length < Math.min(duration, 2)) {
      issues.push(`Expected ${duration} days of activities but only received ${days.length}.`);
    }

    const seen = new Map();
    let total = 0;
    let genericCount = 0;
    let vagueLocations = 0;

    days.forEach((day, index) => {
      const dayNumber = Number(day.day) || index + 1;
      const activities = Array.isArray(day.activities) ? day.activities : [];

      if (activities.length < 3) {
        issues.push(`Day ${dayNumber} only has ${activities.length} activities (minimum 3).`);
      }

      activities.forEach((activity) => {
        total += 1;
        const name = String(activity.name || '').trim();

        if (this.isGenericName(name, destination)) {
          genericCount += 1;
          if (genericCount <= 3) {
            issues.push(`"${name || '(empty)'}" is a generic time slot, not a real named place.`);
          }
        }

        const key = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        if (key) {
          if (seen.has(key)) {
            issues.push(`"${name}" is repeated (also used on day ${seen.get(key)}).`);
          } else {
            seen.set(key, dayNumber);
          }
        }

        const location = String(activity.location || '').trim().toLowerCase();
        if (!location || (destination && location === String(destination).trim().toLowerCase())) {
          vagueLocations += 1;
        }
      });
    });

    if (total === 0) {
      issues.push('No activities were returned at all.');
    } else if (vagueLocations > total * 0.5) {
      issues.push('Most activities have no street address or neighbourhood — name the actual address/area for each place.');
    }

    return issues;
  }

  buildItineraryPrompt({ destination, duration, mood, groupType, budget, interests, preferences, previousPlan }) {
    const seenBefore = Array.isArray(previousPlan?.days)
      ? previousPlan.days
        .flatMap((day) => (Array.isArray(day.activities) ? day.activities : []))
        .map((activity) => String(activity.name || '').trim())
        .filter(Boolean)
      : [];

    return `You are a professional local guide who has lived in ${destination} for years. Build a ${duration}-day itinerary for a ${groupType} traveller with a ${mood} mood and a ${budget} budget.

=== THE RULE THAT MATTERS MOST: NAME REAL PLACES ===
Every single activity must name a specific, real, currently-existing place in ${destination}: a museum, monument, gallery, temple, church, beach, trail, park, market, neighbourhood, restaurant, café, bar or shop.

GOOD names:
- "Sagrada Família"
- "Lunch at Bar Cañete"
- "Sunset at Barceloneta Beach"
- "Coffee and pastries at Café de l'Acadèmia"
- "Rijksmuseum — Gallery of Honour"
- "Sunrise walk along Palolem Beach"

FORBIDDEN names (never output these or anything like them):
- "Breakfast", "Breakfast in ${destination}", "Morning Exploration", "Lunch Break"
- "Afternoon Activity", "Evening Discovery", "Dinner", "Sightseeing"
- "City Tour", "Free Time", "Local Cuisine", "Visit the old town", "Explore the city"
Never use a category or a time of day as the activity name. If you include a meal, name the actual restaurant or café and the dish it is famous for.

=== OTHER REQUIREMENTS ===
1. Never repeat a place: every place appears at most ONCE in the entire itinerary. ${duration} days x 5-6 activities must be ${duration * 5}-${duration * 6} distinct named places.
2. Every day needs 5-6 activities in chronological order from morning to evening, including at least one real named restaurant or café.
3. "location" must be a real street address or a specific neighbourhood, e.g. "Carrer de Mallorca, 401" or "El Born". Never just "${destination}".
4. Group places by neighbourhood so each day flows geographically instead of zig-zagging across the city.
5. Include 1-2 genuine local hidden gems per day alongside the well-known sights.
6. "theme" describes the area or idea of the day (e.g. "Gaudí's Modernisme in Eixample"), never "Day 1".
7. "description" is one specific sentence about what you actually do, see or eat there.
8. "tip" is practical and specific: booking window, best time, what to order, which entrance to use.
9. Prices in USD and realistic for the ${budget} budget level.
10. If "${destination}" is a region or country rather than one city, choose the best base towns and name the exact place in each activity.

Trip context:
- Duration: ${duration} days
- Mood / vibe: ${mood}
- Travelling as: ${groupType}
- Budget level: ${budget}
- Interests: ${Array.isArray(interests) && interests.length ? interests.join(', ') : 'general sightseeing'}
${preferences ? `- Saved preferences: ${JSON.stringify(preferences)}` : ''}
${seenBefore.length ? `- The traveller already saw these places on a previous version. Suggest DIFFERENT places instead: ${seenBefore.slice(0, 30).join('; ')}` : ''}

Return ONLY this JSON object (no markdown fences, no commentary):
{
  "destination": "${destination}",
  "summary": "2-3 sentences describing what makes this itinerary special",
  "highlights": ["highlight1", "highlight2", "highlight3"],
  "estimated_budget": {
    "currency": "USD",
    "accommodation_per_night": 0,
    "food_per_day": 0,
    "activities_per_day": 0,
    "transport_per_day": 0,
    "total_estimated": 0
  },
  "packing_tips": ["tip1", "tip2", "tip3"],
  "local_tips": ["tip1", "tip2", "tip3"],
  "days": [
    {
      "day": 1,
      "theme": "Area or idea for the day",
      "activities": [
        {
          "time": "09:00 AM",
          "name": "Real place or venue name",
          "description": "One specific sentence",
          "location": "Street address or neighbourhood",
          "estimated_cost": 0,
          "category": "sightseeing|food|adventure|culture|relaxation|shopping|nightlife",
          "duration": "2 hours",
          "tip": "Practical tip for this specific place"
        }
      ]
    }
  ]
}`;
  }

  async generateItinerary({ destination, duration, mood, groupType, budget, interests, preferences, previousPlan }) {
    const context = { destination, duration, mood, groupType, budget, interests, preferences, previousPlan };
    let prompt = this.buildItineraryPrompt(context);
    let best = null;
    let lastError = null;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const text = await this.generateContent(prompt, {
          json: true,
          temperature: attempt === 1 ? 0.95 : 0.6
        });

        const itinerary = this.normalizeItinerary(this.parseJson(text), destination, duration);
        const issues = this.validateItinerary(itinerary, destination, duration);

        if (!issues.length) {
          return { success: true, aiGenerated: true, data: itinerary };
        }

        console.warn(`Gemini itinerary rejected (attempt ${attempt}):`, issues.slice(0, 4).join(' | '));

        if (!best || issues.length < best.issues) {
          best = { itinerary, issues: issues.length };
        }

        prompt = `${this.buildItineraryPrompt(context)}

=== CORRECTION PASS ===
Your previous answer was rejected by an automated quality check:
${issues.slice(0, 8).map((issue) => `- ${issue}`).join('\n')}

Rewrite the ENTIRE itinerary from scratch and fix every issue. Remember: no generic time slots, no place used twice, a real street address or neighbourhood for every activity.`;
      } catch (error) {
        lastError = error;
        console.error(`Gemini itinerary attempt ${attempt} failed:`, error.message);

        const retryable = /503|429|500|overload|high demand|timeout|timed out|deadline|aborted|not found|no longer available|not supported|invalid model/i.test(error.message || '');
        if (!retryable) break;
      }
    }

    // The model produced a usable plan but with minor flaws (a duplicate, a vague
    // location). A slightly imperfect real itinerary still beats template filler.
    if (best) {
      return {
        success: true,
        aiGenerated: true,
        warning: 'Some activities may be less specific than usual. Regenerate for a fresh plan.',
        data: best.itinerary
      };
    }

    return {
      success: false,
      aiGenerated: false,
      error: lastError ? lastError.message : 'The itinerary could not be generated',
      warning: 'AI generation was unavailable, so this is a starter outline. Regenerate to get real named places.',
      data: this.generateFallbackItinerary(destination, duration, mood, groupType, budget)
    };
  }

  /** Fill in missing fields and coerce cost values like "$25" into numbers. */
  normalizeItinerary(itinerary, destination, duration) {
    const plan = itinerary && typeof itinerary === 'object' ? itinerary : {};
    const rawDays = Array.isArray(plan.days) ? plan.days : [];
    const toNumber = (value) => {
      const parsed = parseFloat(String(value ?? '').replace(/[^0-9.-]/g, ''));
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const text = (value, fallback = '') => (typeof value === 'string' && value.trim() ? value.trim() : fallback);

    const days = rawDays.map((day, index) => ({
      day: Number(day?.day) || index + 1,
      theme: text(day?.theme, `Day ${index + 1} in ${destination}`),
      activities: (Array.isArray(day?.activities) ? day.activities : []).map((activity) => ({
        time: text(activity?.time),
        name: text(activity?.name),
        description: text(activity?.description),
        location: text(activity?.location),
        estimated_cost: toNumber(activity?.estimated_cost),
        category: text(activity?.category, 'sightseeing').toLowerCase(),
        duration: text(activity?.duration),
        tip: text(activity?.tip)
      }))
    }));

    const budget = plan.estimated_budget && typeof plan.estimated_budget === 'object' ? plan.estimated_budget : {};

    return {
      destination: text(plan.destination, destination),
      summary: text(plan.summary),
      highlights: (Array.isArray(plan.highlights) ? plan.highlights : []).map((item) => text(item)).filter(Boolean),
      estimated_budget: {
        currency: text(budget.currency, 'USD'),
        accommodation_per_night: toNumber(budget.accommodation_per_night),
        food_per_day: toNumber(budget.food_per_day),
        activities_per_day: toNumber(budget.activities_per_day),
        transport_per_day: toNumber(budget.transport_per_day),
        total_estimated: toNumber(budget.total_estimated)
      },
      packing_tips: (Array.isArray(plan.packing_tips) ? plan.packing_tips : []).map((item) => text(item)).filter(Boolean),
      local_tips: (Array.isArray(plan.local_tips) ? plan.local_tips : []).map((item) => text(item)).filter(Boolean),
      days: days.length ? days : this.generateFallbackItinerary(destination, duration, 'balanced', 'solo', 'medium').days
    };
  }

  async getSuggestions({ mood, groupType, budget, currentLocation, season }) {
    const prompt = `You are a travel expert. Based on the following preferences, suggest 6 amazing travel destinations:

- Current Mood: ${mood}
- Traveling As: ${groupType}
- Budget: ${budget}
- Current Location/Region: ${currentLocation || 'Global'}
- Season: ${season || 'any'}

Return ONLY valid JSON in this format:
{
  "suggestions": [
    {
      "destination": "City, Country",
      "tagline": "Short catchy tagline",
      "why": "2-3 sentences why this matches their mood",
      "best_for": ["activity1", "activity2"],
      "budget_range": "$X - $Y per day",
      "best_season": "season",
      "rating": 4.5,
      "emoji": "🏖️"
    }
  ]
}`;

    try {
      const text = await this.generateContent(prompt, { json: true, temperature: 0.9 });
      const suggestions = this.parseJson(text);
      return { success: true, data: suggestions };
    } catch (error) {
      console.error('Gemini Suggestions Error:', error.message);
      return {
        success: false,
        error: error.message,
        data: this.getFallbackSuggestions(mood)
      };
    }
  }

  async getActivityRecommendations({ destination, category, timeOfDay }) {
    const prompt = `Suggest 5 real, specific ${category} places in ${destination} to visit in the ${timeOfDay}. Name actual venues (never generic labels like "Sightseeing"). Return ONLY valid JSON:
{
  "activities": [
    {
      "name": "Real venue name",
      "description": "Brief description of what you do there",
      "location": "Street address or neighbourhood",
      "estimated_cost": "$X",
      "duration": "X hours",
      "rating": 4.5,
      "category": "${category}"
    }
  ]
}`;

    try {
      const text = await this.generateContent(prompt, { json: true, temperature: 0.9 });
      return { success: true, data: this.parseJson(text) };
    } catch (error) {
      return { success: false, error: error.message, data: { activities: [] } };
    }
  }

  /**
   * Last-resort outline used only when the model is unreachable. It cannot know
   * real venue names, so each day follows a different theme and slot pattern
   * instead of repeating the same six generic rows.
   */
  generateFallbackItinerary(destination, duration, mood, groupType, budget) {
    const accommodation = budget === 'budget' ? 40 : budget === 'luxury' ? 250 : 100;
    const food = budget === 'budget' ? 20 : budget === 'luxury' ? 100 : 50;
    const activities = budget === 'budget' ? 15 : budget === 'luxury' ? 150 : 50;
    const transport = budget === 'budget' ? 10 : budget === 'luxury' ? 80 : 30;
    const slotCost = budget === 'budget' ? 10 : budget === 'luxury' ? 100 : 40;

    const dayPlans = [
      {
        theme: 'Arrival, orientation & the historic centre',
        activities: [
          ['09:00 AM', 'Settle in and pick up a transit card near your accommodation', 'sightseeing', 'Logistics stop, not a highlight — swap in a real café once you are settled.'],
          ['11:00 AM', 'Orientation walk through the historic centre', 'sightseeing', 'Walk the main square first, then branch into the side streets.'],
          ['01:00 PM', 'Lunch at a family-run restaurant off the main square', 'food', 'Look for a handwritten menu and a queue of locals.'],
          ['03:30 PM', 'Main cathedral or landmark with an audio guide', 'culture', 'Book the earliest slot that fits your day.'],
          ['06:00 PM', 'Sunset viewpoint above the rooftops', 'sightseeing', 'Arrive 30 minutes before sunset for a spot at the rail.'],
          ['08:30 PM', 'Dinner of regional specialities', 'food', 'Ask what was cooked that morning.']
        ]
      },
      {
        theme: 'Museums, markets & local makers',
        activities: [
          ['08:30 AM', 'Breakfast at a bakery near the central market', 'food', 'Go before 9am for the freshest batch.'],
          ['10:00 AM', 'City museum highlighting the region’s history', 'culture', 'Check which galleries are open that day.'],
          ['12:30 PM', 'Grazing lunch through the central market stalls', 'food', 'Bring small notes for the stalls.'],
          ['02:30 PM', 'Craft workshop or gallery run by local makers', 'shopping', 'Small pieces travel better than fragile ones.'],
          ['05:00 PM', 'Park or riverside promenade walk', 'relaxation', 'The golden-hour light is best here.'],
          ['07:30 PM', 'Dinner at a bistro in the design district', 'food', 'Reserve if you are a group of four or more.']
        ]
      },
      {
        theme: 'Waterfront, parks & long lunches',
        activities: [
          ['09:00 AM', 'Coffee at a waterfront café', 'food', 'Sit outside and watch the morning traffic on the water.'],
          ['10:30 AM', 'Botanical garden or city park loop', 'relaxation', 'Bring water — shade is limited at midday.'],
          ['01:00 PM', 'Long lunch of the local seafood or vegetarian classic', 'food', 'Lunch is the main meal here; take your time.'],
          ['04:00 PM', 'Boat trip or ferry crossing for the skyline view', 'adventure', 'Buy tickets at the dock, not from touts.'],
          ['06:30 PM', 'Neighbourhood wander with a stop for ice cream', 'sightseeing', 'Get lost in the side streets just off the promenade.'],
          ['08:00 PM', 'Sunset drinks on a rooftop terrace', 'nightlife', 'Most terraces fill 30 minutes before sunset.']
        ]
      },
      {
        theme: 'Neighbourhoods & street food',
        activities: [
          ['08:00 AM', 'Breakfast of the local morning staple', 'food', 'Eat where the workers eat.'],
          ['09:30 AM', 'Tram or metro ride to a residential neighbourhood', 'sightseeing', 'A day pass usually pays for itself after three rides.'],
          ['11:30 AM', 'Guided walk focused on street art and local stories', 'culture', 'Tip-based walks usually book out a day ahead.'],
          ['01:30 PM', 'Street-food crawl through two or three stalls', 'food', 'Order the smallest portion at each stop.'],
          ['04:00 PM', 'Independent bookshops and vintage stores', 'shopping', 'Many close for a midday break — check hours.'],
          ['07:00 PM', 'Dinner at a no-frills local institution', 'food', 'Cash is often preferred.']
        ]
      },
      {
        theme: 'Hidden corners & lookout points',
        activities: [
          ['08:30 AM', 'Early walk before the crowds arrive', 'sightseeing', 'The first two hours are the quietest.'],
          ['10:30 AM', 'Lesser-known church, cloister or small museum', 'culture', 'Entry is often free before noon.'],
          ['12:30 PM', 'Lunch at a market canteen', 'food', 'Look for the shortest menu — it means fresh cooking.'],
          ['03:00 PM', 'Hike or stair climb to a second viewpoint', 'adventure', 'Wear shoes with grip.'],
          ['05:30 PM', 'Tea or coffee in a courtyard café', 'relaxation', 'Perfect pause before the evening.'],
          ['08:00 PM', 'Dinner at a neighbourhood tavern', 'food', 'Ask the server to pick two dishes for you.']
        ]
      },
      {
        theme: 'Day trip to the outskirts',
        activities: [
          ['07:30 AM', 'Early train or bus to a nearby town', 'adventure', 'Buy a return ticket to skip the evening queue.'],
          ['09:30 AM', 'Walk the old quarter of the neighbouring town', 'sightseeing', 'Start at the tourist office for a free map.'],
          ['12:00 PM', 'Country lunch of regional dishes', 'food', 'Ask for the set menu of the day.'],
          ['02:30 PM', 'Nature trail, vineyard or coastal path', 'relaxation', 'Check the last transport back before you set off.'],
          ['05:00 PM', 'Return and rest at the hotel', 'relaxation', 'Buffer time makes the evening calmer.'],
          ['07:30 PM', 'Casual dinner near your accommodation', 'food', 'Keep it close after a travel day.']
        ]
      },
      {
        theme: 'Cafés, galleries & a slow afternoon',
        activities: [
          ['09:00 AM', 'Slow breakfast at a speciality coffee bar', 'food', 'Try the single-origin pour-over.'],
          ['11:00 AM', 'Contemporary art gallery or photography museum', 'culture', 'Most are closed one weekday — check first.'],
          ['01:00 PM', 'Lunch in a covered market hall', 'food', 'Walk the full hall before choosing.'],
          ['03:00 PM', 'Spa hour, bathhouse or long park sit', 'relaxation', 'Book a slot rather than walking in.'],
          ['05:30 PM', 'Indie shopping street and a pastry stop', 'shopping', 'Best light for photos late afternoon.'],
          ['08:00 PM', 'Dinner with a tasting menu or chef’s special', 'food', 'Reserve ahead for tasting menus.']
        ]
      },
      {
        theme: 'Local life & the night market',
        activities: [
          ['08:30 AM', 'Breakfast at the busiest corner café', 'food', 'Stand at the bar like the regulars.'],
          ['10:00 AM', 'Public library, town hall or architectural landmark', 'culture', 'Many civic buildings are free to enter.'],
          ['12:30 PM', 'Home-style lunch away from the tourist strip', 'food', 'Two streets back from the main drag is enough.'],
          ['03:00 PM', 'Cooking class or food-market tour', 'food', 'Half-day classes usually include the market visit.'],
          ['06:00 PM', 'Sunset stroll along the local promenade', 'sightseeing', 'Join the evening passeggiata.'],
          ['08:30 PM', 'Night market or street-food lane dinner', 'food', 'Bring cash and go hungry.']
        ]
      }
    ];

    const days = Array.from({ length: duration }, (_, index) => {
      const plan = dayPlans[index % dayPlans.length];
      return {
        day: index + 1,
        theme: plan.theme,
        activities: plan.activities.map(([time, name, category, tip]) => ({
          time,
          name,
          description: `A flexible ${category} stop in ${destination} — confirm opening hours and swap for a spot you like better.`,
          location: `${destination} — pick a well-reviewed venue nearby`,
          estimated_cost: slotCost,
          category,
          duration: '1.5 hours',
          tip
        }))
      };
    });

    return {
      destination,
      summary: `A flexible ${duration}-day outline for ${destination}, built for ${groupType} travellers in a ${mood} mood. Add specific place names once you have picked your favourites.`,
      highlights: [`${duration} days of flexible ideas`, 'Local food stops', 'Room to follow recommendations on the ground'],
      estimated_budget: {
        currency: 'USD',
        accommodation_per_night: accommodation,
        food_per_day: food,
        activities_per_day: activities,
        transport_per_day: transport,
        total_estimated: (accommodation + food + activities + transport) * duration
      },
      packing_tips: ['Comfortable walking shoes', 'Weather-appropriate clothing', 'Travel documents and a portable charger'],
      local_tips: ['Try the set lunch menu — it is usually the best value', 'Learn two or three phrases in the local language', 'Use public transport or walk; taxis add up fast'],
      ai_generated: false,
      days
    };
  }

  getFallbackSuggestions(mood) {
    const suggestions = {
      adventurous: [
        { destination: 'Queenstown, New Zealand', tagline: 'Adventure Capital of the World', why: 'Perfect for thrill-seekers with bungee jumping, skydiving, and jet boating.', best_for: ['extreme sports', 'hiking'], budget_range: '$80-150/day', best_season: 'Summer', rating: 4.8, emoji: '🏔️' },
        { destination: 'Costa Rica', tagline: 'Pura Vida Adventure', why: 'Zip-lining through rainforests, volcano hikes, and surfing on both coasts.', best_for: ['nature', 'water sports'], budget_range: '$50-120/day', best_season: 'Dec-Apr', rating: 4.7, emoji: '🌿' },
        { destination: 'Patagonia, Chile', tagline: 'The End of the World', why: 'Glacier treks, granite peaks, and some of the wildest trails on the planet.', best_for: ['trekking', 'wildlife'], budget_range: '$70-140/day', best_season: 'Nov-Mar', rating: 4.9, emoji: '🏔️' },
        { destination: 'Reykjavik, Iceland', tagline: 'Fire and Ice', why: 'Glacier hikes, volcano craters, hot springs, and the northern lights.', best_for: ['nature', 'road trips'], budget_range: '$110-200/day', best_season: 'Jun-Aug', rating: 4.8, emoji: '🌋' }
      ],
      relaxing: [
        { destination: 'Bali, Indonesia', tagline: 'Island of the Gods', why: 'Serene temples, spa retreats, and beautiful rice terraces.', best_for: ['wellness', 'temples'], budget_range: '$40-100/day', best_season: 'Apr-Oct', rating: 4.9, emoji: '🏝️' },
        { destination: 'Santorini, Greece', tagline: 'Sunset Paradise', why: 'Iconic blue domes, caldera views, and Mediterranean relaxation.', best_for: ['sunsets', 'cuisine'], budget_range: '$80-200/day', best_season: 'May-Sep', rating: 4.8, emoji: '🌅' },
        { destination: 'Maldives', tagline: 'Barefoot Luxury', why: 'Overwater villas, glass-clear lagoons, and nothing on the agenda.', best_for: ['beaches', 'snorkeling'], budget_range: '$150-400/day', best_season: 'Nov-Apr', rating: 4.9, emoji: '🐠' },
        { destination: 'Tuscany, Italy', tagline: 'Slow Living', why: 'Rolling vineyards, hilltop villages, and long lunches under the sun.', best_for: ['wine', 'countryside'], budget_range: '$90-180/day', best_season: 'Apr-Jun', rating: 4.8, emoji: '🍷' }
      ],
      cultural: [
        { destination: 'Kyoto, Japan', tagline: 'Ancient Meets Modern', why: 'Centuries-old temples, geisha culture, and amazing cuisine.', best_for: ['temples', 'history'], budget_range: '$70-150/day', best_season: 'Mar-May', rating: 4.9, emoji: '⛩️' },
        { destination: 'Rome, Italy', tagline: 'Eternal City', why: 'Rich history from Colosseum to Vatican, incredible food scene.', best_for: ['history', 'food'], budget_range: '$60-140/day', best_season: 'Apr-Jun', rating: 4.8, emoji: '🏛️' },
        { destination: 'Marrakech, Morocco', tagline: 'Into the Souks', why: 'Maze-like medinas, ornate palaces, and rooftop mint tea at sunset.', best_for: ['markets', 'architecture'], budget_range: '$40-110/day', best_season: 'Mar-May', rating: 4.7, emoji: '🕌' },
        { destination: 'Istanbul, Turkey', tagline: 'Bridge of Two Continents', why: 'Byzantine mosaics, Ottoman bazaars, and ferries across the Bosphorus.', best_for: ['history', 'food'], budget_range: '$50-120/day', best_season: 'Apr-Jun', rating: 4.8, emoji: '🕌' }
      ],
      romantic: [
        { destination: 'Paris, France', tagline: 'The Classic', why: 'Candlelit bistros, riverside walks, and museums you can wander for hours.', best_for: ['romance', 'art'], budget_range: '$100-220/day', best_season: 'Apr-Jun', rating: 4.8, emoji: '🗼' },
        { destination: 'Santorini, Greece', tagline: 'Caldera Sunsets', why: 'Whitewashed villages and the most famous sunset in the Aegean.', best_for: ['sunsets', 'wine'], budget_range: '$90-220/day', best_season: 'May-Sep', rating: 4.9, emoji: '🌅' },
        { destination: 'Ubud, Bali', tagline: 'Jungle Hideaway', why: 'Private villas, rice-terrace walks, and spa evenings for two.', best_for: ['wellness', 'nature'], budget_range: '$50-140/day', best_season: 'Apr-Oct', rating: 4.8, emoji: '🌿' },
        { destination: 'Venice, Italy', tagline: 'Car-Free Romance', why: 'Quiet canals at dawn, tiny wine bars, and no traffic noise at all.', best_for: ['canals', 'cuisine'], budget_range: '$90-200/day', best_season: 'Sep-Nov', rating: 4.7, emoji: '🛶' }
      ],
      foodie: [
        { destination: 'Bologna, Italy', tagline: 'La Grassa', why: 'The food capital of Italy — fresh pasta, aged cheese, and local wines.', best_for: ['pasta', 'markets'], budget_range: '$70-150/day', best_season: 'Apr-Jun', rating: 4.8, emoji: '🍝' },
        { destination: 'Tokyo, Japan', tagline: 'A City That Eats Well', why: 'From Michelin counters to 6-seat ramen bars, every meal is a lesson.', best_for: ['sushi', 'ramen'], budget_range: '$80-220/day', best_season: 'Mar-May', rating: 4.9, emoji: '🍜' },
        { destination: 'Mexico City, Mexico', tagline: 'Tacos and Mezcal', why: 'Street-food culture, mercado tours, and a serious coffee scene.', best_for: ['street food', 'cocktails'], budget_range: '$40-110/day', best_season: 'Oct-Apr', rating: 4.8, emoji: '🌮' },
        { destination: 'Lyon, France', tagline: 'Gastronomic Capital', why: 'Bouchon bistros, covered markets, and the birthplace of nouvelle cuisine.', best_for: ['fine dining', 'wine'], budget_range: '$90-180/day', best_season: 'May-Sep', rating: 4.7, emoji: '🥐' }
      ],
      party: [
        { destination: 'Berlin, Germany', tagline: 'Anything Goes', why: 'Legendary clubs, all-night lineups, and a creative scene that never stops.', best_for: ['nightlife', 'music'], budget_range: '$60-130/day', best_season: 'Jun-Aug', rating: 4.7, emoji: '🎧' },
        { destination: 'Barcelona, Spain', tagline: 'Beach by Day, Clubs by Night', why: 'Tapas crawls that roll into sunrise sets by the sea.', best_for: ['nightlife', 'beaches'], budget_range: '$60-140/day', best_season: 'May-Sep', rating: 4.8, emoji: '💃' },
        { destination: 'Bangkok, Thailand', tagline: 'Rooftops and Street Food', why: 'Sky bars, night markets, and a party that fits every budget.', best_for: ['street food', 'nightlife'], budget_range: '$30-90/day', best_season: 'Nov-Feb', rating: 4.8, emoji: '🍻' },
        { destination: 'Medellín, Colombia', tagline: 'Eternal Spring', why: 'Perfect weather, salsa bars, and a friendly backpacker scene.', best_for: ['nightlife', 'coffee'], budget_range: '$35-90/day', best_season: 'Dec-Mar', rating: 4.7, emoji: '🎉' }
      ]
    };

    return { suggestions: suggestions[mood] || suggestions.adventurous };
  }
}

module.exports = new GeminiService();
