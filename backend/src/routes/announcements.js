/* ============================================================
   CDAD backend :: routes/announcements.js
   Ports js/announcements.js. `author` is the faculty's display
   name (free text, same as the original seed data) — not an ID.
   ============================================================ */
const express = require('express');
const { db, logActivity } = require('../db');
const { serializeAnnouncement } = require('../lib/serializers');
const { requireRole } = require('../lib/sessions');
const { createNotification } = require('../lib/notify');

const router = express.Router();

const getRow = (id) => db.prepare('SELECT * FROM announcements WHERE id = ?').get(id);

router.get('/', requireRole(), async (req, res) => {
  res.json((await db.prepare('SELECT * FROM announcements ORDER BY date DESC, id DESC').all()).map(serializeAnnouncement));
});

router.post('/', requireRole('faculty'), async (req, res) => {
  const { title, message, author, priority } = req.body || {};
  const date = new Date().toISOString();
  const info = await db.prepare(`
    INSERT INTO announcements (title, message, author, date, priority, status) VALUES (?, ?, ?, ?, ?, 'Active')
  `).run(title, message, author || '', date, priority || 'Normal');
  await createNotification({ title: `Announcement: ${title}`, message, type: 'announcement', recipient: 'all-students' });
  await logActivity(`Announcement "${title}" created`);
  res.status(201).json(serializeAnnouncement(await getRow(info.lastInsertRowid)));
});

router.put('/:id', requireRole('faculty'), async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const d = req.body || {};
  await db.prepare('UPDATE announcements SET title=?, message=?, priority=?, status=? WHERE id=?')
    .run(d.title ?? row.title, d.message ?? row.message, d.priority ?? row.priority, d.status ?? row.status, row.id);
  await logActivity(`Announcement "${row.title}" updated`);
  res.json(serializeAnnouncement(await getRow(row.id)));
});

router.delete('/:id', requireRole('faculty'), async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  await db.prepare('DELETE FROM announcements WHERE id = ?').run(row.id);
  await logActivity(`Announcement "${row.title}" deleted`);
  res.json({ ok: true });
});

module.exports = router;
