/* ============================================================
   CDAD backend :: fileStore.js
   Where uploaded submission files live. Two backends behind one API:

   - local disk        (default) -> backend/data/uploads/, stored ref = the file name
   - Supabase Storage            -> used when all three SUPABASE_* variables are set,
                                    stored ref = "supabase:<object path>"

   The ref goes into the existing file_path columns, so files saved before
   Supabase was switched on keep working: send()/remove() look at the ref's
   prefix, not at the current setting.

   Env (backend/.env, or real environment variables in Docker / Render):
     SUPABASE_URL          e.g. https://abcdefghijklmnop.supabase.co
     SUPABASE_SERVICE_KEY  the project's secret key (sb_secret_...) or legacy service_role key.
                           Server-side only — never put it in the frontend.
     SUPABASE_BUCKET       name of a PRIVATE Storage bucket, e.g. cdad-uploads
   ============================================================ */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const { DATA_DIR } = require('../config'); // also loads backend/.env

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const PREFIX = 'supabase:';
// Refs written by the old Appwrite backend (removed). They can no longer be fetched.
const LEGACY_APPWRITE_PREFIX = 'appwrite:';

function config() {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_BUCKET } = process.env;
  if (!(SUPABASE_URL && SUPABASE_SERVICE_KEY && SUPABASE_BUCKET)) return null;
  return { url: SUPABASE_URL.replace(/\/+$/, ''), key: SUPABASE_SERVICE_KEY, bucket: SUPABASE_BUCKET };
}

const isSupabase = () => !!config();
const isRemoteRef = (ref) => typeof ref === 'string' && (ref.startsWith(PREFIX) || ref.startsWith(LEGACY_APPWRITE_PREFIX));

/** Calls the Supabase Storage REST API for one object in the configured bucket. */
function objectFetch(cfg, objectPath, init = {}) {
  const encoded = objectPath.split('/').map(encodeURIComponent).join('/');
  return fetch(`${cfg.url}/storage/v1/object/${encodeURIComponent(cfg.bucket)}/${encoded}`, {
    ...init,
    // Secret keys (sb_secret_...) are accepted as a Bearer token only when it equals the apikey header.
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, ...(init.headers || {}) }
  });
}

/** Uploads one multer file (already on disk) to Supabase Storage and returns its ref. */
async function uploadToSupabase(cfg, file) {
  // Random object name, kept flat; the original name is stored separately in the DB.
  const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^.a-z0-9]/g, '');
  const objectPath = `submissions/${crypto.randomBytes(12).toString('hex')}${ext}`;
  const res = await objectFetch(cfg, objectPath, {
    method: 'POST',
    headers: { 'Content-Type': file.mimetype || 'application/octet-stream', 'x-upsert': 'false' },
    body: await fs.promises.readFile(path.join(UPLOAD_DIR, file.filename))
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Supabase upload failed (${res.status}): ${body.message || body.error || 'unknown error'}`);
  }
  return PREFIX + objectPath;
}

/**
 * Express middleware, placed right after multer. With Supabase on, moves every uploaded
 * file there and rewrites file.filename to the remote ref; handlers downstream then
 * store/delete/serve it exactly like a local name. On failure nothing is kept anywhere.
 */
async function persistUploads(req, res, next) {
  const files = req.files || (req.file ? [req.file] : []);
  const cfg = config();
  if (!cfg || !files.length) return next();
  const uploaded = [];
  try {
    for (const f of files) {
      const ref = await uploadToSupabase(cfg, f);
      uploaded.push(ref);
      fs.unlink(path.join(UPLOAD_DIR, f.filename), () => {});
      f.filename = ref;
    }
    next();
  } catch (e) {
    console.error(e);
    await Promise.all(uploaded.map(remove));
    files.filter((f) => !isRemoteRef(f.filename)).forEach((f) => fs.unlink(path.join(UPLOAD_DIR, f.filename), () => {}));
    res.status(502).json({ error: 'Could not store the file. Please try again.' });
  }
}

/** Best-effort delete of a stored file, local or remote. */
async function remove(ref) {
  if (!ref) return;
  if (ref.startsWith(LEGACY_APPWRITE_PREFIX)) return; // nothing to reach any more
  if (ref.startsWith(PREFIX)) {
    const cfg = config();
    if (!cfg) return;
    try {
      const res = await objectFetch(cfg, ref.slice(PREFIX.length), { method: 'DELETE' });
      if (!res.ok && res.status !== 404) console.error(`Supabase delete failed (${res.status})`);
    } catch (e) { console.error('Supabase delete failed:', e.message); }
    return;
  }
  fs.unlink(path.join(UPLOAD_DIR, ref), () => {});
}

/**
 * Sends a stored file to the client. opts.inline + opts.contentType = show in the
 * browser instead of downloading (used by the exam-file preview).
 */
async function send(res, ref, downloadName, opts = {}) {
  if (ref.startsWith(LEGACY_APPWRITE_PREFIX)) {
    return res.status(410).json({ error: 'This file was stored in the old Appwrite storage and is no longer available. Please re-upload it.' });
  }
  if (ref.startsWith(PREFIX)) {
    const cfg = config();
    if (!cfg) return res.status(503).json({ error: 'File storage is not configured on this server.' });
    const upstream = await objectFetch(cfg, ref.slice(PREFIX.length));
    if (!upstream.ok) return res.status(upstream.status === 404 || upstream.status === 400 ? 404 : 502).json({ error: 'File could not be retrieved.' });
    res.setHeader('Content-Type', opts.contentType || upstream.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Content-Disposition', opts.inline ? 'inline' : `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return Readable.fromWeb(upstream.body).pipe(res);
  }
  const full = path.join(UPLOAD_DIR, ref);
  if (opts.inline) {
    res.setHeader('Content-Type', opts.contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.sendFile(full);
  }
  return res.download(full, downloadName);
}

module.exports = { UPLOAD_DIR, isSupabase, isRemoteRef, persistUploads, remove, send };
