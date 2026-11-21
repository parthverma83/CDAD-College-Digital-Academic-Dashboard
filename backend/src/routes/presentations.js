/* ============================================================
   CDAD backend :: routes/presentations.js
   Ports js/presentations.js.
   ============================================================ */
const express = require('express');
const { db, nextSequentialId, logActivity } = require('../db');
const { mapAll, serializePresentation, groupIdByDisplayId, groupDisplayId } = require('../lib/serializers');
const { requireRole } = require('../lib/sessions');
const { createNotification, facultyIdByDisplayId } = require('../lib/notify');
const { formatDate } = require('../lib/format');

const router = express.Router();

function getRow(id) { return db.prepare('SELECT * FROM presentations WHERE id = ?').get(id); }

router.get('/', requireRole(), async (req, res) => {
  res.json(await mapAll(await db.prepare('SELECT * FROM presentations ORDER BY id').all(), serializePresentation));
});

router.post('/', requireRole('faculty'), async (req, res) => {
  const d = req.body || {};
  const displayId = await nextSequentialId('presentations', 'PRE', 3);
  const groupId = await groupIdByDisplayId(d.group);
  const explicitProject = d.project ? await db.prepare('SELECT id FROM projects WHERE display_id = ?').get(d.project) : null;
  const groupProject = !explicitProject && groupId ? await db.prepare('SELECT id FROM projects WHERE group_id = ?').get(groupId) : null;
  const projectId = explicitProject ? explicitProject.id : (groupProject ? groupProject.id : null);
  const facultyId = d.faculty ? await facultyIdByDisplayId(d.faculty) : null;

  const info = await db.prepare(`
    INSERT INTO presentations (display_id, group_id, project_id, date, time, venue, faculty_id, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(displayId, groupId, projectId, d.date, d.time, d.venue, facultyId, d.status || 'Scheduled', d.notes || '');

  await createNotification({
    title: 'Presentation Scheduled',
    message: `A presentation for ${d.group} has been scheduled on ${formatDate(d.date)} at ${d.time}.`,
    type: 'presentation', recipient: d.group
  });
  await logActivity(`Presentation ${displayId} scheduled for group ${d.group}`);
  res.status(201).json(await serializePresentation(await getRow(info.lastInsertRowid)));
});

router.put('/:id', requireRole('faculty'), async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const d = req.body || {};
  const groupId = d.group !== undefined ? await groupIdByDisplayId(d.group) : row.group_id;
  const facultyId = d.faculty !== undefined ? (d.faculty ? await facultyIdByDisplayId(d.faculty) : null) : row.faculty_id;
  await db.prepare(`
    UPDATE presentations SET group_id=?, date=?, time=?, venue=?, faculty_id=?, status=?, notes=?
    WHERE id=?
  `).run(groupId, d.date ?? row.date, d.time ?? row.time, d.venue ?? row.venue, facultyId,
    d.status ?? row.status, d.notes ?? row.notes, row.id);
  await logActivity(`Presentation ${row.display_id} updated`);
  res.json(await serializePresentation(await getRow(row.id)));
});

router.put('/:id/reschedule', requireRole('faculty'), async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { date, time } = req.body || {};
  await db.prepare('UPDATE presentations SET date=?, time=?, status=? WHERE id=?').run(date, time, 'Rescheduled', row.id);
  const groupDispId = await groupDisplayId(row.group_id);
  await createNotification({
    title: 'Presentation Rescheduled',
    message: `Presentation for ${groupDispId} moved to ${formatDate(date)} at ${time}.`,
    type: 'presentation', recipient: groupDispId
  });
  await logActivity(`Presentation ${row.display_id} rescheduled`);
  res.json(await serializePresentation(await getRow(row.id)));
});

router.put('/:id/cancel', requireRole('faculty'), async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  await db.prepare('UPDATE presentations SET status=? WHERE id=?').run('Cancelled', row.id);
  await logActivity(`Presentation ${row.display_id} cancelled`);
  res.json(await serializePresentation(await getRow(row.id)));
});

router.put('/:id/complete', requireRole('faculty'), async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  await db.prepare('UPDATE presentations SET status=? WHERE id=?').run('Completed', row.id);
  await logActivity(`Presentation ${row.display_id} marked completed`);
  res.json(await serializePresentation(await getRow(row.id)));
});

router.delete('/:id', requireRole('faculty'), async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  await db.prepare('DELETE FROM presentations WHERE id=?').run(row.id);
  await logActivity(`Presentation ${row.display_id} deleted`);
  res.json({ ok: true });
});

module.exports = router;
