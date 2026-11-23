/* API smoke tests. Run: npm test  (Node 22.5+). Boots the real server on a
   throwaway port with a temp data dir, so live data is never touched. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 20000 + (process.pid % 10000) * 2; // unique per test process (they run in parallel)
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
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, data };
}
async function login(role, id, password) {
  const jar = {};
  const r = await api('POST', '/auth/login', { jar, json: { role, id, password } });
  assert.equal(r.status, 200, `login ${id}`);
  return jar;
}
function fileForm(name, content, extra = {}) {
  const f = new FormData();
  f.append('file', new Blob([content]), name);
  for (const [k, v] of Object.entries(extra)) f.append(k, v);
  return f;
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdad-test-'));
  proc = spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(__dirname, '..'),
    // Blank Supabase settings (they win over backend/.env) so tests store files on local disk and never touch a real
    // bucket or database. TEST_DB=pglite runs the same suite on an in-memory Postgres (npm run test:pg).
    env: { ...process.env, PORT: String(PORT), CDAD_DATA_DIR: dataDir, SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', SUPABASE_BUCKET: '',
      DATABASE_URL: process.env.TEST_DB === 'pglite' ? 'pglite:memory' : '', SKIP_SEED: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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

test('login succeeds per role and rejects bad credentials', async () => {
  await login('admin', 'ADMIN001', 'admin123');
  await login('faculty', 'FAC001', 'faculty123');
  await login('student', 'ADT24SOCB0001', 'PASS123');
  const bad = await api('POST', '/auth/login', { json: { role: 'faculty', id: 'FAC001', password: 'nope' } });
  assert.equal(bad.status, 401);
  const inj = await api('POST', '/auth/login', { json: { role: 'student', id: "' OR 1=1 --", password: 'x' } });
  assert.equal(inj.status, 401);
});

test('unauthenticated requests get 401 (no crash)', async () => {
  for (const p of ['/students', '/groups', '/projects', '/marks', '/activity', '/exam-submissions']) {
    assert.equal((await api('GET', p)).status, 401, p);
  }
});

test('role boundaries: students cannot use faculty/admin routes', async () => {
  const stu = await login('student', 'ADT24SOCB0001', 'PASS123');
  assert.equal((await api('GET', '/activity', { jar: stu })).status, 401);
  assert.equal((await api('GET', '/admin/overview', { jar: stu })).status, 401);
  assert.equal((await api('DELETE', '/students/2', { jar: stu })).status, 401);
  const adm = await login('admin', 'ADMIN001', 'admin123');
  assert.equal((await api('GET', '/admin/overview', { jar: adm })).status, 200);
});

test('faculty can add a student; duplicate ID is rejected', async () => {
  const fac = await login('faculty', 'FAC001', 'faculty123');
  const s = { displayId: 'TEST001', name: 'Test One', email: 't1@x.com', password: 'PASS123' };
  assert.equal((await api('POST', '/students', { jar: fac, json: s })).status, 201);
  assert.equal((await api('POST', '/students', { jar: fac, json: s })).status, 400);
  await login('student', 'TEST001', 'PASS123');
});

test('submission upload rules and team-leader enforcement', async () => {
  const leader = await login('student', 'ADT24SOCB0001', 'PASS123');
  const fac = await login('faculty', 'FAC001', 'faculty123');
  const loner = await login('student', 'TEST001', 'PASS123');
  const url = '/projects/1/submission';

  assert.equal((await api('POST', url, { jar: leader, form: fileForm('bad.exe', 'x') })).status, 400);
  assert.equal((await api('POST', url, { jar: loner, form: fileForm('a.pdf', '%PDF-1.4') })).status, 403);
  // The server may reset the connection mid-upload instead of replying, so a network error also counts as rejected.
  const big = await api('POST', url, { jar: leader, form: fileForm('big.pdf', Buffer.alloc(11 * 1024 * 1024)) })
    .catch(() => ({ status: 'rejected' }));
  assert.ok(big.status === 400 || big.status === 'rejected', `oversized upload accepted: ${big.status}`);
  assert.equal((await api('POST', url, { jar: leader, form: fileForm('ok.pdf', '%PDF-1.4 test') })).status, 200);

  // Review decision validation
  const rev = '/projects/1/submission/review';
  assert.equal((await api('PUT', rev, { jar: fac, json: { decision: 'Banana' } })).status, 400);
  assert.equal((await api('PUT', rev, { jar: fac, json: {} })).status, 400);
  const ok = await api('PUT', rev, { jar: fac, json: { decision: 'Approved', facultyNote: 'good' } });
  assert.equal(ok.status, 200);
  const notes = await api('GET', '/notifications', { jar: leader });
  assert.ok(notes.data.some((n) => n.title === 'Submission Approved'));
});

test('marks stay hidden from students until released', async () => {
  const fac = await login('faculty', 'FAC001', 'faculty123');
  const stu = await login('student', 'ADT24SOCB0001', 'PASS123');
  await api('POST', '/marks/release-all', { jar: fac, json: { released: false } });
  assert.deepEqual((await api('GET', '/marks', { jar: stu })).data, []);
  await api('POST', '/marks/release-all', { jar: fac, json: { released: true } });
  assert.ok((await api('GET', '/marks', { jar: stu })).data.length > 0);
});

test('exam deadline validation and forgot-password captcha', async () => {
  const fac = await login('faculty', 'FAC001', 'faculty123');
  assert.equal((await api('PUT', '/exam-submissions/deadlines/TA9', { jar: fac, json: { deadline: '2030-01-01' } })).status, 400);
  assert.equal((await api('PUT', '/exam-submissions/deadlines/TA1', { jar: fac, json: { deadline: 'garbage' } })).status, 400);
  assert.equal((await api('PUT', '/exam-submissions/deadlines/TA1', { jar: fac, json: { deadline: '2030-01-01T10:00:00Z' } })).status, 200);
  const cap = await api('GET', '/auth/captcha');
  assert.equal(cap.status, 200);
  const reset = await api('POST', '/auth/forgot-password/reset', {
    json: { role: 'student', id: 'ADT24SOCB0001', email: 'hanfa@cdad.edu', captchaId: 'x', captchaText: 'zzzz', newPassword: 'abc12345' },
  });
  assert.equal(reset.status, 400);
  assert.equal(reset.data.captchaFailed, true);
});

test('groups carry a division (stored upper-case) that can be changed', async () => {
  const fac = await login('faculty', 'FAC001', 'faculty123');
  const made = await api('POST', '/groups', { jar: fac, json: { name: 'Division Test', division: ' cc1 ' } });
  assert.equal(made.status, 201);
  assert.equal(made.data.division, 'CC1');
  const moved = await api('PUT', `/groups/${made.data.id}`, { jar: fac, json: { division: 'cc2' } });
  assert.equal(moved.data.division, 'CC2');
  // an update that doesn't mention division leaves it alone
  const renamed = await api('PUT', `/groups/${made.data.id}`, { jar: fac, json: { name: 'Division Test 2' } });
  assert.equal(renamed.data.division, 'CC2');
  const none = await api('POST', '/groups', { jar: fac, json: { name: 'No Division Test' } });
  assert.equal(none.data.division, '');
});

test('bulk delete groups: by division, then all; students are kept but ungrouped', async () => {
  const fac = await login('faculty', 'FAC001', 'faculty123');
  const stu = await login('student', 'ADT24SOCB0001', 'PASS123');
  assert.equal((await api('DELETE', '/groups', { jar: stu })).status, 401); // faculty only
  const mk = (name, division) => api('POST', '/groups', { jar: fac, json: { name, division } });
  await mk('Bulk A', 'cc9'); await mk('Bulk B', 'CC9'); await mk('Bulk C', 'cc8');

  const byDiv = await api('DELETE', '/groups?division=cc9', { jar: fac });
  assert.equal(byDiv.status, 200);
  assert.equal(byDiv.data.deleted, 2);
  let names = (await api('GET', '/groups', { jar: fac })).data.map((g) => g.name);
  assert.ok(names.includes('Bulk C') && !names.includes('Bulk A') && !names.includes('Bulk B'));

  // The leader of Group Alpha uploads an exam file; deleting the group must remove that file from storage.
  const lead = await login('student', 'ADT24SOCB0001', 'PASS123');
  const examForm = new FormData();
  examForm.append('files', new Blob(['%PDF-1.4 exam']), 'exam.pdf');
  const sub = await api('POST', '/exam-submissions/TA2', { jar: lead, form: examForm });
  assert.ok(sub.status === 200 || sub.status === 201, `exam upload failed: ${sub.status}`);
  const uploads = path.join(dataDir, 'uploads');
  const filesBefore = fs.readdirSync(uploads).length;

  const before = (await api('GET', '/students', { jar: fac })).data.length;
  const all = await api('DELETE', '/groups', { jar: fac });
  await new Promise((r) => setTimeout(r, 300)); // file removal is fire-and-forget
  assert.equal(fs.readdirSync(uploads).length, filesBefore - 1, 'exam file should be removed with its group');
  assert.equal(all.status, 200);
  assert.ok(all.data.deleted >= 1);
  assert.deepEqual((await api('GET', '/groups', { jar: fac })).data, []);
  const students = (await api('GET', '/students', { jar: fac })).data;
  assert.equal(students.length, before); // nobody deleted
  assert.ok(students.every((s) => !s.group)); // everyone ungrouped
  assert.equal((await api('DELETE', '/groups', { jar: fac })).data.deleted, 0); // nothing left is fine
});

test('Continuous Assessment marks: four heads out of 20, optional, validated, clearable', async () => {
  const fac = await login('faculty', 'FAC001', 'faculty123');
  const sid = 'ADT24SOCB0002';
  const get = async () => (await api('GET', '/marks', { jar: fac })).data.find((m) => m.studentId === sid);
  const before = await get();
  assert.deepEqual([before.jury1, before.jury2, before.assess3, before.assign1], [15, 14, 16, 17]); // demo marks
  assert.equal('internal' in before || 'viva' in before || 'ta1' in before, false); // old components are gone

  const put = (json) => api('PUT', `/marks/student/${sid}`, { jar: fac, json });
  assert.equal((await put({ jury1: 21 })).status, 400); // above 20
  assert.equal((await put({ jury2: -1 })).status, 400);
  assert.equal((await put({ assess3: 'abc' })).status, 400);

  const ok = await put({ jury1: 12.5, assign1: null });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.data.jury1, ok.data.jury2, ok.data.assess3, ok.data.assign1], [12.5, 14, 16, null]); // only what was sent changes
  assert.equal((await put({})).data.jury1, 12.5); // an empty update changes nothing

  // Finals: a separate exam out of 50, entered as is
  assert.equal(before.finals, null);
  assert.equal((await put({ finals: 51 })).status, 400);
  assert.equal((await put({ finals: -2 })).status, 400);
  const withFinals = await put({ finals: 41.5 });
  assert.equal(withFinals.data.finals, 41.5);
  assert.deepEqual([withFinals.data.jury1, withFinals.data.jury2], [12.5, 14]); // CA marks untouched
  assert.equal((await put({ jury1: 20 })).data.finals, 41.5); // and a CA update keeps the Finals

  // Group entry: same mark for every member; blank / missing never clears what a student already has
  const made = await api('POST', '/groups', { jar: fac, json: { name: 'CA Group', members: ['ADT24SOCB0001', sid] } });
  const gid = made.data.displayId;
  const grp = (json) => api('PUT', `/marks/group/${gid}`, { jar: fac, json });
  assert.equal((await grp({ jury1: 99 })).status, 400);
  const applied = await grp({ assess3: 10, jury1: '' });
  assert.equal(applied.data.updated, 2);
  const after = (await api('GET', '/marks', { jar: fac })).data;
  assert.equal(after.find((m) => m.studentId === sid).assess3, 10);
  assert.equal(after.find((m) => m.studentId === sid).jury1, 20); // blank kept the existing mark
  assert.equal(after.find((m) => m.studentId === sid).finals, 41.5); // group entry never touches Finals
  assert.equal(after.find((m) => m.studentId === 'ADT24SOCB0001').assess3, 10);

  // students see it only after release
  await api('POST', '/marks/release-all', { jar: fac, json: { released: true } });
  const stu = await login('student', sid, 'PASS123');
  const mine = (await api('GET', '/marks', { jar: stu })).data.find((m) => m.studentId === sid);
  assert.equal(mine.assess3, 10);

  const reset = (await api('POST', `/marks/${before.id}/reset`, { jar: fac })).data;
  assert.deepEqual([reset.jury1, reset.jury2, reset.assess3, reset.assign1, reset.finals], [null, null, null, null, null]);
});

test('logout invalidates the session', async () => {
  const stu = await login('student', 'ADT24SOCB0001', 'PASS123');
  assert.equal((await api('GET', '/auth/me', { jar: stu })).data.displayId, 'ADT24SOCB0001');
  await api('POST', '/auth/logout', { jar: stu });
  assert.equal((await api('GET', '/auth/me', { jar: stu })).data, null);
});
