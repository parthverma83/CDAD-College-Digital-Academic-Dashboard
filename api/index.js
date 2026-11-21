/* Vercel serverless entry point: the whole Express API (backend/src/app.js) runs as one
   function. vercel.json rewrites every /api/* request here; the frontend/ folder is served
   as static files by Vercel's CDN. Settings come from the Vercel project's environment
   variables (DATABASE_URL, SUPABASE_*, SKIP_SEED) — see docs/DEPLOY.md. */
const { app } = require('../backend/src/app');

module.exports = app;
