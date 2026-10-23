const express = require('express');
const router = express.Router();
const passport = require('passport');
const { googleConfigured, googleCallbackUrl } = require('../config/passport');

// Auth middleware
function isAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

// Which sign-in methods are usable on this server
router.get('/providers', (req, res) => {
  res.json({
    google: googleConfigured(),
    demo: true,
    redirectUri: googleCallbackUrl()
  });
});

// Google OAuth login
router.get('/google', (req, res, next) => {
  if (!googleConfigured()) {
    return res.redirect('/login.html?error=google_not_configured');
  }
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

// Google OAuth callback
router.get('/google/callback',
  (req, res, next) => {
    if (!googleConfigured()) {
      return res.redirect('/login.html?error=google_not_configured');
    }
    next();
  },
  passport.authenticate('google', { failureRedirect: '/login.html?error=google_failed' }),
  (req, res) => {
    res.redirect('/dashboard.html');
  }
);

// Demo login (for development without OAuth)
async function findOrCreateDemoUser() {
  const db = require('../db/database');
  const { randomUUID: uuidv4 } = require('crypto');

  let user = await db.get('SELECT * FROM users WHERE email = ?', ['demo@tripplanner.com']);

  if (!user) {
    const id = uuidv4();
    // ON CONFLICT keeps two simultaneous demo logins from racing each other.
    await db.run(`
      INSERT INTO users (id, google_id, email, display_name, avatar_url)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (email) DO NOTHING
    `, [id, 'demo-user', 'demo@tripplanner.com', 'Demo Traveler', '']);

    await db.run(`
      INSERT INTO user_preferences (user_id)
      SELECT ? WHERE NOT EXISTS (SELECT 1 FROM user_preferences WHERE user_id = ?)
    `, [id, id]);

    user = await db.get('SELECT * FROM users WHERE email = ?', ['demo@tripplanner.com']);
  } else {
    await db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
  }

  // Preferences row may be missing on an older account.
  const prefs = await db.get('SELECT id FROM user_preferences WHERE user_id = ?', [user.id]);
  if (!prefs) {
    await db.run('INSERT INTO user_preferences (user_id) VALUES (?)', [user.id]);
  }

  return user;
}

router.post('/demo-login', async (req, res) => {
  try {
    const user = await findOrCreateDemoUser();
    req.login(user, (err) => {
      if (err) return res.status(500).json({ error: 'Login failed' });
      res.json({ success: true, user: { id: user.id, name: user.display_name, email: user.email, avatar: user.avatar_url } });
    });
  } catch (error) {
    console.error('Demo login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Demo login via a plain link: logs in, then redirects to the dashboard
router.get('/demo-login', async (req, res, next) => {
  try {
    const user = await findOrCreateDemoUser();
    req.login(user, (err) => {
      if (err) return next(err);
      res.redirect('/dashboard.html');
    });
  } catch (error) {
    next(error);
  }
});

// Public auth probe — always 200 so public pages can check silently
router.get('/status', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.json({ authenticated: false, user: null });
  }
  res.json({
    authenticated: true,
    user: {
      id: req.user.id,
      name: req.user.display_name,
      email: req.user.email,
      avatar: req.user.avatar_url
    }
  });
});

// Get current user
router.get('/me', isAuthenticated, async (req, res) => {
  const db = require('../db/database');
  const prefs = await db.get('SELECT * FROM user_preferences WHERE user_id = ?', [req.user.id]);
  res.json({
    user: {
      id: req.user.id,
      name: req.user.display_name,
      email: req.user.email,
      avatar: req.user.avatar_url
    },
    preferences: prefs
  });
});

// Logout
router.get('/logout', (req, res) => {
  req.logout(() => {
    res.redirect('/');
  });
});

module.exports = router;
