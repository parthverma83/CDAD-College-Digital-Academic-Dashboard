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

/**
 * Schedule many groups in one go. Body: { groups: [groupDisplayId, ...], date, time ("HH:MM"),
 * venue, status?, notes?, faculty?, gapMinutes? (0 = same slot for everyone), skipExisting? }.
 * Group i gets time + i × gapMinutes. With skipExisting (default true), groups that already have a
 * presentation that isn't cancelled or completed are left alone. Returns { created, skipped }.
 */
router.post('/bulk', requireRole('faculty'), async (req, res) => {
  const d = req.body || {};
  const wanted = [...new Set((Array.isArray(d.groups) ? d.groups : []).map(String))];
  if (!wanted.length) return res.status(400).json({ error: 'Choose at least one group.' });
  if (!d.date || Number.isNaN(new Date(d.date).getTime())) return res.status(400).json({ error: 'A valid date is required.' });
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(d.time || ''));
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return res.status(400).json({ error: 'A valid start time is required.' });
  if (!String(d.venue || '').trim()) return res.status(400).json({ error: 'Venue is required.' });
  const gap = Number(d.gapMinutes || 0);
  if (!Number.isInteger(gap) || gap < 0 || gap > 240) return res.status(400).json({ error: 'Minutes between groups must be a whole number from 0 to 240.' });
  const skipExisting = d.skipExisting !== false;

  // Resolve groups in a stable order (G01, G02, ...), dropping unknown ids.
  const rows = [];
  for (const id of wanted) {
    const g = await db.prepare('SELECT id, display_id FROM student_groups WHERE display_id = ?').get(id);
    if (g) rows.push(g);
  }
  rows.sort((a, b) => a.display_id.localeCompare(b.display_id, undefined, { numeric: true }));
  if (!rows.length) return res.status(400).json({ error: 'None of the chosen groups exist.' });

  const start = Number(m[1]) * 60 + Number(m[2]);
  const skipped = [];
  const todo = [];
  for (const g of rows) {
    const active = skipExisting && await db.prepare(
      "SELECT 1 AS x FROM presentations WHERE group_id = ? AND status NOT IN ('Cancelled', 'Completed')").get(g.id);
    if (active) skipped.push(g.display_id); else todo.push(g);
  }
  const last = start + gap * Math.max(0, todo.length - 1);
  if (last > 23 * 60 + 59) return res.status(400).json({ error: `With ${gap} minutes between ${todo.length} groups the last slot would run past midnight. Use a smaller gap or an earlier start.` });

  const facultyId = d.faculty ? await facultyIdByDisplayId(d.faculty) : null;
  const hhmm = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  const created = [];
  await db.transaction(async () => {
    for (const [i, g] of todo.entries()) {
      const displayId = await nextSequentialId('presentations', 'PRE', 3);
      const proj = await db.prepare('SELECT id FROM projects WHERE group_id = ?').get(g.id);
      const time = hhmm(start + i * gap);
      const info = await db.prepare(`
        INSERT INTO presentations (display_id, group_id, project_id, date, time, venue, faculty_id, status, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(displayId, g.id, proj ? proj.id : null, d.date, time, String(d.venue).trim(), facultyId, d.status || 'Scheduled', d.notes || '');
      created.push({ id: info.lastInsertRowid, group: g.display_id, time });
    }
  });
  for (const c of created) {
    await createNotification({
      title: 'Presentation Scheduled',
      message: `A presentation for ${c.group} has been scheduled on ${formatDate(d.date)} at ${c.time}.`,
      type: 'presentation', recipient: c.group
    });
  }
  await logActivity(`Presentations scheduled for ${created.length} group(s) on ${formatDate(d.date)}${skipped.length ? ` (${skipped.length} skipped)` : ''}`);
  res.status(201).json({ created: created.length, skipped, presentations: created });
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
