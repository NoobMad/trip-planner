const { Pool } = require('pg');

// Production backend (Vercel + Neon, or any Postgres).
// Vercel's filesystem is read-only and ephemeral, so state lives here instead.
const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is required for the Postgres backend');
}

const isLocal = /(^|@)(localhost|127\.0\.0\.1)[:/]/.test(connectionString);
const wantsSsl = !isLocal && !/sslmode=disable/.test(connectionString);

// `sslmode` in the URL makes pg print a deprecation warning; the `ssl` option below
// controls TLS explicitly instead.
function withoutSslMode(connection) {
  try {
    const url = new URL(connection);
    url.searchParams.delete('sslmode');
    return url.toString();
  } catch (_) {
    return connection;
  }
}

const pool = new Pool({
  connectionString: withoutSslMode(connectionString),
  ssl: wantsSsl ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PGPOOL_MAX) || 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000
});

pool.on('error', (error) => {
  console.error('Postgres pool error:', error.message);
});

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    google_id TEXT UNIQUE,
    email TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    avatar_url TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_preferences (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    preferred_climate TEXT DEFAULT 'any',
    budget_range TEXT DEFAULT 'medium',
    travel_style TEXT DEFAULT 'balanced',
    dietary_restrictions TEXT DEFAULT '',
    accessibility_needs TEXT DEFAULT '',
    favorite_activities TEXT DEFAULT '[]',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS trips (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS trip_activities (
    id SERIAL PRIMARY KEY,
    trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    day_number INTEGER NOT NULL,
    time_slot TEXT NOT NULL,
    activity_name TEXT NOT NULL,
    description TEXT DEFAULT '',
    location TEXT DEFAULT '',
    estimated_cost DOUBLE PRECISION DEFAULT 0,
    category TEXT DEFAULT 'general',
    is_completed INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS saved_places (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    place_name TEXT NOT NULL,
    country TEXT DEFAULT '',
    description TEXT DEFAULT '',
    category TEXT DEFAULT 'general',
    rating DOUBLE PRECISION DEFAULT 0,
    saved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS "session" (
    "sid" TEXT NOT NULL PRIMARY KEY,
    "sess" JSON NOT NULL,
    "expire" TIMESTAMP(6) NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_trips_user ON trips(user_id);
  CREATE INDEX IF NOT EXISTS idx_activities_trip ON trip_activities(trip_id);
  CREATE INDEX IF NOT EXISTS idx_saved_places_user ON saved_places(user_id);
  CREATE INDEX IF NOT EXISTS idx_session_expire ON "session" ("expire");
`;

// SQLite style `?` placeholders keep the route code identical for both backends.
function toPostgres(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

let schemaReady = null;

function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(SCHEMA).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

async function query(sql, params = [], client = pool) {
  await ensureSchema();
  return client.query(toPostgres(sql), params);
}

async function get(sql, params = [], client = pool) {
  const { rows } = await query(sql, params, client);
  return rows[0];
}

async function all(sql, params = [], client = pool) {
  const { rows } = await query(sql, params, client);
  return rows;
}

async function run(sql, params = [], client = pool) {
  const result = await query(sql, params, client);
  return { changes: result.rowCount, id: result.rows[0] ? result.rows[0].id : undefined };
}

async function exec(sql) {
  await ensureSchema();
  await pool.query(sql);
}

async function transaction(fn) {
  await ensureSchema();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const tx = {
      get: (sql, params) => get(sql, params, client),
      all: (sql, params) => all(sql, params, client),
      run: (sql, params) => run(sql, params, client)
    };
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  kind: 'postgres',
  pool,
  get,
  all,
  run,
  exec,
  transaction,
  ensureSchema,
  close: () => pool.end()
};
