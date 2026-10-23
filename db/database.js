// Storage is picked at runtime:
//   DATABASE_URL / POSTGRES_URL set  -> PostgreSQL (Vercel + Neon)
//   otherwise                        -> local SQLite file
//
// Both backends expose the same async interface: get / all / run / exec / transaction.
const connectionString = (process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim();

const backend = connectionString ? require('./postgres') : require('./sqlite');

module.exports = backend;
