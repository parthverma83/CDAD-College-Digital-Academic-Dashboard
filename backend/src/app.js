/* ============================================================
   CDAD backend :: app.js
   Builds the Express app: the REST API (/api/*) plus the static
   frontend. Used two ways:
     - index.js     -> local / Docker server (app.listen)
     - api/index.js -> Vercel serverless function (exports the app)
   The database is initialised (and demo data seeded, unless
   SKIP_SEED=true) once per process, before the first request.
   ============================================================ */
const express = require('express');
const cookieParser = require('cookie-parser');

// Loads backend/.env (real environment variables win) and knows where the frontend and data live.
const { FRONTEND_DIR } = require('./config');
const { ready } = require('./db');

// SKIP_SEED=true: a real deployment — don't create or wipe demo data. The default admin
// (ADMIN001) still exists, so sign in and add faculty/students from the Admin Panel.
const startup = ready.then(() => {
  if (process.env.SKIP_SEED === 'true') { console.log('SKIP_SEED=true — demo data not seeded.'); return; }
  return require('./seed').seedIfEmpty();
});
// A failed startup is reported on every API request (see below), not as a crash.
startup.catch(() => {});

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY);
else if (process.env.VERCEL) app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// Every API request waits for the database to be ready (instant after the first one).
app.use('/api', (req, res, next) => { startup.then(() => next(), next); });

app.use('/api/auth', require('./routes/auth'));
app.use('/api/students', require('./routes/students'));
app.use('/api/faculty', require('./routes/faculty'));
app.use('/api/groups', require('./routes/groups'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/marks', require('./routes/marks'));
app.use('/api/exam-submissions', require('./routes/examSubmissions'));
app.use('/api/presentations', require('./routes/presentations'));
app.use('/api/requests', require('./routes/requests'));
app.use('/api/group-join-requests', require('./routes/groupJoinRequests'));
app.use('/api/peer-requests', require('./routes/peerRequests'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/announcements', require('./routes/announcements'));
app.use('/api/activity', require('./routes/activity'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Only the frontend folder is public. (On Vercel the frontend is served by its CDN instead.)
app.use(express.static(FRONTEND_DIR));

// Catches multer's file-type/size-limit errors (and anything else thrown in a route,
// including rejected promises) and returns clean JSON instead of Express's default HTML page.
app.use((err, req, res, next) => {
  if (!err) return next();
  // Postgres "invalid input syntax" (e.g. /api/students/abc): the id can't exist.
  if (err.code === '22P02') return res.status(404).json({ error: 'Not found' });
  if (err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error: 'Too many files attached.' });
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Each file can be at most 10 MB.' });
  console.error(err);
  if (res.headersSent) return;
  if (err.status === 503) return res.status(503).json({ error: err.message });
  res.status(err.status && err.status < 500 ? err.status : 400).json({ error: err.message || 'Something went wrong.' });
});

module.exports = { app, startup };
