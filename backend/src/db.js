/* ============================================================
   CDAD backend :: db.js
   One async database API over two engines:

   - PostgreSQL (Supabase) when DATABASE_URL is set  -> production / Vercel
       DATABASE_URL=postgresql://...        a real server (node-postgres pool)
       DATABASE_URL=pglite:memory           in-process Postgres (tests only)
   - SQLite (node:sqlite, backend/data/cdad.db) otherwise -> local development

   Usage is the same everywhere:
       await db.prepare('SELECT * FROM students WHERE id = ?').get(id)
       await db.prepare('...').all(a, b)
       const { lastInsertRowid, changes } = await db.prepare('INSERT ...').run(...)
       await db.transaction(async () => { ...any db calls... })
   SQL is written with `?` placeholders in the common subset of both dialects;
   for Postgres they are rewritten to $1, $2, ... automatically.
   Call `await ready` (index.js / app.js do) before the first query.
   ============================================================ */
const path = require('node:path');
const fs = require('node:fs');
const { AsyncLocalStorage } = require('node:async_hooks');

const { DATA_DIR } = require('./config');

const DATABASE_URL = process.env.DATABASE_URL || '';
const txStore = new AsyncLocalStorage(); // the transaction's connection, inside db.transaction()

/** Serializes transactions on single-connection engines (SQLite, PGlite). */
function makeMutex() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

/* ---------------- SQLite ---------------- */
function sqliteDriver() {
  const { DatabaseSync } = require('node:sqlite');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const raw = new DatabaseSync(path.join(DATA_DIR, 'cdad.db'));
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('PRAGMA journal_mode = WAL');
  const serial = makeMutex();
  return {
    kind: 'sqlite',
    raw,
    async all(sql, params) { return raw.prepare(sql).all(...params); },
    async get(sql, params) { return raw.prepare(sql).get(...params); },
    async run(sql, params) {
      const i = raw.prepare(sql).run(...params);
      return { changes: Number(i.changes), lastInsertRowid: Number(i.lastInsertRowid) };
    },
    async exec(sql) { raw.exec(sql); },
    transaction(fn) {
      return serial(async () => {
        raw.exec('BEGIN');
        try { const r = await fn(); raw.exec('COMMIT'); return r; } catch (e) { raw.exec('ROLLBACK'); throw e; }
      });
    }
  };
}

/* ---------------- PostgreSQL ---------------- */
const pgSqlCache = new Map();
/** `?` -> `$n` (outside quoted strings), and INSERTs return the new row so lastInsertRowid works. */
function toPg(sql, forRun) {
  const key = (forRun ? 'r:' : 'q:') + sql;
  let out = pgSqlCache.get(key);
  if (out) return out;
  let n = 0; let quote = null; out = '';
  for (const ch of sql) {
    if (quote) { if (ch === quote) quote = null; out += ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; continue; }
    out += ch === '?' ? '$' + (++n) : ch;
  }
  if (forRun && /^\s*insert\b/i.test(out) && !/\breturning\b/i.test(out)) out += ' RETURNING *';
  pgSqlCache.set(key, out);
  return out;
}

function pgDriver(url) {
  let base; // { query(sql, params) -> { rows, rowCount } }
  let transaction;

  if (url.startsWith('pglite:')) {
    const { PGlite } = require('@electric-sql/pglite');
    const where = url.slice('pglite:'.length);
    const inst = new PGlite(where && where !== 'memory' ? where : undefined);
    const wrap = (q) => async (sql, params) => { const r = await q.query(sql, params); return { rows: r.rows, rowCount: r.affectedRows ?? 0 }; };
    base = { query: wrap(inst), exec: (sql) => inst.exec(sql) };
    transaction = (fn) => inst.transaction((tx) => txStore.run({ query: wrap(tx) }, fn));
  } else {
    const pg = require('pg');
    pg.types.setTypeParser(20, (v) => Number(v));   // int8 (COUNT(*) etc.) -> number, as SQLite returns
    pg.types.setTypeParser(1700, (v) => Number(v)); // numeric -> number
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    const pool = new pg.Pool({
      connectionString: url,
      max: Number(process.env.PG_POOL_MAX || 5),
      idleTimeoutMillis: 10000,
      ssl: local ? false : { rejectUnauthorized: false } // Supabase requires TLS
    });
    pool.on('error', (e) => console.error('Postgres pool error:', e.message));
    base = { query: (sql, params) => pool.query(sql, params), exec: (sql) => pool.query(sql), end: () => pool.end() };
    transaction = async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await txStore.run({ query: (sql, params) => client.query(sql, params) }, fn);
        await client.query('COMMIT');
        return r;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally { client.release(); }
    };
  }

  const q = () => txStore.getStore() || base;
  return {
    kind: 'postgres',
    async all(sql, params) { return (await q().query(toPg(sql), params)).rows; },
    async get(sql, params) { return (await q().query(toPg(sql), params)).rows[0]; },
    async run(sql, params) {
      const r = await q().query(toPg(sql, true), params);
      return { changes: r.rowCount, lastInsertRowid: r.rows && r.rows[0] && r.rows[0].id !== undefined ? r.rows[0].id : null };
    },
    async exec(sql) { await (txStore.getStore() || base).query(sql); },
    execScript: (sql) => base.exec(sql), // multi-statement DDL, outside any transaction
    transaction,
    end: base.end
  };
}

const driver = DATABASE_URL ? pgDriver(DATABASE_URL) : sqliteDriver();

const db = {
  kind: driver.kind,
  prepare(sql) {
    return {
      get: (...params) => driver.get(sql, params),
      all: (...params) => driver.all(sql, params),
      run: (...params) => driver.run(sql, params)
    };
  },
  exec: (sql) => driver.exec(sql),
  transaction: (fn) => driver.transaction(fn),
  end: () => (driver.end ? driver.end() : undefined)
};

/* ---------------- Schema ---------------- */
const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY, display_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL, email TEXT, password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS faculty (
  id SERIAL PRIMARY KEY, display_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL, email TEXT, password_hash TEXT NOT NULL,
  phone TEXT, department TEXT, designation TEXT, avatar TEXT, session TEXT
);
CREATE TABLE IF NOT EXISTS student_groups (
  id SERIAL PRIMARY KEY, display_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  team_leader_id INTEGER, status TEXT DEFAULT 'Active', division TEXT
);
CREATE TABLE IF NOT EXISTS students (
  id SERIAL PRIMARY KEY, display_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL, email TEXT, password_hash TEXT NOT NULL,
  phone TEXT, course TEXT, year TEXT, department TEXT,
  group_id INTEGER REFERENCES student_groups(id) ON DELETE SET NULL,
  role TEXT, status TEXT DEFAULT 'Active', avatar TEXT, section TEXT
);
CREATE INDEX IF NOT EXISTS idx_students_group ON students(group_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'student_groups_team_leader_fk') THEN
    ALTER TABLE student_groups ADD CONSTRAINT student_groups_team_leader_fk
      FOREIGN KEY (team_leader_id) REFERENCES students(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY, display_id TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL, description TEXT, tech_stack TEXT,
  group_id INTEGER UNIQUE REFERENCES student_groups(id) ON DELETE SET NULL,
  team_leader_display_id TEXT, start_date TEXT, deadline TEXT,
  progress INTEGER DEFAULT 0, status TEXT DEFAULT 'Active',
  github_url TEXT, repo_name TEXT, branch TEXT DEFAULT 'main', stages TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_group ON projects(group_id);
CREATE TABLE IF NOT EXISTS submissions (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  link TEXT, note TEXT, submitted_by_id INTEGER REFERENCES students(id), submitted_at TEXT, status TEXT,
  faculty_note TEXT, reviewed_at TEXT, file_name TEXT, file_path TEXT, file_type TEXT, file_size INTEGER
);
CREATE TABLE IF NOT EXISTS marks (
  id SERIAL PRIMARY KEY,
  student_id INTEGER UNIQUE NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  internal INTEGER DEFAULT 0, internal_max INTEGER DEFAULT 20, project INTEGER DEFAULT 0, project_max INTEGER DEFAULT 40,
  presentation INTEGER DEFAULT 0, presentation_max INTEGER DEFAULT 20, viva INTEGER DEFAULT 0, viva_max INTEGER DEFAULT 10,
  jury1 DOUBLE PRECISION, jury2 DOUBLE PRECISION, assess3 DOUBLE PRECISION, assign1 DOUBLE PRECISION,
  finals DOUBLE PRECISION, released INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS exam_submissions (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES student_groups(id) ON DELETE CASCADE,
  exam TEXT NOT NULL, link TEXT, note TEXT,
  submitted_by_id INTEGER REFERENCES students(id) ON DELETE SET NULL, submitted_at TEXT,
  file_name TEXT, file_path TEXT, file_type TEXT, file_size INTEGER,
  UNIQUE (group_id, exam)
);
CREATE TABLE IF NOT EXISTS exam_deadlines (exam TEXT PRIMARY KEY, deadline TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS exam_submission_files (
  id SERIAL PRIMARY KEY,
  submission_id INTEGER NOT NULL REFERENCES exam_submissions(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL, file_path TEXT NOT NULL, file_type TEXT, file_size INTEGER
);
CREATE INDEX IF NOT EXISTS idx_exam_files_sub ON exam_submission_files(submission_id);
CREATE TABLE IF NOT EXISTS presentations (
  id SERIAL PRIMARY KEY, display_id TEXT UNIQUE NOT NULL,
  group_id INTEGER REFERENCES student_groups(id) ON DELETE SET NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  date TEXT, time TEXT, venue TEXT,
  faculty_id INTEGER REFERENCES faculty(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'Scheduled', notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_presentations_group ON presentations(group_id);
CREATE TABLE IF NOT EXISTS requests (
  id SERIAL PRIMARY KEY, display_id TEXT UNIQUE NOT NULL,
  student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
  type TEXT, group_id INTEGER REFERENCES student_groups(id) ON DELETE SET NULL,
  message TEXT, date TEXT, status TEXT DEFAULT 'Pending', response TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_student ON requests(student_id);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE TABLE IF NOT EXISTS group_join_requests (
  id SERIAL PRIMARY KEY,
  from_student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
  to_student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES student_groups(id) ON DELETE CASCADE,
  message TEXT, date TEXT, status TEXT DEFAULT 'Pending'
);
CREATE TABLE IF NOT EXISTS student_requests (
  id SERIAL PRIMARY KEY,
  from_student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
  to_student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
  message TEXT, date TEXT, status TEXT DEFAULT 'Pending'
);
CREATE TABLE IF NOT EXISTS student_connections (
  student_a_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
  student_b_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
  created_at TEXT,
  PRIMARY KEY (student_a_id, student_b_id),
  CHECK (student_a_id < student_b_id)
);
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY, title TEXT, message TEXT, type TEXT,
  recipient_kind TEXT CHECK (recipient_kind IN ('all-students','all-faculty','student','faculty','group')),
  recipient_student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
  recipient_faculty_id INTEGER REFERENCES faculty(id) ON DELETE CASCADE,
  recipient_group_id INTEGER REFERENCES student_groups(id) ON DELETE CASCADE,
  date TEXT, read INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notif_recipient
  ON notifications(recipient_kind, recipient_student_id, recipient_faculty_id, recipient_group_id);
CREATE TABLE IF NOT EXISTS announcements (
  id SERIAL PRIMARY KEY, title TEXT, message TEXT, author TEXT,
  date TEXT, priority TEXT DEFAULT 'Normal', status TEXT DEFAULT 'Active'
);
CREATE TABLE IF NOT EXISTS activity (id SERIAL PRIMARY KEY, text TEXT, date TEXT);
CREATE TABLE IF NOT EXISTS seed_meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, data TEXT NOT NULL, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS captchas (id TEXT PRIMARY KEY, answer TEXT NOT NULL, expires_at BIGINT NOT NULL);
`;

/** SQLite: the original schema plus the in-place upgrades older database files need. */
function initSqlite(raw) {
  raw.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT, display_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL, email TEXT, password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS faculty (
  id INTEGER PRIMARY KEY AUTOINCREMENT, display_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL, email TEXT, password_hash TEXT NOT NULL,
  phone TEXT, department TEXT, designation TEXT, avatar TEXT, session TEXT
);
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT, display_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL, email TEXT, password_hash TEXT NOT NULL,
  phone TEXT, course TEXT, year TEXT, department TEXT,
  group_id INTEGER REFERENCES student_groups(id) ON DELETE SET NULL,
  role TEXT, status TEXT DEFAULT 'Active', avatar TEXT
);
CREATE INDEX IF NOT EXISTS idx_students_group ON students(group_id);
CREATE TABLE IF NOT EXISTS student_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT, display_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  team_leader_id INTEGER REFERENCES students(id) ON DELETE SET NULL, status TEXT DEFAULT 'Active'
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT, display_id TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL, description TEXT, tech_stack TEXT,
  group_id INTEGER UNIQUE REFERENCES student_groups(id) ON DELETE SET NULL,
  team_leader_display_id TEXT, start_date TEXT, deadline TEXT,
  progress INTEGER DEFAULT 0, status TEXT DEFAULT 'Active',
  github_url TEXT, repo_name TEXT, branch TEXT DEFAULT 'main', stages TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_group ON projects(group_id);
CREATE TABLE IF NOT EXISTS submissions (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  link TEXT, note TEXT, submitted_by_id INTEGER REFERENCES students(id), submitted_at TEXT, status TEXT,
  faculty_note TEXT, reviewed_at TEXT, file_name TEXT, file_path TEXT, file_type TEXT, file_size INTEGER
);
CREATE TABLE IF NOT EXISTS marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER UNIQUE NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  internal INTEGER DEFAULT 0, internal_max INTEGER DEFAULT 20, project INTEGER DEFAULT 0, project_max INTEGER DEFAULT 40,
  presentation INTEGER DEFAULT 0, presentation_max INTEGER DEFAULT 20, viva INTEGER DEFAULT 0, viva_max INTEGER DEFAULT 10
);
CREATE TABLE IF NOT EXISTS exam_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES student_groups(id) ON DELETE CASCADE,
  exam TEXT NOT NULL, link TEXT, note TEXT,
  submitted_by_id INTEGER REFERENCES students(id) ON DELETE SET NULL, submitted_at TEXT,
  file_name TEXT, file_path TEXT, file_type TEXT, file_size INTEGER,
  UNIQUE (group_id, exam)
);
CREATE TABLE IF NOT EXISTS exam_deadlines (exam TEXT PRIMARY KEY, deadline TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS exam_submission_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES exam_submissions(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL, file_path TEXT NOT NULL, file_type TEXT, file_size INTEGER
);
CREATE INDEX IF NOT EXISTS idx_exam_files_sub ON exam_submission_files(submission_id);
CREATE TABLE IF NOT EXISTS presentations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, display_id TEXT UNIQUE NOT NULL,
  group_id INTEGER REFERENCES student_groups(id) ON DELETE SET NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  date TEXT, time TEXT, venue TEXT,
  faculty_id INTEGER REFERENCES faculty(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'Scheduled', notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_presentations_group ON presentations(group_id);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, display_id TEXT UNIQUE NOT NULL,
  student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
  type TEXT, group_id INTEGER REFERENCES student_groups(id) ON DELETE SET NULL,
  message TEXT, date TEXT, status TEXT DEFAULT 'Pending', response TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_student ON requests(student_id);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE TABLE IF NOT EXISTS group_join_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
  to_student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES student_groups(id) ON DELETE CASCADE,
  message TEXT, date TEXT, status TEXT DEFAULT 'Pending'
);
CREATE TABLE IF NOT EXISTS student_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
  to_student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
  message TEXT, date TEXT, status TEXT DEFAULT 'Pending'
);
CREATE TABLE IF NOT EXISTS student_connections (
  student_a_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
  student_b_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
  created_at TEXT,
  PRIMARY KEY (student_a_id, student_b_id),
  CHECK (student_a_id < student_b_id)
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, message TEXT, type TEXT,
  recipient_kind TEXT CHECK(recipient_kind IN ('all-students','all-faculty','student','faculty','group')),
  recipient_student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
  recipient_faculty_id INTEGER REFERENCES faculty(id) ON DELETE CASCADE,
  recipient_group_id INTEGER REFERENCES student_groups(id) ON DELETE CASCADE,
  date TEXT, read INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notif_recipient
  ON notifications(recipient_kind, recipient_student_id, recipient_faculty_id, recipient_group_id);
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, message TEXT, author TEXT,
  date TEXT, priority TEXT DEFAULT 'Normal', status TEXT DEFAULT 'Active'
);
CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, date TEXT);
CREATE TABLE IF NOT EXISTS seed_meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS captchas (id TEXT PRIMARY KEY, answer TEXT NOT NULL, expires_at INTEGER NOT NULL);
`);
  /** Adds a column to an existing table if it's not already there, so older database files catch up without a reset. */
  const ensureColumn = (table, column, type) => {
    const cols = raw.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  };
  ensureColumn('students', 'section', 'TEXT');
  ensureColumn('student_groups', 'division', 'TEXT');
  // Continuous Assessment: four heads out of 20 (NULL = not entered yet); finals out of 50.
  // The older internal/project/presentation/viva columns are no longer used.
  ['jury1', 'jury2', 'assess3', 'assign1', 'finals'].forEach((c) => ensureColumn('marks', c, 'REAL'));
  // Exam submissions used to hold a single file inline; move any into the files table.
  raw.exec(`
    INSERT INTO exam_submission_files (submission_id, file_name, file_path, file_type, file_size)
    SELECT id, file_name, file_path, file_type, file_size FROM exam_submissions WHERE file_path IS NOT NULL AND file_path != '';
    UPDATE exam_submissions SET file_name = NULL, file_path = NULL, file_type = NULL, file_size = NULL
    WHERE file_path IS NOT NULL AND file_path != '';
  `);
  // Marks are hidden from students until released. Marks that existed before this column did were visible, so keep them released.
  if (!raw.prepare('PRAGMA table_info(marks)').all().some((c) => c.name === 'released')) {
    raw.exec('ALTER TABLE marks ADD COLUMN released INTEGER DEFAULT 0');
    raw.exec('UPDATE marks SET released = 1');
  }
  ['file_name TEXT', 'file_path TEXT', 'file_type TEXT', 'file_size INTEGER'].forEach((d) => {
    const [c, t] = d.split(' '); ensureColumn('submissions', c, t);
  });
}

async function init() {
  if (driver.kind === 'sqlite') initSqlite(driver.raw);
  else await driver.execScript(PG_SCHEMA);
  // First run only: create the default administrator. Change this password after logging in.
  if (!(await db.prepare('SELECT 1 AS x FROM admins LIMIT 1').get())) {
    await db.prepare('INSERT INTO admins (display_id, name, email, password_hash) VALUES (?, ?, ?, ?)')
      .run('ADMIN001', 'Administrator', 'admin@cdad.edu', require('bcryptjs').hashSync('admin123', 10));
  }
}
const ready = init();
ready.catch((e) => console.error('Database initialisation failed:', e.message));

/* ---------------- Shared helpers ---------------- */
const PROJECT_STAGES = ['Planning', 'Requirement Analysis', 'Design', 'Development', 'Testing', 'Presentation', 'Submission'];

function computeProgressFromStages(stages) {
  if (!stages) return 0;
  const total = PROJECT_STAGES.length;
  let score = 0;
  PROJECT_STAGES.forEach((s) => {
    const v = stages[s];
    if (v === 'Completed') score += 1;
    else if (v === 'In Progress') score += 0.5;
  });
  return Math.round((score / total) * 100);
}

/** Mirrors the frontend's nextSequentialId: next ST001/G01/P01/PRE001/REQ001-style id. */
async function nextSequentialId(table, prefix, pad) {
  const rows = await db.prepare(`SELECT display_id FROM ${table}`).all();
  let max = 0;
  rows.forEach((r) => {
    const m = String(r.display_id || '').match(/(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return `${prefix}${String(max + 1).padStart(pad, '0')}`;
}

async function logActivity(text) {
  await db.prepare('INSERT INTO activity (text, date) VALUES (?, ?)').run(text, new Date().toISOString());
}

module.exports = { db, ready, PG_SCHEMA, PROJECT_STAGES, computeProgressFromStages, nextSequentialId, logActivity };
