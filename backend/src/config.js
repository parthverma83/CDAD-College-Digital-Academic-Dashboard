/* ============================================================
   CDAD backend :: config.js
   The one place that knows where things live and loads settings.
   Required (first) by anything that reads process.env or touches disk.

     backend/.env      optional settings file (see ../../.env.example)
     backend/data/     SQLite database + locally stored uploads (git-ignored)
     frontend/         the ONLY folder ever served to browsers

   Real environment variables (Docker, hosting panels) always win over .env.
   ============================================================ */
const path = require('node:path');

const BACKEND_ROOT = path.join(__dirname, '..');

// Settings from backend/.env (Node 20.12+); a missing file is fine.
try { process.loadEnvFile(path.join(BACKEND_ROOT, '.env')); } catch { /* no .env file */ }

module.exports = {
  BACKEND_ROOT,
  // Static site. Deliberately not the project root: the database, source code and docs must never be downloadable.
  FRONTEND_DIR: process.env.CDAD_FRONTEND_DIR || path.join(BACKEND_ROOT, '..', 'frontend'),
  // SQLite file + uploads. The Docker image points this at /app/server/data so existing volumes keep working.
  // On Vercel only /tmp is writable; uploads pass through it on their way to Supabase Storage.
  DATA_DIR: process.env.CDAD_DATA_DIR || (process.env.VERCEL ? '/tmp/cdad-data' : path.join(BACKEND_ROOT, 'data')),
  PORT: process.env.PORT || 3000
};
