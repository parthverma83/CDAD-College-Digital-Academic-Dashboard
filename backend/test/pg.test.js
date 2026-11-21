/* Runs both API suites against an in-memory Postgres (PGlite) instead of SQLite —
   the same engine family production uses on Supabase. Run: npm run test:pg */
process.env.TEST_DB = 'pglite';
require('./api.test.js');
require('./routes.test.js');
