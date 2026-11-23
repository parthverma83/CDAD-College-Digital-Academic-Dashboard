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

/* Tasks that can be required before marks are released (see /release-completed). */
const COMPLETION_TASKS = {
  TA1: 'TA1', TA2: 'TA2', EndSem: 'End Sem', projectSubmitted: 'Project submission', projectApproved: 'Project approval',
  ca: 'All four CA marks', finals: 'Finals marks'
};

/** Who has finished the required tasks? Group work (exams, project) counts for every member of the group. */
async function completionReport(required, section) {
  const [students, exams, projects] = await Promise.all([
    db.prepare(`SELECT s.id, s.display_id, s.name, s.section, s.group_id, m.id AS marks_id, m.released,
      m.jury1, m.jury2, m.assess3, m.assign1, m.finals
      FROM students s LEFT JOIN marks m ON m.student_id = s.id ORDER BY s.display_id`).all(),
    db.prepare('SELECT group_id, exam FROM exam_submissions').all(),
    db.prepare('SELECT p.group_id, s.status FROM projects p JOIN submissions s ON s.project_id = p.id WHERE p.group_id IS NOT NULL').all()
  ]);
  const examDone = new Set(exams.map((e) => `${e.group_id}:${e.exam}`));
  const projectStatus = new Map(projects.map((p) => [p.group_id, p.status]));
  const done = (s, task) => {
    if (task === 'ca') return HEADS.every((h) => s[h.key] != null);
    if (task === 'finals') return s.finals != null;
    if (task === 'projectSubmitted') return projectStatus.has(s.group_id);
    if (task === 'projectApproved') return projectStatus.get(s.group_id) === 'Approved';
    return examDone.has(`${s.group_id}:${task}`);
  };
  const complete = []; const incomplete = [];
  for (const s of students) {
    if (section !== undefined && (s.section || '') !== section) continue;
    const missing = required.filter((t) => !done(s, t)).map((t) => COMPLETION_TASKS[t]);
    if (!s.marks_id) missing.push('No marks entered');
    (missing.length ? incomplete : complete).push({ studentId: s.display_id, name: s.name, marksId: s.marks_id, released: !!s.released, missing });
  }
  return { complete, incomplete };
}

/**
 * Release marks only for students who have completed every required task.
 * Body: { require: ['TA1', ...], section? (omit for all), preview? }. preview: true changes nothing.
 * Never hides marks that are already released.
 */
router.post('/release-completed', requireRole('faculty'), async (req, res) => {
  const { require: wanted, section, preview } = req.body || {};
  const required = [...new Set(Array.isArray(wanted) ? wanted : [])];
  if (!required.length) return res.status(400).json({ error: 'Choose at least one task that must be completed.' });
  if (required.some((t) => !Object.hasOwn(COMPLETION_TASKS, t))) return res.status(400).json({ error: 'Unknown task.' });
  if (section !== undefined && typeof section !== 'string') return res.status(400).json({ error: 'Invalid section.' });
  const { complete, incomplete } = await completionReport(required, section);
  const pending = complete.filter((s) => !s.released);
  if (!preview && pending.length) {
    await db.transaction(async () => {
      for (const s of pending) await db.prepare('UPDATE marks SET released = 1 WHERE id = ?').run(s.marksId);
    });
    await logActivity(`Marks released for ${pending.length} student(s) who completed: ${required.map((t) => COMPLETION_TASKS[t]).join(', ')}`);
  }
  const strip = ({ marksId, ...s }) => s;
  res.json({ released: preview ? 0 : pending.length, toRelease: pending.map(strip), alreadyReleased: complete.length - pending.length, incomplete: incomplete.map(strip) });
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
