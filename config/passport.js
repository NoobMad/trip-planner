const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { randomUUID: uuidv4 } = require('crypto');
const db = require('../db/database');

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [id]);
    done(null, user || null);
  } catch (err) {
    done(err, null);
  }
});

const baseUrl = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
const PLACEHOLDER = /(your[_-]?|changeme|change[_-]?me|placeholder|example|client[_-]?id[_-]?here|secret[_-]?here|xxxx)/i;

function googleCallbackUrl() {
  return `${baseUrl}/auth/google/callback`;
}

// Only register the strategy when the credentials look real. Template values in
// .env would otherwise send users to Google with a bogus client_id.
function googleConfigured() {
  const clientID = (process.env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();

  if (!clientID || !clientSecret) return false;
  if (PLACEHOLDER.test(clientID) || PLACEHOLDER.test(clientSecret)) return false;

  return clientID.endsWith('.apps.googleusercontent.com') && clientSecret.startsWith('GOCSPX-');
}

if (googleConfigured()) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID.trim(),
    clientSecret: process.env.GOOGLE_CLIENT_SECRET.trim(),
    callbackURL: googleCallbackUrl()
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      let user = await db.get('SELECT * FROM users WHERE google_id = ?', [profile.id]);

      if (!user) {
        const id = uuidv4();
        const email = profile.emails && profile.emails[0] ? profile.emails[0].value : '';
        const displayName = profile.displayName || 'Traveler';
        const avatar = profile.photos && profile.photos[0] ? profile.photos[0].value : '';

        await db.run(`
          INSERT INTO users (id, google_id, email, display_name, avatar_url)
          VALUES (?, ?, ?, ?, ?)
        `, [id, profile.id, email, displayName, avatar]);

        // Create default preferences
        await db.run(`
          INSERT INTO user_preferences (user_id) VALUES (?)
        `, [id]);

        user = await db.get('SELECT * FROM users WHERE id = ?', [id]);
      } else {
        await db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
      }

      return done(null, user);
    } catch (err) {
      return done(err, null);
    }
  }));

  console.log(`🔐 Google OAuth enabled (callback: ${googleCallbackUrl()})`);
} else {
  console.warn('⚠️  Google OAuth is not configured — add real GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET to .env.');
  console.warn(`    Register this redirect URI: ${googleCallbackUrl()}`);
}

module.exports = passport;
module.exports.googleConfigured = googleConfigured;
module.exports.googleCallbackUrl = googleCallbackUrl;
