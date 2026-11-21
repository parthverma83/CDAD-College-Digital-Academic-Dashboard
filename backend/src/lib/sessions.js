/* ============================================================
   CDAD backend :: sessions.js
   Sessions live in the database (sessions table), so they survive
   server restarts and work on serverless hosts (Vercel), where every
   request may run in a fresh process.
   ============================================================ */
const crypto = require('node:crypto');
const { db } = require('../db');

const COOKIE_NAME = 'cdad_sid';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // a session older than 30 days must log in again

async function createSession(user) {
  const sid = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  await db.prepare('INSERT INTO sessions (sid, data, created_at) VALUES (?, ?, ?)').run(sid, JSON.stringify(user), now);
  // Opportunistic cleanup of expired sessions.
  await db.prepare('DELETE FROM sessions WHERE created_at < ?').run(now - MAX_AGE_MS);
  return sid;
}

async function getSession(sid) {
  if (!sid || typeof sid !== 'string') return null;
  const row = await db.prepare('SELECT data, created_at FROM sessions WHERE sid = ?').get(sid);
  if (!row || Number(row.created_at) < Date.now() - MAX_AGE_MS) return null;
  try { return JSON.parse(row.data); } catch { return null; }
}

async function destroySession(sid) {
  if (sid) await db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
}

/** Express middleware factory. requireRole() (no arg) = any authenticated user. */
function requireRole(role) {
  return async (req, res, next) => {
    const session = await getSession(req.cookies[COOKIE_NAME]);
    // Admins are a superset of faculty: they pass every requireRole('faculty') check.
    const allowed = !!session && (!role || session.type === role || (role === 'faculty' && session.type === 'admin'));
    if (!allowed) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.user = session;
    next();
  };
}

module.exports = { COOKIE_NAME, MAX_AGE_MS, createSession, getSession, destroySession, requireRole };
