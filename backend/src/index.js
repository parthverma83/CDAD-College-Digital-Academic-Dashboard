/* ============================================================
   CDAD backend :: index.js
   Local / Docker entry point: one Node process serving both the REST
   API (/api/*) and the static frontend — same-origin, so the session
   cookie "just works" with no CORS/SameSite complications.
   (On Vercel, api/index.js serves the same app as a serverless function.)
   ============================================================ */
const { PORT } = require('./config');
const { app, startup } = require('./app');
const { db } = require('./db');

startup.then(
  () => app.listen(PORT, () => console.log(`CDAD server listening on http://localhost:${PORT} (database: ${db.kind})`)),
  (err) => { console.error('Startup failed:', err); process.exit(1); }
);
