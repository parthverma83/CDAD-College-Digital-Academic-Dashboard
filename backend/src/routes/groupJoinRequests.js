/* ============================================================
   CDAD backend :: routes/groupJoinRequests.js
   Ports groups.js's join-by-ID flow (findLeaderAndGroupById,
   sendGroupJoinRequest, respondToGroupJoinRequest).
   ============================================================ */
const express = require('express');
const { db, logActivity } = require('../db');
const { mapAll, serializeGroupJoinRequest } = require('../lib/serializers');
const { requireRole } = require('../lib/sessions');
const { createNotification } = require('../lib/notify');
const { addMember } = require('../lib/groupOps');

const router = express.Router();

router.get('/', requireRole(), async (req, res) => {
  res.json(await mapAll(await db.prepare('SELECT * FROM group_join_requests ORDER BY id').all(), serializeGroupJoinRequest));
});

router.get('/lookup', requireRole('student'), async (req, res) => {
  const targetId = String(req.query.targetId || '').trim().toLowerCase();
  const leader = await db.prepare('SELECT * FROM students WHERE LOWER(display_id) = ?').get(targetId);
  if (!leader) return res.json({ ok: false, error: 'No student found with that ID.' });
  const group = await db.prepare('SELECT * FROM student_groups WHERE team_leader_id = ?').get(leader.id);
  if (!group) return res.json({ ok: false, error: `${leader.name} is not currently leading a group.` });
  res.json({ ok: true, leaderName: leader.name, leaderDisplayId: leader.display_id, groupName: group.name, groupDisplayId: group.display_id });
});

router.post('/', requireRole('student'), async (req, res) => {
  const { targetLeaderId, message } = req.body || {};
  const fromStudent = await db.prepare('SELECT * FROM students WHERE id = ?').get(req.user.id);
  if (fromStudent.group_id) return res.json({ ok: false, error: 'You are already in a group.' });

  const idLower = String(targetLeaderId || '').trim().toLowerCase();
  const leader = await db.prepare('SELECT * FROM students WHERE LOWER(display_id) = ?').get(idLower);
  if (!leader) return res.json({ ok: false, error: 'No student found with that ID.' });
  const group = await db.prepare('SELECT * FROM student_groups WHERE team_leader_id = ?').get(leader.id);
  if (!group) return res.json({ ok: false, error: `${leader.name} is not currently leading a group.` });
  if (leader.id === req.user.id) return res.json({ ok: false, error: "You can't send a request to yourself." });

  const duplicate = await db.prepare(`
    SELECT * FROM group_join_requests WHERE from_student_id = ? AND group_id = ? AND status = 'Pending'
  `).get(req.user.id, group.id);
  if (duplicate) return res.json({ ok: false, error: 'You already have a pending request for this group.' });

  const info = await db.prepare(`
    INSERT INTO group_join_requests (from_student_id, to_student_id, group_id, message, date, status)
    VALUES (?, ?, ?, ?, ?, 'Pending')
  `).run(req.user.id, leader.id, group.id, message || '', new Date().toISOString());

  await createNotification({
    title: 'New Group Join Request',
    message: `${req.user.displayId} requested to join your group ${group.display_id} (${group.name}).`,
    type: 'request', recipient: leader.display_id
  });
  await logActivity(`${req.user.displayId} requested to join group ${group.display_id} (leader ${leader.display_id})`);
  res.status(201).json({
    ok: true,
    request: await serializeGroupJoinRequest(await db.prepare('SELECT * FROM group_join_requests WHERE id = ?').get(info.lastInsertRowid)),
    leaderName: leader.name, groupName: group.name
  });
});

router.put('/:id/respond', requireRole('student'), async (req, res) => {
  const row = await db.prepare('SELECT * FROM group_join_requests WHERE id = ?').get(req.params.id);
  if (!row) return res.json({ ok: false, error: 'Request not found.' });
  const accept = !!(req.body || {}).accept;
  const status = accept ? 'Accepted' : 'Rejected';
  await db.prepare('UPDATE group_join_requests SET status = ? WHERE id = ?').run(status, row.id);

  if (accept) {
    const fromStudent = await db.prepare('SELECT * FROM students WHERE id = ?').get(row.from_student_id);
    if (!fromStudent || fromStudent.group_id) {
      await db.prepare("UPDATE group_join_requests SET status = 'Rejected' WHERE id = ?").run(row.id);
      return res.json({ ok: false, error: 'That student already joined another group.' });
    }
    await addMember(row.group_id, row.from_student_id);
  }

  const group = await db.prepare('SELECT * FROM student_groups WHERE id = ?').get(row.group_id);
  const fromDisplayId = (await db.prepare('SELECT display_id FROM students WHERE id = ?').get(row.from_student_id)).display_id;
  await createNotification({
    title: `Group Join Request ${status}`,
    message: accept ? `You've been added to group ${group.display_id}.` : `Your request to join group ${group.display_id} was rejected.`,
    type: 'request', recipient: fromDisplayId
  });
  await logActivity(`Group join request from ${fromDisplayId} for group ${group.display_id} ${status.toLowerCase()}`);
  res.json({ ok: true });
});

module.exports = router;
