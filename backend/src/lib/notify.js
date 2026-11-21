/* ============================================================
   CDAD backend :: notify.js
   Ports js/common.js's createNotification. recipient is still the
   single polymorphic string the frontend already uses: 'all-students',
   'all-faculty', a student displayId, a faculty displayId, or a
   group displayId — this function figures out which and stores the
   typed columns the notifications table expects.
   ============================================================ */
const { db } = require('../db');
const { studentIdByDisplayId, groupIdByDisplayId } = require('./serializers');

async function facultyIdByDisplayId(displayId) {
  if (displayId === undefined || displayId === null) return null;
  const row = await db.prepare('SELECT id FROM faculty WHERE display_id = ?').get(String(displayId));
  return row ? row.id : null;
}

async function createNotification({ title, message, type, recipient }) {
  let kind = recipient;
  let studentId = null;
  let facultyId = null;
  let groupId = null;

  if (recipient !== 'all-students' && recipient !== 'all-faculty') {
    const [sid, fid, gid] = await Promise.all([
      studentIdByDisplayId(recipient), facultyIdByDisplayId(recipient), groupIdByDisplayId(recipient)
    ]);
    if (sid) { kind = 'student'; studentId = sid; }
    else if (fid) { kind = 'faculty'; facultyId = fid; }
    else if (gid) { kind = 'group'; groupId = gid; }
  }

  await db.prepare(`
    INSERT INTO notifications (title, message, type, recipient_kind, recipient_student_id, recipient_faculty_id, recipient_group_id, date, read)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(title, message, type || 'info', kind, studentId, facultyId, groupId, new Date().toISOString());
}

module.exports = { createNotification, facultyIdByDisplayId };
