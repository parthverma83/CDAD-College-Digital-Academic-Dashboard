/* ============================================================
   CDAD backend :: routes/requests.js
   Ports the "faculty-facing academic requests" half of js/requests.js.
   (Peer connection requests live in routes/peerRequests.js.)
   ============================================================ */
const express = require('express');
const { db, nextSequentialId, logActivity } = require('../db');
const { mapAll, serializeRequest, groupIdByDisplayId, studentDisplayId } = require('../lib/serializers');
const { requireRole } = require('../lib/sessions');
const { createNotification } = require('../lib/notify');

const router = express.Router();

function getRow(id) { return db.prepare('SELECT * FROM requests WHERE id = ?').get(id); }

router.get('/', requireRole(), async (req, res) => {
  res.json(await mapAll(await db.prepare('SELECT * FROM requests ORDER BY id').all(), serializeRequest));
});

router.post('/', requireRole('student'), async (req, res) => {
  const d = req.body || {};
  const displayId = await nextSequentialId('requests', 'REQ', 3);
  const groupId = d.group ? await groupIdByDisplayId(d.group) : null;
  const info = await db.prepare(`
    INSERT INTO requests (display_id, student_id, type, group_id, message, date, status, response)
    VALUES (?, ?, ?, ?, ?, ?, 'Pending', '')
  `).run(displayId, req.user.id, d.type, groupId, d.message || '', new Date().toISOString());
  await createNotification({
    title: 'New Request Submitted',
    message: `${req.user.displayId} submitted a "${d.type}" request.`,
    type: 'request', recipient: 'all-faculty'
  });
  await logActivity(`Request ${displayId} (${d.type}) submitted by ${req.user.displayId}`);
  res.status(201).json(await serializeRequest(await getRow(info.lastInsertRowid)));
});

router.put('/:id', requireRole('faculty'), async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const d = req.body || {};
  const groupId = d.group !== undefined ? (d.group ? await groupIdByDisplayId(d.group) : null) : row.group_id;
  await db.prepare('UPDATE requests SET type=?, group_id=?, message=?, status=?, response=? WHERE id=?')
    .run(d.type ?? row.type, groupId, d.message ?? row.message, d.status ?? row.status, d.response ?? row.response, row.id);
  await logActivity(`Request ${row.display_id} updated`);
  res.json(await serializeRequest(await getRow(row.id)));
});

router.put('/:id/respond', requireRole('faculty'), async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { status, response } = req.body || {};
  await db.prepare('UPDATE requests SET status=?, response=? WHERE id=?').run(status, response || '', row.id);
  await createNotification({
    title: `Request ${status}`,
    message: `Your "${row.type}" request has been ${status.toLowerCase()}.${response ? ' Note: ' + response : ''}`,
    type: 'request', recipient: await studentDisplayId(row.student_id)
  });
  await logActivity(`Request ${row.display_id} ${status.toLowerCase()}`);
  res.json(await serializeRequest(await getRow(row.id)));
});

router.delete('/:id', requireRole('faculty'), async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  await db.prepare('DELETE FROM requests WHERE id=?').run(row.id);
  await logActivity(`Request ${row.display_id} deleted`);
  res.json({ ok: true });
});

module.exports = router;
