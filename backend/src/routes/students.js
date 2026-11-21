/* ============================================================
   CDAD backend :: routes/students.js
   Students edit their own name/email/phone/avatar; faculty can
   edit everything (matches the README's stated permission split).
   ============================================================ */
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, nextSequentialId, logActivity } = require('../db');
const { mapAll, serializeStudent, groupIdByDisplayId } = require('../lib/serializers');
const { requireRole } = require('../lib/sessions');

const router = express.Router();

const getRow = (id) => db.prepare('SELECT * FROM students WHERE id = ?').get(id);

router.get('/', requireRole(), async (req, res) => {
  res.json(await mapAll(await db.prepare('SELECT * FROM students ORDER BY id').all(), serializeStudent));
});

router.post('/', requireRole('faculty'), async (req, res) => {
  const f = req.body || {};
  const displayId = (f.displayId || await nextSequentialId('students', 'ST', 3)).trim();
  const passwordHash = bcrypt.hashSync(f.password || 'PASS123', 10);
  const groupId = f.group ? await groupIdByDisplayId(f.group) : null;
  const info = await db.prepare(`
    INSERT INTO students (display_id, name, email, password_hash, phone, course, year, department, group_id, role, status, avatar, section)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(displayId, f.name, f.email || '', passwordHash, f.phone || '', f.course || '', f.year || '',
    f.department || '', groupId, f.role || 'Member', f.status || 'Active', f.avatar || '', (f.section || '').trim());
  await logActivity(`Student ${displayId} added`);
  res.status(201).json(await serializeStudent(await getRow(info.lastInsertRowid)));
});

router.put('/:id', requireRole(), async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (req.user.type === 'student' && req.user.id !== row.id) return res.status(403).json({ error: 'Forbidden' });

  const f = req.body || {};
  const isFaculty = req.user.type === 'faculty' || req.user.type === 'admin';
  const fields = {
    name: f.name !== undefined ? f.name : row.name,
    email: f.email !== undefined ? f.email : row.email,
    phone: f.phone !== undefined ? f.phone : row.phone,
    avatar: f.avatar !== undefined ? f.avatar : row.avatar,
    course: isFaculty && f.course !== undefined ? f.course : row.course,
    year: isFaculty && f.year !== undefined ? f.year : row.year,
    department: isFaculty && f.department !== undefined ? f.department : row.department,
    section: isFaculty && f.section !== undefined ? String(f.section).trim() : row.section,
    role: isFaculty && f.role !== undefined ? f.role : row.role,
    status: isFaculty && f.status !== undefined ? f.status : row.status
  };
  const passwordHash = isFaculty && f.password ? bcrypt.hashSync(f.password, 10) : row.password_hash;

  await db.prepare(`
    UPDATE students SET name=?, email=?, phone=?, avatar=?, course=?, year=?, department=?, section=?, role=?, status=?, password_hash=?
    WHERE id=?
  `).run(fields.name, fields.email, fields.phone, fields.avatar, fields.course, fields.year,
    fields.department, fields.section, fields.role, fields.status, passwordHash, row.id);

  if (isFaculty && f.group !== undefined) {
    const newGroupId = f.group ? await groupIdByDisplayId(f.group) : null;
    await db.prepare('UPDATE students SET group_id = ? WHERE id = ?').run(newGroupId, row.id);
  }

  await logActivity(`Student ${row.display_id} updated`);
  res.json(await serializeStudent(await getRow(row.id)));
});

router.delete('/:id', requireRole('faculty'), async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  // submissions.submitted_by_id has no ON DELETE action, so detach it first or the delete is rejected.
  await db.prepare('UPDATE submissions SET submitted_by_id = NULL WHERE submitted_by_id = ?').run(row.id);
  await db.prepare('DELETE FROM students WHERE id = ?').run(row.id);
  await logActivity(`Student ${row.display_id} deleted`);
  res.json({ ok: true });
});

/** "Delete All" — clears a bad CSV import. Groups' team_leader_id/members fall out automatically. */
router.delete('/', requireRole('faculty'), async (req, res) => {
  await db.transaction(async () => {
    // submissions.submitted_by_id has no ON DELETE action, so detach it first or the delete is rejected.
    await db.prepare('UPDATE submissions SET submitted_by_id = NULL').run();
    await db.prepare('DELETE FROM students').run();
  });
  await logActivity('All students deleted');
  res.json({ ok: true });
});

module.exports = router;
