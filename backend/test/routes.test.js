/* Route coverage: walks every API area end to end (the flows api.test.js doesn't), so the same
   behaviour is verified on SQLite (npm test) and on Postgres (npm run test:pg, via PGlite).
   Boots its own server on a throwaway port with a temp data dir and the demo seed. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3800 + Math.floor(Math.random() * 400);
const BASE = `http://localhost:${PORT}/api`;
let proc, dataDir;

async function api(method, url, { jar, json, form } = {}) {
  const headers = {};
  let body;
  if (jar && jar.cookie) headers.cookie = jar.cookie;
  if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  const res = await fetch(BASE + url, { method, headers, body });
  const set = res.headers.get('set-cookie');
  if (jar && set) jar.cookie = set.split(';')[0];
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* non-JSON body (file download) */ }
  return { status: res.status, data, headers: res.headers };
}
async function login(role, id, password) {
  const jar = {};
  const r = await api('POST', '/auth/login', { jar, json: { role, id, password } });
  assert.equal(r.status, 200, `login ${id}: ${JSON.stringify(r.data)}`);
  return jar;
}
const ok = (r, what) => assert.ok(r.status >= 200 && r.status < 300, `${what}: HTTP ${r.status} ${JSON.stringify(r.data)}`);

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdad-routes-'));
  proc = spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), CDAD_DATA_DIR: dataDir, SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', SUPABASE_BUCKET: '',
      DATABASE_URL: process.env.TEST_DB === 'pglite' ? 'pglite:memory' : '', SKIP_SEED: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 60000);
    proc.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(t); resolve(); } });
    proc.on('exit', (c) => reject(new Error('server exited early: ' + c)));
  });
});
after(() => {
  if (proc) proc.kill();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('sessions survive as database rows: /me works, bogus cookies are rejected', async () => {
  const fac = await login('faculty', 'FAC001', 'faculty123');
  const me = await api('GET', '/auth/me', { jar: fac });
  assert.equal(me.data.displayId, 'FAC001');
  assert.equal((await api('GET', '/auth/me', { jar: { cookie: 'cdad_sid=nope' } })).data, null);
  assert.equal((await api('GET', '/students', { jar: { cookie: 'cdad_sid=nope' } })).status, 401);
  assert.equal((await api('GET', '/students/abc', { jar: fac })).status, 404); // unknown route shape
  assert.equal((await api('PUT', '/students/abc', { jar: fac, json: {} })).status, 404); // non-numeric id
});

test('students, faculty profile and admin management', async () => {
  const fac = await login('faculty', 'FAC001', 'faculty123');
  const adm = await login('admin', 'ADMIN001', 'admin123');
  const list = await api('GET', '/students', { jar: fac });
  ok(list, 'list students');
  assert.ok(list.data.some((s) => s.displayId === 'ADT24SOCB0001' && s.group === 'G01'));
  // ordering is stable (by id)
  const ids = list.data.map((s) => s.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));

  const me = (await api('GET', '/auth/me', { jar: fac })).data;
  const prof = await api('PUT', `/faculty/${me.id}`, { jar: fac, json: { phone: '9000000000' } });
  ok(prof, 'faculty profile');
  assert.equal(prof.data.phone, '9000000000');

  const stu = await login('student', 'ADT24SOCB0002', 'PASS123');
  const self = list.data.find((s) => s.displayId === 'ADT24SOCB0002');
  const edited = await api('PUT', `/students/${self.id}`, { jar: stu, json: { phone: '9111111111', role: 'Team Leader' } });
  ok(edited, 'student edits self');
  assert.equal(edited.data.phone, '9111111111');
  assert.equal(edited.data.role, 'Member'); // students can't change their role
  const other = list.data.find((s) => s.displayId === 'ADT24SOCB0001');
  assert.equal((await api('PUT', `/students/${other.id}`, { jar: stu, json: { phone: '1' } })).status, 403);

  const ov = await api('GET', '/admin/overview', { jar: adm });
  ok(ov, 'overview');
  assert.equal(typeof ov.data.students, 'number');
  const imp = await api('POST', '/admin/students/import', { jar: adm, json: { students: [
    { displayId: 'IMP001', name: 'Import One', section: 'A' },
    { displayId: 'IMP002', name: 'Import Two' },
    { displayId: 'IMP001', name: 'Duplicate in batch' },
    { displayId: 'ADT24SOCB0001', name: 'Already exists' },
    { displayId: 'IMP003', name: '' }
  ] } });
  ok(imp, 'import');
  assert.equal(imp.data.added, 2);
  assert.equal(imp.data.skipped.length, 3);
  const ov2 = await api('GET', '/admin/overview', { jar: adm });
  assert.equal(ov2.data.students, ov.data.students + 2);
  assert.ok(ov2.data.sections >= 1);
  const adminStudents = (await api('GET', '/admin/students', { jar: adm })).data;
  const imp1 = adminStudents.find((s) => s.displayId === 'IMP001');
  ok(await api('PUT', `/admin/students/${imp1.id}`, { jar: adm, json: { status: 'Inactive' } }), 'admin edit student');
  assert.equal((await api('POST', '/auth/login', { json: { role: 'student', id: 'IMP001', password: 'PASS123' } })).status, 403);
  ok(await api('DELETE', `/admin/students/${imp1.id}`, { jar: adm }), 'admin delete student');

  const nf = await api('POST', '/admin/faculty', { jar: adm, json: { displayId: 'FAC777', name: 'New Prof', password: 'secret77' } });
  assert.equal(nf.status, 201);
  assert.equal((await api('POST', '/admin/faculty', { jar: adm, json: { displayId: 'fac777', name: 'Dup' } })).status, 409);
  await login('faculty', 'FAC777', 'secret77');
  ok(await api('PUT', `/admin/faculty/${nf.data.id}`, { jar: adm, json: { designation: 'HOD' } }), 'admin edit faculty');
  assert.ok((await api('GET', '/admin/faculty', { jar: adm })).data.some((f) => f.designation === 'HOD'));
  ok(await api('DELETE', `/admin/faculty/${nf.data.id}`, { jar: adm }), 'admin delete faculty');
  assert.equal((await api('PUT', '/admin/me/password', { jar: adm, json: { currentPassword: 'wrong', newPassword: 'whatever123' } })).status, 401);
});

test('projects: create, edit, stages, assign, submission request', async () => {
  const fac = await login('faculty', 'FAC001', 'faculty123');
  const grp = await api('POST', '/groups', { jar: fac, json: { name: 'Proj Group', members: ['ADT24SOCB0020'], teamLeader: 'ADT24SOCB0020' } });
  assert.equal(grp.status, 201);
  assert.equal(grp.data.teamLeader, 'ADT24SOCB0020');
  const p = await api('POST', '/projects', { jar: fac, json: { title: 'Route Test', group: grp.data.displayId } });
  assert.equal(p.status, 201);
  assert.equal(p.data.group, grp.data.displayId);
  assert.equal(p.data.progress, 0);
  const st = await api('PUT', `/projects/${p.data.id}/stages/Planning`, { jar: fac, json: { status: 'Completed' } });
  ok(st, 'stage');
  assert.equal(st.data.progress, 14);
  const ed = await api('PUT', `/projects/${p.data.id}`, { jar: fac, json: { title: 'Route Test 2', techStack: 'Node' } });
  assert.equal(ed.data.title, 'Route Test 2');
  ok(await api('POST', `/projects/${p.data.id}/submission/request`, { jar: fac, json: {} }), 'request submission');
  const ldr = await login('student', 'ADT24SOCB0020', 'PASS123');
  const notes = (await api('GET', '/notifications', { jar: ldr })).data;
  assert.ok(notes.some((n) => n.title === 'Submission Requested'), 'group notification reaches member');
  const groups = (await api('GET', '/groups', { jar: fac })).data;
  assert.equal(groups.find((g) => g.id === grp.data.id).project, p.data.displayId);
  const unassigned = await api('PUT', `/projects/${p.data.id}/group`, { jar: fac, json: { groupDisplayId: 'NOPE' } });
  assert.equal(unassigned.data.group, '');
  const assigned = await api('PUT', `/projects/${p.data.id}/group`, { jar: fac, json: { groupDisplayId: grp.data.displayId } });
  assert.equal(assigned.data.group, grp.data.displayId);
  ok(await api('DELETE', `/projects/${p.data.id}`, { jar: fac }), 'delete project');
  ok(await api('DELETE', `/groups/${grp.data.id}`, { jar: fac }), 'delete group');
});

test('project submission with a file: upload, download, review', async () => {
  const fac = await login('faculty', 'FAC001', 'faculty123');
  const leader = await login('student', 'ADT24SOCB0001', 'PASS123');
  const p01 = (await api('GET', '/projects', { jar: fac })).data.find((p) => p.displayId === 'P01');
  const f = new FormData();
  f.append('file', new Blob(['%PDF-route-test']), 'report.pdf');
  f.append('link', 'https://example.com/repo');
  const sub = await api('POST', `/projects/${p01.id}/submission`, { jar: leader, form: f });
  ok(sub, 'submit');
  assert.equal(sub.data.submission.fileName, 'report.pdf');
  assert.equal(sub.data.submission.status, 'Pending Review');
  const hub = await api('GET', '/projects/submissions', { jar: fac });
  assert.ok(hub.data.some((p) => p.id === p01.id));
  const dl = await api('GET', `/projects/${p01.id}/submission/file`, { jar: fac });
  assert.equal(dl.status, 200);
  assert.equal(dl.data, '%PDF-route-test');
  const rev = await api('PUT', `/projects/${p01.id}/submission/review`, { jar: fac, json: { decision: 'Rejected', facultyNote: 'redo' } });
  assert.equal(rev.data.submission.status, 'Rejected');
});

test('exam submissions: deadline, multi-file upload, download, delete', async () => {
  const fac = await login('faculty', 'FAC001', 'faculty123');
  const leader = await login('student', 'ADT24SOCB0001', 'PASS123');
  const member = await login('student', 'ADT24SOCB0002', 'PASS123');
  ok(await api('PUT', '/exam-submissions/deadlines/TA1', { jar: fac, json: { deadline: '2099-01-01T00:00:00Z' } }), 'deadline');
  const form = new FormData();
  form.append('files', new Blob(['a,b\n1,2']), 'data.csv');
  form.append('files', new Blob(['%PDF-x']), 'slides.pdf');
  form.append('note', 'first try');
  assert.equal((await api('POST', '/exam-submissions/TA1', { jar: member, form })).status, 403); // not leader
  const sub = await api('POST', '/exam-submissions/TA1', { jar: leader, form });
  ok(sub, 'exam submit');
  assert.equal(sub.data.files.length, 2);
  const mine = await api('GET', '/exam-submissions', { jar: member });
  assert.equal(mine.data.deadlines.TA1, '2099-01-01T00:00:00.000Z');
  assert.equal(mine.data.submissions.length, 1);
  const csv = sub.data.files.find((x) => x.name === 'data.csv');
  const prev = await api('GET', `/exam-submissions/files/${csv.id}?inline=1`, { jar: member });
  assert.equal(prev.status, 200);
  assert.equal(prev.data, 'a,b\n1,2');
  const outsider = await login('student', 'ADT24SOCB0020', 'PASS123');
  assert.equal((await api('GET', `/exam-submissions/files/${csv.id}`, { jar: outsider })).status, 403);
  // resubmit: drop the csv, keep the pdf
  const form2 = new FormData();
  form2.append('removeFileIds', JSON.stringify([csv.id]));
  form2.append('link', 'https://example.com');
  const re = await api('POST', '/exam-submissions/TA1', { jar: leader, form: form2 });
  assert.deepEqual(re.data.files.map((x) => x.name), ['slides.pdf']);
  const all = await api('GET', '/exam-submissions', { jar: fac });
  ok(await api('DELETE', `/exam-submissions/${all.data.submissions[0].id}`, { jar: fac }), 'delete exam submission');
  ok(await api('PUT', '/exam-submissions/deadlines/TA1', { jar: fac, json: { deadline: '' } }), 'clear deadline');
});

test('presentations: schedule, edit, reschedule, cancel, complete, delete', async () => {
  const fac = await login('faculty', 'FAC001', 'faculty123');
  const pr = await api('POST', '/presentations', { jar: fac, json: { group: 'G01', date: '2030-02-02', time: '11:00', venue: 'Lab 2', faculty: 'FAC001' } });
  assert.equal(pr.status, 201);
  assert.equal(pr.data.project, 'P01'); // picked up from the group
  assert.equal(pr.data.faculty, 'FAC001');
  ok(await api('PUT', `/presentations/${pr.data.id}`, { jar: fac, json: { venue: 'Hall' } }), 'edit');
  const rs = await api('PUT', `/presentations/${pr.data.id}/reschedule`, { jar: fac, json: { date: '2030-03-03', time: '12:00' } });
  assert.equal(rs.data.status, 'Rescheduled');
  assert.equal((await api('PUT', `/presentations/${pr.data.id}/cancel`, { jar: fac })).data.status, 'Cancelled');
  assert.equal((await api('PUT', `/presentations/${pr.data.id}/complete`, { jar: fac })).data.status, 'Completed');
  assert.ok((await api('GET', '/presentations', { jar: fac })).data.length >= 2);
  ok(await api('DELETE', `/presentations/${pr.data.id}`, { jar: fac }), 'delete');
});

test('requests, announcements, notifications, activity', async () => {
  const fac = await login('faculty', 'FAC001', 'faculty123');
  const stu = await login('student', 'ADT24SOCB0002', 'PASS123');
  const rq = await api('POST', '/requests', { jar: stu, json: { type: 'Extension', group: 'G01', message: 'please' } });
  assert.equal(rq.status, 201);
  assert.equal(rq.data.student, 'ADT24SOCB0002');
  assert.equal(rq.data.group, 'G01');
  const resp = await api('PUT', `/requests/${rq.data.id}/respond`, { jar: fac, json: { status: 'Approved', response: 'ok' } });
  assert.equal(resp.data.status, 'Approved');
  ok(await api('PUT', `/requests/${rq.data.id}`, { jar: fac, json: { message: 'edited' } }), 'edit request');
  assert.ok((await api('GET', '/requests', { jar: fac })).data.some((r) => r.message === 'edited'));
  ok(await api('DELETE', `/requests/${rq.data.id}`, { jar: fac }), 'delete request');

  const an = await api('POST', '/announcements', { jar: fac, json: { title: 'Route ann', message: 'hello', priority: 'High' } });
  assert.equal(an.status, 201);
  ok(await api('PUT', `/announcements/${an.data.id}`, { jar: fac, json: { status: 'Archived' } }), 'edit ann');
  assert.equal((await api('GET', '/announcements', { jar: stu })).data[0].title, 'Route ann'); // newest first
  ok(await api('DELETE', `/announcements/${an.data.id}`, { jar: fac }), 'delete ann');

  ok(await api('POST', '/notifications', { jar: fac, json: { title: 'Direct', message: 'm', recipient: 'ADT24SOCB0002' } }), 'notify student');
  const mine = (await api('GET', '/notifications', { jar: stu })).data;
  const direct = mine.find((n) => n.title === 'Direct');
  assert.equal(direct.recipient, 'ADT24SOCB0002');
  const unread = (await api('GET', '/notifications/unread-count', { jar: stu })).data.count;
  const rd = await api('PUT', `/notifications/${direct.id}/read`, { jar: stu, json: {} });
  assert.equal(rd.data.read, true);
  assert.equal((await api('GET', '/notifications/unread-count', { jar: stu })).data.count, unread - 1);
  ok(await api('PUT', `/notifications/${direct.id}`, { jar: fac, json: { title: 'Direct 2' } }), 'edit notif');
  assert.ok((await api('GET', '/notifications/all', { jar: fac })).data.some((n) => n.title === 'Direct 2'));
  ok(await api('DELETE', `/notifications/${direct.id}`, { jar: fac }), 'delete notif');

  const act = await api('GET', '/activity', { jar: fac });
  assert.ok(act.data.length > 5);
  assert.ok(act.data[0].date >= act.data[act.data.length - 1].date); // newest first
});

test('peer connections and group join requests', async () => {
  const a = await login('student', 'ADT24SOCB0820', 'PASS123');
  const b = await login('student', 'ADT24SOCB0001', 'PASS123');
  const loner = await login('student', 'ADT24SOCB0020', 'PASS123');
  // the seed already has a pending request 0820 -> 0001
  const dup = await api('POST', '/peer-requests', { jar: a, json: { to: 'ADT24SOCB0001', message: 'again' } });
  assert.equal(dup.data.ok, false);
  const pending = (await api('GET', '/peer-requests', { jar: b })).data.find((r) => r.from === 'ADT24SOCB0820' && r.status === 'Pending');
  ok(await api('PUT', `/peer-requests/${pending.id}/respond`, { jar: b, json: { accept: true } }), 'accept peer');
  const me = (await api('GET', '/auth/me', { jar: b })).data;
  assert.deepEqual(me.connections, ['ADT24SOCB0820']);
  const again = await api('PUT', `/peer-requests/${pending.id}/respond`, { jar: b, json: { accept: true } }); // idempotent
  assert.equal(again.data.ok, true);
  ok(await api('DELETE', '/peer-requests/connections/ADT24SOCB0820', { jar: b }), 'remove connection');
  assert.deepEqual((await api('GET', '/auth/me', { jar: b })).data.connections, []);
  const sent = await api('POST', '/peer-requests', { jar: loner, json: { to: 'ADT24SOCB0002', message: 'hi' } });
  assert.equal(sent.status, 201);
  ok(await api('DELETE', `/peer-requests/${sent.data.request.id}`, { jar: loner }), 'delete peer request');

  const look = await api('GET', '/group-join-requests/lookup?targetId=adt24socb0001', { jar: loner });
  assert.equal(look.data.ok, true);
  assert.equal(look.data.groupDisplayId, 'G01');
  const jr = await api('POST', '/group-join-requests', { jar: loner, json: { targetLeaderId: 'ADT24SOCB0001' } });
  assert.equal(jr.status, 201);
  assert.equal(jr.data.request.groupDisplayId, 'G01');
  assert.equal((await api('POST', '/group-join-requests', { jar: loner, json: { targetLeaderId: 'ADT24SOCB0001' } })).data.ok, false);
  ok(await api('PUT', `/group-join-requests/${jr.data.request.id}/respond`, { jar: b, json: { accept: true } }), 'accept join');
  assert.equal((await api('GET', '/auth/me', { jar: loner })).data.group, 'G01');
  const g01 = (await api('GET', '/groups', { jar: b })).data.find((g) => g.displayId === 'G01');
  assert.ok(g01.members.includes('ADT24SOCB0020'));
  // leaving: the loner leaves; then a whole group leaves and is disbanded
  const left = await api('POST', `/groups/${g01.id}/leave`, { jar: loner });
  assert.equal(left.data.disbanded, false);
  assert.equal((await api('GET', '/auth/me', { jar: loner })).data.group, '');
  const solo = await api('POST', '/groups', { jar: loner, json: { name: 'Solo', teamLeader: 'ADT24SOCB0020' } });
  const bye = await api('POST', `/groups/${solo.data.id}/leave`, { jar: loner });
  assert.equal(bye.data.disbanded, true);
  // add/remove member endpoints; removing the leader promotes the next member
  const fac = await login('faculty', 'FAC001', 'faculty123');
  ok(await api('POST', `/groups/${g01.id}/members`, { jar: fac, json: { studentDisplayId: 'ADT24SOCB0020' } }), 'add member');
  const leaderRow = (await api('GET', '/students', { jar: fac })).data.find((s) => s.displayId === 'ADT24SOCB0001');
  const removed = await api('DELETE', `/groups/${g01.id}/members/${leaderRow.id}`, { jar: fac });
  assert.ok(removed.data.teamLeader && removed.data.teamLeader !== 'ADT24SOCB0001');
});

test('faculty delete-all students clears the roster', async () => {
  const fac = await login('faculty', 'FAC001', 'faculty123');
  const s = await api('POST', '/students', { jar: fac, json: { displayId: 'TMP900', name: 'Temp' } });
  assert.equal(s.status, 201);
  ok(await api('DELETE', `/students/${s.data.id}`, { jar: fac }), 'delete one');
  ok(await api('DELETE', '/students', { jar: fac }), 'delete all');
  assert.deepEqual((await api('GET', '/students', { jar: fac })).data, []);
  assert.ok((await api('GET', '/groups', { jar: fac })).data.every((g) => g.members.length === 0 && g.teamLeader === ''));
});
