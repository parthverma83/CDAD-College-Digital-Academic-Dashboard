/* ============================================================
   CDAD backend :: groupOps.js
   Shared group-membership operations used by both routes/groups.js
   and routes/groupJoinRequests.js (kept out of either to avoid a
   circular require between the two route modules).
   ============================================================ */
const { db, logActivity } = require('../db');
const { deleteUploadedFile } = require('./upload');

function addMember(groupId, studentId) {
  db.prepare('UPDATE students SET group_id = ? WHERE id = ?').run(groupId, studentId);
}

/** Removes a member; if they were the leader, promotes the next remaining member. */
function removeMember(groupId, studentId) {
  const group = db.prepare('SELECT * FROM student_groups WHERE id = ?').get(groupId);
  if (!group) return;
  db.prepare('UPDATE students SET group_id = NULL WHERE id = ? AND group_id = ?').run(studentId, groupId);
  if (group.team_leader_id === studentId) {
    const nextLeader = db.prepare('SELECT id FROM students WHERE group_id = ? ORDER BY id LIMIT 1').get(groupId);
    db.prepare('UPDATE student_groups SET team_leader_id = ? WHERE id = ?').run(nextLeader ? nextLeader.id : null, groupId);
  }
}

/** Deletes a group. Its exam submissions cascade away in the database, so their uploaded files
    are removed from storage first (otherwise they'd be orphaned). opts.quiet skips the per-group log line. */
function deleteGroup(groupId, opts = {}) {
  const group = db.prepare('SELECT * FROM student_groups WHERE id = ?').get(groupId);
  if (!group) return false;
  db.prepare(`SELECT f.file_path FROM exam_submission_files f
              JOIN exam_submissions s ON s.id = f.submission_id WHERE s.group_id = ?`)
    .all(groupId).forEach((f) => deleteUploadedFile(f.file_path));
  db.prepare('UPDATE students SET group_id = NULL WHERE group_id = ?').run(groupId);
  db.prepare('DELETE FROM student_groups WHERE id = ?').run(groupId);
  if (!opts.quiet) logActivity(`Group ${group.display_id} deleted`);
  return true;
}

module.exports = { addMember, removeMember, deleteGroup };
