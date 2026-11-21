/* ============================================================
   CDAD backend :: routes/admin.js
   Admin-only management of student and faculty accounts. Admins can
   also use every faculty endpoint (see sessions.requireRole).
   ============================================================ */
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, logActivity } = require('../db');
const { mapAll, serializeStudent, serializeFaculty } = require('../lib/serializers');
const { requireRole } = require('../lib/sessions');

const router = express.Router();
router.use(requireRole('admin'));

const clean = (v) => (v === undefined || v === null ? '' : String(v).trim());
const getStudent = (id) => db.prepare('SELECT * FROM students WHERE id = ?').get(id);
const getFaculty = (id) => db.prepare('SELECT * FROM faculty WHERE id = ?').get(id);

/** An admin changes their own password (the shipped default must be replaced). */
router.put('/me/password', async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const row = await db.prepare('SELECT * FROM admins WHERE id = ?').get(req.user.id);
  if (!row || !bcrypt.compareSync(String(currentPassword || ''), row.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  if (String(newPassword || '').length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  await db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(newPassword), 10), row.id);
  await logActivity(`Admin ${row.display_id} changed their password`);
  res.json({ ok: true });
});

router.get('/overview', async (req, res) => {
  const count = async (t) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).n;
  const [students, faculty, groups, projects, presentations, sections] = await Promise.all([
    count('students'), count('faculty'), count('student_groups'), count('projects'), count('presentations'),
    db.prepare("SELECT COUNT(DISTINCT section) AS n FROM students WHERE section IS NOT NULL AND section != ''").get().then((r) => r.n)
  ]);
  res.json({ students, faculty, groups, projects, presentations, sections });
});

/* ---------------- Students ---------------- */
router.get('/students', async (req, res) => {
  res.json(await mapAll(await db.prepare('SELECT * FROM students ORDER BY display_id').all(), serializeStudent));
});

async function nextStudentId() {
  const n = (await db.prepare('SELECT COUNT(*) AS n FROM students').get()).n + 1;
  let id;
  do { id = `ST${String(n + Math.floor(Math.random() * 1000)).padStart(3, '0')}`; }
  while (await db.prepare('SELECT 1 AS x FROM students WHERE display_id = ?').get(id));
  return id;
}

async function insertStudent(f) {
  const displayId = clean(f.displayId) || await nextStudentId();
  if (!clean(f.name)) throw new Error('Name is required.');
  if (await db.prepare('SELECT 1 AS x FROM students WHERE LOWER(display_id) = LOWER(?)').get(displayId)) {
    const e = new Error(`Student ID ${displayId} already exists.`); e.code = 'DUP'; throw e;
  }
  return (await db.prepare(`
    INSERT INTO students (display_id, name, email, password_hash, phone, course, year, department, section, role, status, avatar)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Member', 'Active', '')
  `).run(displayId, clean(f.name), clean(f.email), bcrypt.hashSync(clean(f.password) || 'PASS123', 10),
    clean(f.phone), clean(f.course), clean(f.year), clean(f.department), clean(f.section))).lastInsertRowid;
}

router.post('/students', async (req, res) => {
  try {
    const id = await insertStudent(req.body || {});
    await logActivity(`Admin ${req.user.displayId} added student ${clean(req.body.displayId) || id}`);
    res.status(201).json(await serializeStudent(await getStudent(id)));
  } catch (e) { res.status(e.code === 'DUP' ? 409 : 400).json({ error: e.message }); }
});

/** Bulk add: body { students: [{displayId, name, email?, phone?, section?, password?}, ...] }.
    Existing IDs are skipped and reported, never overwritten. Validation happens before
    inserting, so one bad row is skipped without aborting the rest. */
router.post('/students/import', async (req, res) => {
  const list = Array.isArray(req.body?.students) ? req.body.students : [];
  let added = 0; const skipped = [];
  try {
    await db.transaction(async () => {
      const seen = new Set();
      for (const f of list) {
        const id = clean(f.displayId);
        if (!clean(f.name)) { skipped.push({ id, reason: 'Name is required.' }); continue; }
        if (id && (seen.has(id.toLowerCase()) ||
            await db.prepare('SELECT 1 AS x FROM students WHERE LOWER(display_id) = LOWER(?)').get(id))) {
          skipped.push({ id, reason: `Student ID ${id} already exists.` }); continue;
        }
        if (id) seen.add(id.toLowerCase());
        await insertStudent(f); added++;
      }
    });
  } catch (e) { return res.status(500).json({ error: e.message }); }
  await logActivity(`Admin ${req.user.displayId} imported ${added} students`);
  res.json({ added, skipped });
});

router.put('/students/:id', async (req, res) => {
  const row = await getStudent(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const f = req.body || {};
  const pick = (k, cur) => (f[k] !== undefined ? clean(f[k]) : cur);
  await db.prepare(`
    UPDATE students SET name=?, email=?, phone=?, course=?, year=?, department=?, section=?, status=?, password_hash=? WHERE id=?
  `).run(pick('name', row.name) || row.name, pick('email', row.email), pick('phone', row.phone), pick('course', row.course),
    pick('year', row.year), pick('department', row.department), pick('section', row.section),
    f.status === 'Inactive' ? 'Inactive' : f.status === 'Active' ? 'Active' : row.status,
    clean(f.password) ? bcrypt.hashSync(clean(f.password), 10) : row.password_hash, row.id);
  await logActivity(`Admin ${req.user.displayId} updated student ${row.display_id}`);
  res.json(await serializeStudent(await getStudent(row.id)));
});

router.delete('/students/:id', async (req, res) => {
  const row = await getStudent(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  await db.prepare('UPDATE submissions SET submitted_by_id = NULL WHERE submitted_by_id = ?').run(row.id);
  await db.prepare('DELETE FROM students WHERE id = ?').run(row.id);
  await logActivity(`Admin ${req.user.displayId} deleted student ${row.display_id}`);
  res.json({ ok: true });
});

/* ---------------- Faculty ---------------- */
router.get('/faculty', async (req, res) => {
  res.json((await db.prepare('SELECT * FROM faculty ORDER BY display_id').all()).map(serializeFaculty));
});

router.post('/faculty', async (req, res) => {
  const f = req.body || {};
  const displayId = clean(f.displayId);
  if (!displayId || !clean(f.name)) return res.status(400).json({ error: 'Faculty ID and name are required.' });
  if (await db.prepare('SELECT 1 AS x FROM faculty WHERE LOWER(display_id) = LOWER(?)').get(displayId)) {
    return res.status(409).json({ error: `Faculty ID ${displayId} already exists.` });
  }
  const info = await db.prepare(`
    INSERT INTO faculty (display_id, name, email, password_hash, phone, department, designation, avatar, session)
    VALUES (?, ?, ?, ?, ?, ?, ?, '', ?)
  `).run(displayId, clean(f.name), clean(f.email), bcrypt.hashSync(clean(f.password) || 'faculty123', 10),
    clean(f.phone), clean(f.department), clean(f.designation), clean(f.session));
  await logActivity(`Admin ${req.user.displayId} added faculty ${displayId}`);
  res.status(201).json(serializeFaculty(await getFaculty(info.lastInsertRowid)));
});

router.put('/faculty/:id', async (req, res) => {
  const row = await getFaculty(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const f = req.body || {};
  const pick = (k, cur) => (f[k] !== undefined ? clean(f[k]) : cur);
  await db.prepare('UPDATE faculty SET name=?, email=?, phone=?, department=?, designation=?, password_hash=? WHERE id=?')
    .run(pick('name', row.name) || row.name, pick('email', row.email), pick('phone', row.phone), pick('department', row.department),
      pick('designation', row.designation), clean(f.password) ? bcrypt.hashSync(clean(f.password), 10) : row.password_hash, row.id);
  await logActivity(`Admin ${req.user.displayId} updated faculty ${row.display_id}`);
  res.json(serializeFaculty(await getFaculty(row.id)));
});

router.delete('/faculty/:id', async (req, res) => {
  const row = await getFaculty(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  await db.prepare('DELETE FROM faculty WHERE id = ?').run(row.id);
  await logActivity(`Admin ${req.user.displayId} deleted faculty ${row.display_id}`);
  res.json({ ok: true });
});

module.exports = router;
