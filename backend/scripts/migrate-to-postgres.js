/* ============================================================
   CDAD :: scripts/migrate-to-postgres.js
   One-time copy of the local SQLite database (backend/data/cdad.db)
   into the Postgres database in DATABASE_URL (Supabase), plus any
   locally stored uploads into Supabase Storage.

     cd backend
     node scripts/migrate-to-postgres.js            # refuses if the target already has data
     node scripts/migrate-to-postgres.js --force    # wipes the target's CDAD tables first

   Reads DATABASE_URL and SUPABASE_* from backend/.env (or the environment).
   Everything is copied in one transaction: it either all lands or nothing does.
   Logins (sessions) are not copied, so everyone signs in once more afterwards.
   ============================================================ */
const path = require('node:path');
const fs = require('node:fs');

const { DATA_DIR } = require('../src/config'); // loads backend/.env
const SQLITE_FILE = process.env.SQLITE_FILE || path.join(DATA_DIR, 'cdad.db');
const FORCE = process.argv.includes('--force');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Put the Supabase connection string in backend/.env first.');
  process.exit(1);
}
if (!fs.existsSync(SQLITE_FILE)) {
  console.error(`No SQLite database at ${SQLITE_FILE}`);
  process.exit(1);
}

const { DatabaseSync } = require('node:sqlite');
const { db, ready } = require('../src/db');
const fileStore = require('../src/lib/fileStore');

// Parents before children. student_groups goes in without team leaders (students don't exist yet);
// the leaders are filled in once students are in.
const TABLES = [
  'admins', 'faculty', 'student_groups', 'students', 'projects', 'submissions', 'marks',
  'exam_submissions', 'exam_deadlines', 'exam_submission_files', 'presentations', 'requests',
  'group_join_requests', 'student_requests', 'student_connections', 'notifications',
  'announcements', 'activity', 'seed_meta'
];
const SERIAL_TABLES = TABLES.filter((t) => !['submissions', 'exam_deadlines', 'student_connections', 'seed_meta'].includes(t));
const MIME = { pdf: 'application/pdf', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };

async function pgColumns(table) {
  const rows = await db.prepare('SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?').all(table);
  return new Set(rows.map((r) => r.column_name));
}

async function insertRows(table, cols, rows) {
  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const values = chunk.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ');
    const params = chunk.flatMap((r) => cols.map((c) => (r[c] === undefined ? null : r[c])));
    await db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${values}`).run(...params);
  }
}

/** Local uploads can't follow the app to Vercel: copy each one to Supabase Storage and rewrite its ref. */
async function moveLocalFiles(rows, table) {
  let moved = 0;
  for (const r of rows) {
    if (!r.file_path || fileStore.isRemoteRef(r.file_path)) continue;
    const local = path.join(fileStore.UPLOAD_DIR, r.file_path);
    if (!fs.existsSync(local)) { console.warn(`  ! ${table}: file ${r.file_path} is missing on disk, keeping the old reference`); continue; }
    if (!fileStore.isSupabase()) throw new Error(`Local upload ${r.file_path} needs Supabase Storage configured (SUPABASE_*) to be migrated.`);
    const ext = String(r.file_type || path.extname(r.file_name || '').slice(1)).toLowerCase();
    r.file_path = await fileStore.copyLocalToSupabase(r.file_path, r.file_name, MIME[ext]);
    moved++;
  }
  return moved;
}

async function main() {
  await ready; // creates the Postgres tables if they don't exist yet
  if (db.kind !== 'postgres') throw new Error('DATABASE_URL did not select Postgres.');
  const src = new DatabaseSync(SQLITE_FILE, { readOnly: true });
  const srcTables = new Set(src.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));

  const existing = (await db.prepare('SELECT (SELECT COUNT(*) FROM students) + (SELECT COUNT(*) FROM faculty) + (SELECT COUNT(*) FROM student_groups) AS n').get()).n;
  if (existing > 0 && !FORCE) {
    throw new Error(`The target database already has ${existing} students/faculty/groups. Re-run with --force to replace them.`);
  }

  // Read everything (and upload local files) before touching the target.
  const data = {};
  for (const t of TABLES) data[t] = srcTables.has(t) ? src.prepare(`SELECT * FROM ${t}`).all() : [];
  const movedFiles = (await moveLocalFiles(data.submissions, 'submissions')) + (await moveLocalFiles(data.exam_submission_files, 'exam_submission_files'));

  await db.transaction(async () => {
    if (FORCE || existing === 0) {
      // Children first. admins too: the target's auto-created default admin is replaced by the real one.
      for (const t of [...TABLES].reverse()) await db.prepare(`DELETE FROM ${t}`).run();
      await db.prepare('DELETE FROM sessions').run();
    }
    for (const t of TABLES) {
      const rows = data[t];
      if (!rows.length) { console.log(`  ${t}: 0 rows`); continue; }
      const target = await pgColumns(t);
      const cols = Object.keys(rows[0]).filter((c) => target.has(c));
      const copy = t === 'student_groups' ? rows.map((r) => ({ ...r, team_leader_id: null })) : rows;
      await insertRows(t, cols, copy);
      if (t === 'students') {
        for (const g of data.student_groups.filter((x) => x.team_leader_id)) {
          await db.prepare('UPDATE student_groups SET team_leader_id = ? WHERE id = ?').run(g.team_leader_id, g.id);
        }
      }
      console.log(`  ${t}: ${rows.length} rows`);
    }
    // Make the next auto-generated id continue after the copied ones.
    for (const t of SERIAL_TABLES) {
      await db.exec(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 1), (SELECT MAX(id) FROM ${t}) IS NOT NULL)`);
    }
  });

  // Verify: every table's row count matches.
  let mismatches = 0;
  for (const t of TABLES) {
    const n = (await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).n;
    if (n !== data[t].length) { mismatches++; console.error(`  MISMATCH ${t}: source ${data[t].length}, target ${n}`); }
  }
  src.close();
  console.log(mismatches ? `Finished with ${mismatches} mismatching table(s).` : `Done. All ${TABLES.length} tables match; ${movedFiles} local file(s) copied to Supabase Storage.`);
  return mismatches;
}

main().then(
  async (bad) => { await db.end(); process.exit(bad ? 1 : 0); },
  async (e) => { console.error('Migration failed — nothing was changed in the target database.\n' + e.message); await db.end(); process.exit(1); }
);
