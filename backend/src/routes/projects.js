/* ============================================================
   CDAD backend :: routes/projects.js
   Ports js/projects.js. group.progress is no longer a stored
   mirror (syncGroupProgressFromProject is gone) — groups.js's
   serializeGroup reads progress straight off the linked project
   at request time, so it can't desync.
   ============================================================ */
const path = require('node:path');
const express = require('express');
const { db, nextSequentialId, computeProgressFromStages, PROJECT_STAGES, logActivity } = require('../db');
const { mapAll, serializeProject, groupIdByDisplayId, groupDisplayId, studentDisplayId } = require('../lib/serializers');
const { requireRole } = require('../lib/sessions');
const { createNotification } = require('../lib/notify');
const { upload, deleteUploadedFile } = require('../lib/upload');
const { persistUploads, send: sendStoredFile } = require('../lib/fileStore');

const router = express.Router();

function getRow(id) { return db.prepare('SELECT * FROM projects WHERE id = ?').get(id); }

router.get('/', requireRole(), async (req, res) => {
  res.json(await mapAll(await db.prepare('SELECT * FROM projects ORDER BY id').all(), serializeProject));
});

/** Faculty Submissions Hub: every project with a submission attached, newest first. */
router.get('/submissions', requireRole('faculty'), async (req, res) => {
  const rows = await db.prepare(`
    SELECT p.* FROM projects p JOIN submissions s ON s.project_id = p.id ORDER BY s.submitted_at DESC, p.id DESC
  `).all();
  res.json(await mapAll(rows, serializeProject));
});

router.post('/', requireRole(), async (req, res) => {
  const d = req.body || {};
  const displayId = await nextSequentialId('projects', 'P', 2);
  const stages = d.stages || Object.fromEntries(PROJECT_STAGES.map((s) => [s, 'Pending']));
  const progress = computeProgressFromStages(stages);
  const groupId = d.group ? await groupIdByDisplayId(d.group) : null;
  const info = await db.prepare(`
    INSERT INTO projects (display_id, title, description, tech_stack, group_id, team_leader_display_id,
      start_date, deadline, progress, status, github_url, repo_name, branch, stages)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(displayId, d.title, d.description || '', d.techStack || '', groupId, d.teamLeader || '',
    d.startDate || new Date().toISOString(), d.deadline || '', progress, d.status || 'Active',
    d.githubUrl || '', d.repoName || '', d.branch || 'main', JSON.stringify(stages));
  await logActivity(`Project ${displayId} created`);
  res.status(201).json(await serializeProject(await getRow(info.lastInsertRowid)));
});

router.put('/:id', requireRole(), async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const d = req.body || {};
  const stages = d.stages !== undefined ? d.stages : JSON.parse(row.stages);
  const progress = d.stages !== undefined ? computeProgressFromStages(stages) : row.progress;
  const groupId = d.group !== undefined ? (d.group ? await groupIdByDisplayId(d.group) : null) : row.group_id;
  await db.prepare(`
    UPDATE projects SET title=?, description=?, tech_stack=?, group_id=?, team_leader_display_id=?,
      start_date=?, deadline=?, progress=?, status=?, github_url=?, repo_name=?, branch=?, stages=?
    WHERE id=?
  `).run(
    d.title !== undefined ? d.title : row.title,
    d.description !== undefined ? d.description : row.description,
    d.techStack !== undefined ? d.techStack : row.tech_stack,
    groupId,
    d.teamLeader !== undefined ? d.teamLeader : row.team_leader_display_id,
    d.startDate !== undefined ? d.startDate : row.start_date,
    d.deadline !== undefined ? d.deadline : row.deadline,
    progress,
    d.status !== undefined ? d.status : row.status,
    d.githubUrl !== undefined ? d.githubUrl : row.github_url,
    d.repoName !== undefined ? d.repoName : row.repo_name,
    d.branch !== undefined ? d.branch : row.branch,
    JSON.stringify(stages),
    row.id
  );
  await logActivity(`Project ${row.display_id} updated`);
  res.json(await serializeProject(await getRow(row.id)));
});

router.delete('/:id', requireRole('faculty'), async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const sub = await db.prepare('SELECT file_path FROM submissions WHERE project_id = ?').get(row.id);
  if (sub) await deleteUploadedFile(sub.file_path);
  await db.prepare('DELETE FROM projects WHERE id = ?').run(row.id);
  await logActivity(`Project ${row.display_id} deleted`);
  res.json({ ok: true });
});

router.put('/:id/stages/:stageName', requireRole(), async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const stages = Object.assign({}, JSON.parse(row.stages), { [req.params.stageName]: req.body.status });
  const progress = computeProgressFromStages(stages);
  const newStatus = progress === 100 ? 'Completed' : (row.status === 'Completed' ? 'Active' : row.status);
  await db.prepare('UPDATE projects SET stages=?, progress=?, status=? WHERE id=?')
    .run(JSON.stringify(stages), progress, newStatus, row.id);
  await logActivity(`Stage "${req.params.stageName}" of project ${row.display_id} set to ${req.body.status}`);
  res.json(await serializeProject(await getRow(row.id)));
});

router.put('/:id/group', requireRole('faculty'), async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const groupId = await groupIdByDisplayId(req.body.groupDisplayId);
  await db.prepare('UPDATE projects SET group_id = ? WHERE id = ?').run(groupId, row.id);
  await logActivity(`Project ${row.display_id} assigned to group ${req.body.groupDisplayId}`);
  res.json(await serializeProject(await getRow(row.id)));
});

/* ================= Submission workflow ================= */

/** Only the project's group's team leader may submit — runs before
    upload.single('file') so a rejected non-leader request never writes
    a file to disk in the first place. */
async function requireTeamLeader(req, res, next) {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const group = row.group_id ? await db.prepare('SELECT team_leader_id FROM student_groups WHERE id = ?').get(row.group_id) : null;
  if (!group || group.team_leader_id !== req.user.id) {
    return res.status(403).json({ error: "Only your group's team leader can submit this project." });
  }
  next();
}

/** Submission accepts multipart/form-data: `link`, `note` (both optional)
    plus an optional `file` (PDF/PPT/PPTX/CSV/DOC/DOCX, max 10MB) — see
    backend/src/lib/upload.js. At least one of link or file (new or already on
    record) is required; a resubmission that omits a new file keeps
    whatever file was already attached. */
router.post('/:id/submission', requireRole('student'), requireTeamLeader, upload.single('file'), persistUploads, async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { link, note } = req.body || {};

  const existing = await db.prepare('SELECT * FROM submissions WHERE project_id = ?').get(row.id);
  const hasFile = !!req.file || (existing && !!existing.file_path);
  if (!link && !hasFile) {
    return res.status(400).json({ error: 'Provide a link or attach a file.' });
  }

  if (req.file && existing && existing.file_path) await deleteUploadedFile(existing.file_path);

  const fileName = req.file ? req.file.originalname : (existing ? existing.file_name : null);
  const filePath = req.file ? req.file.filename : (existing ? existing.file_path : null);
  const fileType = req.file ? path.extname(req.file.originalname).slice(1).toLowerCase() : (existing ? existing.file_type : null);
  const fileSize = req.file ? req.file.size : (existing ? existing.file_size : null);

  await db.prepare(`
    INSERT INTO submissions (project_id, link, note, submitted_by_id, submitted_at, status, faculty_note, reviewed_at,
      file_name, file_path, file_type, file_size)
    VALUES (?, ?, ?, ?, ?, 'Pending Review', '', '', ?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET link=excluded.link, note=excluded.note,
      submitted_by_id=excluded.submitted_by_id, submitted_at=excluded.submitted_at,
      status='Pending Review', faculty_note='', reviewed_at='',
      file_name=excluded.file_name, file_path=excluded.file_path, file_type=excluded.file_type, file_size=excluded.file_size
  `).run(row.id, link || '', note || '', req.user.id, new Date().toISOString(), fileName, filePath, fileType, fileSize);

  const stages = Object.assign({}, JSON.parse(row.stages), { Submission: 'In Progress' });
  const progress = computeProgressFromStages(stages);
  await db.prepare('UPDATE projects SET stages=?, progress=? WHERE id=?').run(JSON.stringify(stages), progress, row.id);

  await createNotification({
    title: 'New Project Submission',
    message: `${req.user.displayId} submitted work for project ${row.display_id} (${row.title}) — awaiting review.`,
    type: 'request', recipient: 'all-faculty'
  });
  await logActivity(`${req.user.displayId} submitted work for project ${row.display_id}`);
  res.json(await serializeProject(await getRow(row.id)));
});

router.post('/:id/submission/request', requireRole('faculty'), async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const message = (req.body || {}).message;
  const groupDispId = await groupDisplayId(row.group_id);
  await createNotification({
    title: 'Submission Requested',
    message: message && message.trim() ? message.trim()
      : `Faculty has requested your final submission for ${row.title} (${row.display_id}). Please submit as soon as your work is ready.`,
    type: 'request', recipient: groupDispId || 'all-students'
  });
  await logActivity(`Submission requested from group ${groupDispId} for project ${row.display_id}`);
  res.json(await serializeProject(await getRow(row.id)));
});

router.put('/:id/submission/review', requireRole('faculty'), async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const sub = await db.prepare('SELECT * FROM submissions WHERE project_id = ?').get(row.id);
  if (!sub) return res.status(404).json({ error: 'No submission to review' });
  const { decision, facultyNote } = req.body || {}; // 'Approved' | 'Rejected'
  if (decision !== 'Approved' && decision !== 'Rejected') {
    return res.status(400).json({ error: "Decision must be 'Approved' or 'Rejected'." });
  }

  await db.prepare('UPDATE submissions SET status=?, faculty_note=?, reviewed_at=? WHERE project_id=?')
    .run(decision, facultyNote || '', new Date().toISOString(), row.id);

  const stageStatus = decision === 'Approved' ? 'Completed' : 'Pending';
  const stages = Object.assign({}, JSON.parse(row.stages), { Submission: stageStatus });
  const progress = computeProgressFromStages(stages);
  const newStatus = progress === 100 ? 'Completed' : (row.status === 'Completed' ? 'Active' : row.status);
  await db.prepare('UPDATE projects SET stages=?, progress=?, status=? WHERE id=?')
    .run(JSON.stringify(stages), progress, newStatus, row.id);

  const recipient = (await studentDisplayId(sub.submitted_by_id)) || (await groupDisplayId(row.group_id));
  await createNotification({
    title: `Submission ${decision}`,
    message: decision === 'Approved'
      ? `Your submission for ${row.title} (${row.display_id}) was approved.`
      : `Your submission for ${row.title} (${row.display_id}) was rejected.${facultyNote ? ' Note: ' + facultyNote : ' Please review and resubmit.'}`,
    type: 'request', recipient
  });
  await logActivity(`Submission for project ${row.display_id} ${decision.toLowerCase()}`);
  res.json(await serializeProject(await getRow(row.id)));
});

/** Streams the attached submission file as a download — faculty reviewing it,
    or the submitting group checking their own upload. */
router.get('/:id/submission/file', requireRole(), async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const sub = await db.prepare('SELECT file_name, file_path FROM submissions WHERE project_id = ?').get(row.id);
  if (!sub || !sub.file_path) return res.status(404).json({ error: 'No file attached to this submission.' });
  await sendStoredFile(res, sub.file_path, sub.file_name);
});

module.exports = router;
