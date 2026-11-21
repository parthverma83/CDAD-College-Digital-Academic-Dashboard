/* ============================================================
   CDAD backend :: serializers.js
   Reconstructs the exact JSON shapes the frontend already expects
   (the ones it used to read straight out of LocalStorage) from the
   normalized SQL rows. Keeping this shape stable is what lets most
   of the frontend survive the migration with only `await` added.
   All functions are async (the database API is).
   ============================================================ */
const { db } = require('../db');

/** Serializes a list of rows concurrently: await mapAll(rows, serializeX). */
const mapAll = (rows, fn) => Promise.all(rows.map((r) => fn(r)));

async function studentDisplayId(id) {
  if (!id) return '';
  const row = await db.prepare('SELECT display_id FROM students WHERE id = ?').get(id);
  return row ? row.display_id : '';
}

async function facultyDisplayId(id) {
  if (!id) return '';
  const row = await db.prepare('SELECT display_id FROM faculty WHERE id = ?').get(id);
  return row ? row.display_id : '';
}

async function groupDisplayId(id) {
  if (!id) return '';
  const row = await db.prepare('SELECT display_id FROM student_groups WHERE id = ?').get(id);
  return row ? row.display_id : '';
}

async function studentIdByDisplayId(displayId) {
  if (displayId === undefined || displayId === null) return null;
  const row = await db.prepare('SELECT id FROM students WHERE display_id = ?').get(String(displayId));
  return row ? row.id : null;
}

async function groupIdByDisplayId(displayId) {
  if (displayId === undefined || displayId === null) return null;
  const row = await db.prepare('SELECT id FROM student_groups WHERE display_id = ?').get(String(displayId));
  return row ? row.id : null;
}

async function connectionsOf(studentId) {
  const rows = await db.prepare(`
    SELECT s.display_id FROM student_connections c
    JOIN students s ON s.id = CASE WHEN c.student_a_id = ? THEN c.student_b_id ELSE c.student_a_id END
    WHERE c.student_a_id = ? OR c.student_b_id = ?
  `).all(studentId, studentId, studentId);
  return rows.map((r) => r.display_id);
}

function serializeFaculty(row) {
  if (!row) return null;
  return {
    id: row.id, displayId: row.display_id, name: row.name, email: row.email,
    phone: row.phone, department: row.department, designation: row.designation,
    avatar: row.avatar, session: row.session
  };
}

async function serializeStudent(row) {
  if (!row) return null;
  const [group, connections] = await Promise.all([groupDisplayId(row.group_id), connectionsOf(row.id)]);
  return {
    id: row.id, displayId: row.display_id, name: row.name, email: row.email,
    phone: row.phone, course: row.course, year: row.year, department: row.department, section: row.section || '',
    group, role: row.role, status: row.status, avatar: row.avatar,
    connections
  };
}

async function serializeGroup(row) {
  if (!row) return null;
  const [memberRows, project, teamLeader] = await Promise.all([
    db.prepare('SELECT display_id FROM students WHERE group_id = ? ORDER BY id').all(row.id),
    db.prepare('SELECT display_id, progress FROM projects WHERE group_id = ?').get(row.id),
    studentDisplayId(row.team_leader_id)
  ]);
  return {
    id: row.id, displayId: row.display_id, name: row.name,
    teamLeader, members: memberRows.map((r) => r.display_id), division: row.division || '',
    project: project ? project.display_id : '', status: row.status,
    progress: project ? project.progress : 0
  };
}

async function serializeSubmission(row) {
  if (!row) return null;
  return {
    link: row.link, note: row.note, submittedBy: await studentDisplayId(row.submitted_by_id),
    submittedAt: row.submitted_at, status: row.status, facultyNote: row.faculty_note, reviewedAt: row.reviewed_at,
    // file_path is the internal storage ref — never exposed; the file is only reachable via the download route.
    fileName: row.file_name || '', fileType: row.file_type || '', fileSize: row.file_size || 0
  };
}

async function serializeProject(row) {
  if (!row) return null;
  const [submission, group] = await Promise.all([
    db.prepare('SELECT * FROM submissions WHERE project_id = ?').get(row.id),
    groupDisplayId(row.group_id)
  ]);
  return {
    id: row.id, displayId: row.display_id, title: row.title, description: row.description,
    techStack: row.tech_stack, group, teamLeader: row.team_leader_display_id || '',
    startDate: row.start_date, deadline: row.deadline, progress: row.progress, status: row.status,
    githubUrl: row.github_url, repoName: row.repo_name, branch: row.branch,
    stages: JSON.parse(row.stages),
    submission: submission ? await serializeSubmission(submission) : null
  };
}

async function serializeMarks(row) {
  if (!row) return null;
  return {
    id: row.id, studentId: await studentDisplayId(row.student_id),
    // Continuous Assessment heads, each out of 20 (null = not entered yet)
    jury1: row.jury1 ?? null, jury2: row.jury2 ?? null, assess3: row.assess3 ?? null, assign1: row.assign1 ?? null,
    finals: row.finals ?? null, // final exam, out of 50 (null = not entered yet)
    released: !!row.released
  };
}

async function serializePresentation(row) {
  if (!row) return null;
  const [group, project, faculty] = await Promise.all([
    groupDisplayId(row.group_id),
    row.project_id ? db.prepare('SELECT display_id FROM projects WHERE id = ?').get(row.project_id) : null,
    facultyDisplayId(row.faculty_id)
  ]);
  return {
    id: row.id, displayId: row.display_id, group,
    project: project ? project.display_id : '',
    date: row.date, time: row.time, venue: row.venue, faculty,
    status: row.status, notes: row.notes
  };
}

async function serializeRequest(row) {
  if (!row) return null;
  const [student, group] = await Promise.all([studentDisplayId(row.student_id), groupDisplayId(row.group_id)]);
  return {
    id: row.id, displayId: row.display_id, student,
    type: row.type, group, message: row.message,
    date: row.date, status: row.status, response: row.response
  };
}

async function serializeGroupJoinRequest(row) {
  if (!row) return null;
  const [from, to, groupDisp] = await Promise.all([
    studentDisplayId(row.from_student_id), studentDisplayId(row.to_student_id), groupDisplayId(row.group_id)
  ]);
  return {
    id: row.id, from, to,
    groupId: row.group_id, groupDisplayId: groupDisp,
    message: row.message, date: row.date, status: row.status
  };
}

async function serializePeerRequest(row) {
  if (!row) return null;
  const [from, to] = await Promise.all([studentDisplayId(row.from_student_id), studentDisplayId(row.to_student_id)]);
  return {
    id: row.id, from, to,
    message: row.message, date: row.date, status: row.status
  };
}

async function serializeNotification(row) {
  if (!row) return null;
  let recipient = row.recipient_kind;
  if (row.recipient_kind === 'student') recipient = await studentDisplayId(row.recipient_student_id);
  else if (row.recipient_kind === 'faculty') recipient = await facultyDisplayId(row.recipient_faculty_id);
  else if (row.recipient_kind === 'group') recipient = await groupDisplayId(row.recipient_group_id);
  return {
    id: row.id, title: row.title, message: row.message, type: row.type,
    recipient, date: row.date, read: !!row.read
  };
}

function serializeAnnouncement(row) {
  if (!row) return null;
  return {
    id: row.id, title: row.title, message: row.message, author: row.author,
    date: row.date, priority: row.priority, status: row.status
  };
}

function serializeActivity(row) {
  if (!row) return null;
  return { id: row.id, text: row.text, date: row.date };
}

module.exports = {
  mapAll,
  studentDisplayId, facultyDisplayId, groupDisplayId, studentIdByDisplayId, groupIdByDisplayId, connectionsOf,
  serializeFaculty, serializeStudent, serializeGroup, serializeProject, serializeSubmission,
  serializeMarks, serializePresentation, serializeRequest, serializeGroupJoinRequest,
  serializePeerRequest, serializeNotification, serializeAnnouncement, serializeActivity
};
