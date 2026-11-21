/* ============================================================
   CDAD backend :: routes/peerRequests.js
   Ports the peer-connection half of js/requests.js. student.connections[]
   is replaced by the student_connections join table.
   ============================================================ */
const express = require('express');
const { db, logActivity } = require('../db');
const { mapAll, serializePeerRequest, studentIdByDisplayId } = require('../lib/serializers');
const { requireRole } = require('../lib/sessions');
const { createNotification } = require('../lib/notify');

const router = express.Router();

const getRow = (id) => db.prepare('SELECT * FROM student_requests WHERE id = ?').get(id);

router.get('/', requireRole(), async (req, res) => {
  res.json(await mapAll(await db.prepare('SELECT * FROM student_requests ORDER BY id').all(), serializePeerRequest));
});

router.post('/', requireRole('student'), async (req, res) => {
  const { to, message } = req.body || {};
  const toId = await studentIdByDisplayId(to);
  if (!toId) return res.json({ ok: false, error: 'Student not found.' });
  if (toId === req.user.id) return res.json({ ok: false, error: "You can't send a request to yourself." });

  const [a, b] = [req.user.id, toId].sort((x, y) => x - y);
  const connected = await db.prepare('SELECT 1 AS x FROM student_connections WHERE student_a_id = ? AND student_b_id = ?').get(a, b);
  if (connected) return res.json({ ok: false, error: 'You are already connected with this student.' });

  const pending = await db.prepare(`
    SELECT 1 AS x FROM student_requests WHERE status = 'Pending'
      AND ((from_student_id = ? AND to_student_id = ?) OR (from_student_id = ? AND to_student_id = ?))
  `).get(req.user.id, toId, toId, req.user.id);
  if (pending) return res.json({ ok: false, error: 'A pending request already exists between you two.' });

  const info = await db.prepare(`
    INSERT INTO student_requests (from_student_id, to_student_id, message, date, status) VALUES (?, ?, ?, ?, 'Pending')
  `).run(req.user.id, toId, message || '', new Date().toISOString());

  await createNotification({
    title: 'New Connection Request',
    message: `${req.user.displayId} sent you a request${message ? ': "' + message + '"' : '.'}`,
    type: 'peer-request', recipient: to
  });
  await logActivity(`${req.user.displayId} sent a connection request to ${to}`);
  res.status(201).json({ ok: true, request: await serializePeerRequest(await getRow(info.lastInsertRowid)) });
});

router.put('/:id/respond', requireRole('student'), async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.json({ ok: false, error: 'Request not found.' });
  const accept = !!(req.body || {}).accept;
  const status = accept ? 'Accepted' : 'Rejected';
  await db.prepare('UPDATE student_requests SET status = ? WHERE id = ?').run(status, row.id);

  if (accept) {
    const [a, b] = [row.from_student_id, row.to_student_id].sort((x, y) => x - y);
    await db.prepare('INSERT INTO student_connections (student_a_id, student_b_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
      .run(a, b, new Date().toISOString());
  }

  const fromDisplayId = (await db.prepare('SELECT display_id FROM students WHERE id = ?').get(row.from_student_id)).display_id;
  const toDisplayId = (await db.prepare('SELECT display_id FROM students WHERE id = ?').get(row.to_student_id)).display_id;
  await createNotification({
    title: `Connection Request ${status}`,
    message: `${toDisplayId} ${status.toLowerCase()} your connection request.`,
    type: 'peer-request', recipient: fromDisplayId
  });
  await logActivity(`Connection request from ${fromDisplayId} to ${toDisplayId} ${status.toLowerCase()}`);
  res.json({ ok: true });
});

router.delete('/connections/:otherId', requireRole('student'), async (req, res) => {
  const otherId = await studentIdByDisplayId(req.params.otherId);
  if (!otherId) return res.status(404).json({ error: 'Not found' });
  const [a, b] = [req.user.id, otherId].sort((x, y) => x - y);
  await db.prepare('DELETE FROM student_connections WHERE student_a_id = ? AND student_b_id = ?').run(a, b);
  await logActivity(`Connection between ${req.user.displayId} and ${req.params.otherId} removed`);
  res.json({ ok: true });
});

router.delete('/:id', requireRole('student'), async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  await db.prepare('DELETE FROM student_requests WHERE id = ?').run(row.id);
  await logActivity(`Connection request ${row.id} removed`);
  res.json({ ok: true });
});

module.exports = router;
