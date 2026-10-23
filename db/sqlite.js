const Database = require('better-sqlite3');
const path = require('path');

// Local development backend. The database is a single file next to the project.
const dbPath = process.env.SQLITE_PATH || path.join(__dirname, '..', 'tripplanner.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    google_id TEXT UNIQUE,
    email TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    avatar_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_preferences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    preferred_climate TEXT DEFAULT 'any',
    budget_range TEXT DEFAULT 'medium',
    travel_style TEXT DEFAULT 'balanced',
    dietary_restrictions TEXT DEFAULT '',
    accessibility_needs TEXT DEFAULT '',
    favorite_activities TEXT DEFAULT '[]',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS trips (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    destination TEXT NOT NULL,
    start_date DATE,
    end_date DATE,
    duration_days INTEGER NOT NULL DEFAULT 1,
    mood TEXT DEFAULT 'adventurous',
    group_type TEXT DEFAULT 'solo',
    budget TEXT DEFAULT 'medium',
    interests TEXT DEFAULT '[]',
    itinerary TEXT DEFAULT '{}',
    status TEXT DEFAULT 'planned',
    notes TEXT DEFAULT '',
    cover_image TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS trip_activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id TEXT NOT NULL,
    day_number INTEGER NOT NULL,
    time_slot TEXT NOT NULL,
    activity_name TEXT NOT NULL,
    description TEXT DEFAULT '',
    location TEXT DEFAULT '',
    estimated_cost REAL DEFAULT 0,
    category TEXT DEFAULT 'general',
    is_completed INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS saved_places (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    place_name TEXT NOT NULL,
    country TEXT DEFAULT '',
    description TEXT DEFAULT '',
    category TEXT DEFAULT 'general',
    rating REAL DEFAULT 0,
    saved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_trips_user ON trips(user_id);
  CREATE INDEX IF NOT EXISTS idx_activities_trip ON trip_activities(trip_id);
  CREATE INDEX IF NOT EXISTS idx_saved_places_user ON saved_places(user_id);
`);

async function get(sql, params = []) {
  return db.prepare(sql).get(...params);
}

async function all(sql, params = []) {
  return db.prepare(sql).all(...params);
}

async function run(sql, params = []) {
  const statement = db.prepare(sql);

  // `RETURNING id` is used for inserts so both backends can report the new id.
  if (/\breturning\b/i.test(sql)) {
    const row = statement.get(...params);
    return { changes: row ? 1 : 0, id: row ? row.id : undefined };
  }

  const result = statement.run(...params);
  return { changes: result.changes, id: result.lastInsertRowid };
}

async function exec(sql) {
  db.exec(sql);
}

// `fn` receives a query interface bound to the open transaction.
async function transaction(fn) {
  const tx = { get, all, run };
  db.exec('BEGIN');
  try {
    const result = await fn(tx);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = {
  kind: 'sqlite',
  pool: null,
  path: dbPath,
  get,
  all,
  run,
  exec,
  transaction,
  close: () => db.close()
};
