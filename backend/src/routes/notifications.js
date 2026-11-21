/* ============================================================
   CDAD backend :: routes/notifications.js
   Ports js/common.js's notificationsFor + js/notifications.js's
   thin CRUD. GET is scoped server-side to the caller's own session
   (students no longer need to filter the full collection client-side).

   Note: the original frontend's notificationsFor() only matched
   'all-students' or an exact student displayId — group-targeted
   notifications (e.g. "Presentation Scheduled" sent to a group) were
   silently never shown to any student. Since the normalized schema
   already tracks recipient_group_id as a real column, this scoping
   also matches group-targeted notifications for the caller's group.
   ============================================================ */
const express = require('express');
const { db, logActivity } = require('../db');
const { mapAll, serializeNotification } = require('../lib/serializers');
const { requireRole } = require('../lib/sessions');
const { createNotification } = require('../lib/notify');

const router = express.Router();

const getRow = (id) => db.prepare('SELECT * FROM notifications WHERE id = ?').get(id);

async function notificationsForUser(user) {
  if (user.type === 'student') {
    const student = await db.prepare('SELECT group_id FROM students WHERE id = ?').get(user.id);
    return db.prepare(`
      SELECT * FROM notifications WHERE recipient_kind = 'all-students'
        OR (recipient_kind = 'student' AND recipient_student_id = ?)
        OR (recipient_kind = 'group' AND recipient_group_id = ?)
      ORDER BY date DESC, id DESC
    `).all(user.id, student ? student.group_id : null);
  }
  if (user.type === 'admin') {
    return db.prepare("SELECT * FROM notifications WHERE recipient_kind = 'all-faculty' ORDER BY date DESC, id DESC").all();
  }
  return db.prepare(`
    SELECT * FROM notifications WHERE recipient_kind = 'all-faculty'
      OR (recipient_kind = 'faculty' AND recipient_faculty_id = ?)
    ORDER BY date DESC, id DESC
  `).all(user.id);
}

router.get('/', requireRole(), async (req, res) => {
  res.json(await mapAll(await notificationsForUser(req.user), serializeNotification));
});

router.get('/unread-count', requireRole(), async (req, res) => {
  res.json({ count: (await notificationsForUser(req.user)).filter((n) => !n.read).length });
});

/** Faculty admin oversight: every notification ever created, not just ones addressed to faculty. */
router.get('/all', requireRole('faculty'), async (req, res) => {
  const rows = await db.prepare('SELECT * FROM notifications ORDER BY date DESC, id DESC').all();
  res.json(await mapAll(rows, serializeNotification));
});

router.post('/', requireRole('faculty'), async (req, res) => {
  const d = req.body || {};
  await createNotification({ title: d.title, message: d.message, type: d.type, recipient: d.recipient });
  await logActivity(`Notification "${d.title}" sent to ${d.recipient}`);
  res.status(201).json({ ok: true });
});

router.put('/:id/read', requireRole(), async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const read = (req.body || {}).read !== false;
  await db.prepare('UPDATE notifications SET read = ? WHERE id = ?').run(read ? 1 : 0, row.id);
  res.json(await serializeNotification(await getRow(row.id)));
});

router.put('/:id', requireRole('faculty'), async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const d = req.body || {};
  await db.prepare('UPDATE notifications SET title=?, message=?, type=? WHERE id=?')
    .run(d.title ?? row.title, d.message ?? row.message, d.type ?? row.type, row.id);
  res.json(await serializeNotification(await getRow(row.id)));
});

router.delete('/:id', requireRole('faculty'), async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  await db.prepare('DELETE FROM notifications WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

module.exports = router;
