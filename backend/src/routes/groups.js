/* ============================================================
   CDAD backend :: routes/groups.js
   Ports js/groups.js. Membership is now derived from
   students.group_id (a real FK) instead of a hand-synced
   members[] array, so there's no syncStudentsGroupField anymore.
   ============================================================ */
const express = require('express');
const { db, nextSequentialId, logActivity } = require('../db');
const { mapAll, serializeGroup, studentIdByDisplayId } = require('../lib/serializers');
const { requireRole } = require('../lib/sessions');
const { addMember, removeMember, deleteGroup } = require('../lib/groupOps');

const router = express.Router();

/** Divisions are short codes like CC1 / CC2 — stored trimmed and upper-cased so filtering is consistent. */
function cleanDivision(v) { return String(v || '').trim().toUpperCase(); }

function getRow(id) { return db.prepare('SELECT * FROM student_groups WHERE id = ?').get(id); }

router.get('/', requireRole(), async (req, res) => {
  res.json(await mapAll(await db.prepare('SELECT * FROM student_groups ORDER BY id').all(), serializeGroup));
});

/** Both faculty and students can create a group (the creating student becomes leader). */
router.post('/', requireRole(), async (req, res) => {
  const f = req.body || {};
  const displayId = await nextSequentialId('student_groups', 'G', 2);
  const leaderId = f.teamLeader ? await studentIdByDisplayId(f.teamLeader) : null;
  const info = await db.prepare(`
    INSERT INTO student_groups (display_id, name, team_leader_id, status, division) VALUES (?, ?, ?, ?, ?)
  `).run(displayId, f.name, leaderId, f.status || 'Active', cleanDivision(f.division));
  const groupId = info.lastInsertRowid;
  if (leaderId) await db.prepare('UPDATE students SET group_id = ? WHERE id = ?').run(groupId, leaderId);
  for (const memberDisplayId of f.members || []) {
    const sid = await studentIdByDisplayId(memberDisplayId);
    if (sid) await db.prepare('UPDATE students SET group_id = ? WHERE id = ?').run(groupId, sid);
  }
  await logActivity(`Group ${displayId} created`);
  res.status(201).json(await serializeGroup(await getRow(groupId)));
});

router.put('/:id', requireRole(), async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const f = req.body || {};
  const leaderId = f.teamLeader !== undefined ? (f.teamLeader ? await studentIdByDisplayId(f.teamLeader) : null) : row.team_leader_id;
  const division = f.division !== undefined ? cleanDivision(f.division) : (row.division || '');
  await db.prepare('UPDATE student_groups SET name=?, team_leader_id=?, status=?, division=? WHERE id=?')
    .run(f.name !== undefined ? f.name : row.name, leaderId, f.status !== undefined ? f.status : row.status, division, row.id);

  if (f.members !== undefined) {
    const wantIds = new Set((await Promise.all((f.members || []).map(studentIdByDisplayId))).filter(Boolean));
    const current = (await db.prepare('SELECT id FROM students WHERE group_id = ?').all(row.id)).map((r) => r.id);
    for (const sid of current) {
      if (!wantIds.has(sid)) await db.prepare('UPDATE students SET group_id = NULL WHERE id = ?').run(sid);
    }
    for (const sid of wantIds) await db.prepare('UPDATE students SET group_id = ? WHERE id = ?').run(row.id, sid);
  }

  await logActivity(`Group ${row.display_id} updated`);
  res.json(await serializeGroup(await getRow(row.id)));
});

/** "Delete All" — every group, or only one division's when ?division=CC1 (or __NONE__ for groups without one). */
router.delete('/', requireRole('faculty'), async (req, res) => {
  let rows;
  let scope = 'all groups';
  if (req.query.division !== undefined) {
    const d = req.query.division === '__NONE__' ? '' : cleanDivision(req.query.division);
    rows = await db.prepare("SELECT id FROM student_groups WHERE COALESCE(division, '') = ?").all(d);
    scope = d ? `division ${d}` : 'groups without a division';
  } else {
    rows = await db.prepare('SELECT id FROM student_groups').all();
  }
  let deleted = 0;
  await db.transaction(async () => {
    for (const r of rows) { if (await deleteGroup(r.id, { quiet: true })) deleted++; }
  });
  await logActivity(`${deleted} group(s) deleted (${scope})`);
  res.json({ ok: true, deleted });
});

router.delete('/:id', requireRole('faculty'), async (req, res) => {
  const ok = await deleteGroup(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.post('/:id/members', requireRole(), async (req, res) => {
  const group = await getRow(req.params.id);
  const sid = await studentIdByDisplayId((req.body || {}).studentDisplayId);
  if (!group || !sid) return res.status(404).json({ error: 'Not found' });
  await addMember(group.id, sid);
  await logActivity(`${req.body.studentDisplayId} added to group ${group.display_id}`);
  res.json(await serializeGroup(await getRow(group.id)));
});

router.delete('/:id/members/:studentId', requireRole(), async (req, res) => {
  const group = await getRow(req.params.id);
  if (!group) return res.status(404).json({ error: 'Not found' });
  await removeMember(group.id, Number(req.params.studentId));
  await logActivity(`Member removed from group ${group.display_id}`);
  res.json(await serializeGroup(await getRow(group.id)));
});

router.post('/:id/leave', requireRole('student'), async (req, res) => {
  const group = await getRow(req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found.' });
  const memberCount = (await db.prepare('SELECT COUNT(*) AS c FROM students WHERE group_id = ?').get(group.id)).c;
  if (memberCount <= 1) {
    await deleteGroup(group.id);
    await logActivity(`${req.user.displayId} left and disbanded group ${group.display_id} (last member)`);
    return res.json({ ok: true, disbanded: true, groupDisplayId: group.display_id });
  }
  await removeMember(group.id, req.user.id);
  await logActivity(`${req.user.displayId} left group ${group.display_id}`);
  res.json({ ok: true, disbanded: false, groupDisplayId: group.display_id });
});

module.exports = router;
