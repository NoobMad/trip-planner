require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);

// Vercel terminates TLS in front of the function.
if (isProduction) app.set('trust proxy', 1);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Sessions. Serverless instances are ephemeral, so Postgres holds the sessions
// in production and the in-memory store is only used for local SQLite runs.
const db = require('./db/database');

function buildSessionStore() {
  if (db.kind !== 'postgres') return undefined; // MemoryStore is fine for local dev

  const PgSession = require('connect-pg-simple')(session);
  return new PgSession({
    pool: db.pool,
    tableName: 'session',
    createTableIfMissing: true,
    pruneSessionInterval: 60 * 15
  });
}

app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret-key',
  resave: false,
  saveUninitialized: false,
  store: buildSessionStore(),
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Passport
const passport = require('./config/passport');
app.use(passport.initialize());
app.use(passport.session());

// Routes
app.use('/auth', require('./routes/auth'));
app.use('/api/trips', require('./routes/trips'));

// Serve main pages
app.get('/', (req, res) => {
  if (req.isAuthenticated()) {
    return res.redirect('/dashboard.html');
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Friendly aliases
app.get('/login', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/dashboard.html');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/dashboard', (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/login.html');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Health probe (useful after a deployment)
app.get('/healthz', async (req, res) => {
  try {
    await db.get('SELECT 1 as ok');
    res.json({ ok: true, storage: db.kind });
  } catch (error) {
    res.status(500).json({ ok: false, storage: db.kind, error: error.message });
  }
});

// API 404
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Page 404
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled Error:', err);
  if (req.path.startsWith('/api')) {
    return res.status(500).json({ error: 'Internal server error' });
  }
  res.status(500).send('Something went wrong.');
});

// Local development: start a server. On Vercel the app is exported instead.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🌍 TripPlannerAI Server running at http://localhost:${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}/dashboard.html`);
    console.log(`🔑 Login: http://localhost:${PORT}/index.html`);
    console.log(`💾 Storage: ${db.kind}\n`);
  });
}

module.exports = app;
