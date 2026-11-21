/* ============================================================
   CDAD backend :: routes/marks.js
   Continuous Assessment — 50 marks. Four heads, each marked OUT OF 20 and scaled
   down for the total:
     jury1   Jury Assessment-I   (Unit 1&2)   20 -> 16
     jury2   Jury Assessment-II  (Unit 3&4)   20 -> 16
     assess3 Unit 5 - MCQ based  (Unit 5)     20 -> 8
     assign1 Coursera Certification            20 -> 10
   The server stores only the raw marks out of 20 (NULL = not entered yet).
   Scaling, total, percentage and grade are derived client-side (deriveMarkTotals).
   ============================================================ */
const express = require('express');
const { db, logActivity } = require('../db');
const { mapAll, serializeMarks, studentIdByDisplayId } = require('../lib/serializers');
const { requireRole } = require('../lib/sessions');

const router = express.Router();

const HEADS = [
  { key: 'jury1', label: 'Jury Assessment-I' },
  { key: 'jury2', label: 'Jury Assessment-II' },
  { key: 'assess3', label: 'Unit 5 - MCQ based' },
  { key: 'assign1', label: 'Coursera Certification' }
];
const OUT_OF = 20;
// Finals is a separate exam held after the Continuous Assessment, marked directly out of 50 (no scaling).
const FINALS = { key: 'finals', label: 'Finals', outOf: 50 };

const getRow = (id) => db.prepare('SELECT * FROM marks WHERE id = ?').get(id);

/** Reads the marks present in a request body. A number sets the mark, null or '' clears it, a missing key is left alone.
    Returns { values: { key: number|null }, error } — values only holds the keys that were sent. */
function readHeads(body) {
  const values = {};
  for (const { key, label, outOf } of [...HEADS.map((h) => ({ ...h, outOf: OUT_OF })), FINALS]) {
    if (body[key] === undefined) continue;
    if (body[key] === null || body[key] === '') { values[key] = null; continue; }
    const n = Number(body[key]);
    if (!Number.isFinite(n) || n < 0 || n > outOf) return { error: `${label} must be a number between 0 and ${outOf}.` };
    values[key] = n;
  }
  return { values };
}

router.get('/', requireRole(), async (req, res) => {
  // Students only receive marks for themselves and their own group's members.
  if (req.user.type === 'student') {
    const me = await db.prepare('SELECT group_id FROM students WHERE id = ?').get(req.user.id);
    // When group_id is NULL, "s.group_id = NULL" is never true, so only the student's own row matches.
    const rows = await db.prepare(`
      SELECT m.* FROM marks m JOIN students s ON s.id = m.student_id
      WHERE m.released = 1 AND (s.id = ? OR s.group_id = ?)
      ORDER BY m.id
    `).all(req.user.id, me?.group_id ?? null);
    return res.json(await mapAll(rows, serializeMarks));
  }
  res.json(await mapAll(await db.prepare('SELECT * FROM marks ORDER BY id').all(), serializeMarks));
});

router.put('/student/:studentDisplayId', requireRole('faculty'), async (req, res) => {
  const sid = await studentIdByDisplayId(req.params.studentDisplayId);
  if (!sid) return res.status(404).json({ error: 'Student not found' });
  const { values, error } = readHeads(req.body || {});
  if (error) return res.status(400).json({ error });
  const existing = await db.prepare('SELECT * FROM marks WHERE student_id = ?').get(sid);

  if (existing) {
    const next = Object.fromEntries([...HEADS, FINALS].map(({ key }) => [key, key in values ? values[key] : existing[key]]));
    await db.prepare('UPDATE marks SET jury1=?, jury2=?, assess3=?, assign1=?, finals=? WHERE id=?')
      .run(next.jury1, next.jury2, next.assess3, next.assign1, next.finals, existing.id);
    await logActivity(`Marks updated for ${req.params.studentDisplayId}`);
    return res.json(await serializeMarks(await getRow(existing.id)));
  }

  const info = await db.prepare('INSERT INTO marks (student_id, jury1, jury2, assess3, assign1, finals) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sid, values.jury1 ?? null, values.jury2 ?? null, values.assess3 ?? null, values.assign1 ?? null, values.finals ?? null);
  await logActivity(`Marks added for ${req.params.studentDisplayId}`);
  res.status(201).json(await serializeMarks(await getRow(info.lastInsertRowid)));
});

// Apply one set of marks to every member of a group. Only the heads sent (and non-blank) are overwritten.
router.put('/group/:groupDisplayId', requireRole('faculty'), async (req, res) => {
  const group = await db.prepare('SELECT id FROM student_groups WHERE display_id = ?').get(req.params.groupDisplayId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const members = await db.prepare('SELECT id FROM students WHERE group_id = ?').all(group.id);
  if (!members.length) return res.status(400).json({ error: 'Group has no members' });
  const { values, error } = readHeads(req.body || {});
  if (error) return res.status(400).json({ error });
  // For a whole group a blank means "leave each member's mark as it is", never "clear it".
  const v = (k) => (values[k] === undefined ? null : values[k]);
  // The existing value is qualified (marks.x): Postgres rejects an unqualified column here as ambiguous.
  const upsert = db.prepare(`
    INSERT INTO marks (student_id, jury1, jury2, assess3, assign1) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(student_id) DO UPDATE SET
      jury1 = COALESCE(?, marks.jury1), jury2 = COALESCE(?, marks.jury2),
      assess3 = COALESCE(?, marks.assess3), assign1 = COALESCE(?, marks.assign1)
  `);
  await db.transaction(async () => {
    for (const m of members) {
      await upsert.run(m.id, v('jury1'), v('jury2'), v('assess3'), v('assign1'), v('jury1'), v('jury2'), v('assess3'), v('assign1'));
    }
  });
  await logActivity(`Group marks applied to ${req.params.groupDisplayId} (${members.length} members)`);
  res.json({ ok: true, updated: members.length });
});

// Release (or withdraw) marks for every student that has a marks record.
router.post('/release-all', requireRole('faculty'), async (req, res) => {
  const released = req.body?.released === false ? 0 : 1;
  const info = await db.prepare('UPDATE marks SET released = ?').run(released);
  await logActivity(`Marks ${released ? 'released' : 'withdrawn'} for all students (${info.changes})`);
  res.json({ ok: true, released: !!released, updated: Number(info.changes) });
});

router.post('/:id/release', requireRole('faculty'), async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const released = req.body?.released === undefined ? (row.released ? 0 : 1) : (req.body.released ? 1 : 0);
  await db.prepare('UPDATE marks SET released = ? WHERE id = ?').run(released, row.id);
  await logActivity(`Marks ${released ? 'released' : 'withdrawn'} for student id ${row.student_id}`);
  res.json(await serializeMarks(await getRow(row.id)));
});

router.delete('/:id', requireRole('faculty'), async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  await db.prepare('DELETE FROM marks WHERE id = ?').run(row.id);
  await logActivity(`Marks deleted for student id ${row.student_id}`);
  res.json({ ok: true });
});

router.post('/:id/reset', requireRole('faculty'), async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  await db.prepare('UPDATE marks SET jury1=NULL, jury2=NULL, assess3=NULL, assign1=NULL, finals=NULL WHERE id=?').run(row.id);
  await logActivity(`Marks reset for student id ${row.student_id}`);
  res.json(await serializeMarks(await getRow(row.id)));
});

module.exports = router;
