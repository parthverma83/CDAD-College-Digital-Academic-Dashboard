/* ============================================================
   CDAD backend :: index.js
   Single Node process serving both the REST API (/api/*) and the
   static frontend (frontend/ only) — same-origin, so the session cookie "just works"
   with no CORS/SameSite complications.
   ============================================================ */
const express = require('express');
const cookieParser = require('cookie-parser');

// Loads backend/.env (real environment variables win) and knows where the frontend and data live.
const { FRONTEND_DIR, PORT } = require('./config');

// SKIP_SEED=true: a real deployment — don't create or wipe demo data. The default admin
// (ADMIN001) still exists, so sign in and add faculty/students from the Admin Panel.
if (process.env.SKIP_SEED === 'true') console.log('SKIP_SEED=true — demo data not seeded.');
else require('./seed').seedIfEmpty();

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY);
app.use(express.json());
app.use(cookieParser());

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

// Only the frontend folder is public. (It used to be the whole project, which exposed the database and the source code.)
app.use(express.static(FRONTEND_DIR));

// Catches multer's file-type/size-limit errors (and anything else thrown in
// a route) and returns clean JSON instead of Express's default HTML page.
app.use((err, req, res, next) => {
  if (!err) return next();
  console.error(err);
  res.status(400).json({ error: err.message || 'Something went wrong.' });
});

app.listen(PORT, () => console.log(`CDAD server listening on http://localhost:${PORT}`));
