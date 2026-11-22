# Deploying CDAD

Two ways to run CDAD:

- **Vercel + Supabase (recommended, free):** the frontend and the API run on
  Vercel, and all data lives in Supabase (Postgres database + Storage bucket).
  See section 0.
- **Kubernetes:** the same image as 2 replicas behind a LoadBalancer, with a
  persistent volume. See [k8s/README.md](../k8s/README.md).
- **One Docker container** (sections 1–5): the Express API, the static
  frontend and a SQLite file on a persistent disk, on a VPS, a college server,
  or Render/Railway/Fly with a volume.

The database engine is picked by one setting: with `DATABASE_URL` set the
API uses PostgreSQL, without it a local SQLite file.

## 0. Vercel + Supabase

```
browser ──> Vercel ── frontend/ (static, CDN)
               └──── /api/*  ->  api/index.js (the Express app, serverless)
                                   ├── Supabase Postgres  (DATABASE_URL)
                                   └── Supabase Storage   (SUPABASE_*)
```

**Supabase** (once):
1. Create a project. Note its region; put the Vercel function in the same one
   (`vercel.json` uses `sin1`, Singapore, matching `ap-southeast-1`).
2. **Storage → New bucket** `cdad-uploads`, Public **off** (section 4).
3. **Connect** (top bar) → **Transaction pooler** → copy the URI (port `6543`)
   and put your database password into it. That is `DATABASE_URL`.
4. Copy existing data (optional): put `DATABASE_URL` and `SUPABASE_*` in
   `backend/.env`, then `cd backend && npm run migrate:pg`. It creates the
   tables, copies every row from `backend/data/cdad.db`, uploads locally stored
   files to the bucket, and checks that every table's row count matches. It
   refuses to overwrite a database that already has data unless you add `--force`.
   Without this step the first request creates empty tables (plus the demo data
   unless `SKIP_SEED=true`).

**Vercel** (once):
1. **Add New → Project → Import** the GitHub repository. Leave the framework
   as **Other** and the root directory as the repository root: `vercel.json`
   already sets the install command, the output folder (`frontend`) and the
   `/api` rewrite.
2. **Environment Variables**: `DATABASE_URL`, `SUPABASE_URL`,
   `SUPABASE_SERVICE_KEY`, `SUPABASE_BUCKET=cdad-uploads`, and
   `SKIP_SEED=true` for a real deployment.
3. **Deploy.** Every push to the production branch redeploys.

Notes:
- Sessions and captchas are stored in the database, so logins survive
  redeploys and work across serverless instances. HTTPS-only cookies and proxy
  trust are switched on automatically on Vercel.
- **Upload size:** Vercel rejects request bodies over about 4.5 MB, so on Vercel
  the files in one submission must total under ~4 MB (students get a clear
  message; larger work can be shared as a Drive link).
- Free Supabase projects pause after about a week without traffic. If the site
  shows errors after a quiet period, restore the project in the Supabase dashboard.
- `npm test` runs the API tests on SQLite and on an in-memory Postgres (PGlite),
  so both engines stay in step.

## 1. Run it with Docker Compose

```bash
cp .env.example .env        # then edit .env (see below)
docker compose up -d --build
```

Open `http://<server>:3000` (or the `PORT` you set). Useful commands:

```bash
docker compose logs -f cdad     # logs
docker compose up -d --build    # update after `git pull`
docker compose down             # stop; data stays in the cdad-data volume
```

Everything lives in the `cdad-data` volume (`/app/server/data`): the SQLite
database and, unless you use Supabase Storage, the uploaded files. **Back it up**:

```bash
docker run --rm -v cdad-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/cdad-data-$(date +%F).tgz -C /data .
```

## 2. Settings (`.env`)

| Variable | What it does |
|---|---|
| `PORT` | Host port to publish (default 3000) |
| `SKIP_SEED=true` | **Use this for a real deployment.** Skips the demo students/faculty. The default admin is still created |
| `COOKIE_SECURE=true` | Send the login cookie only over HTTPS (turn on once you have TLS) |
| `TRUST_PROXY=true` | Trust `X-Forwarded-*` headers from your reverse proxy |
| `DATABASE_URL` | PostgreSQL connection string (Supabase). Unset = local SQLite file — section 0 |
| `SUPABASE_*` | Optional file storage in Supabase Storage — section 4 |

Never commit `.env` (it is gitignored).

## 3. First steps on a new server

1. Set `SKIP_SEED=true` in `.env`, then `docker compose up -d --build`.
2. Log in on the **Admin** tab: `ADMIN001` / `admin123`.
3. **Change the admin password right away** — it is the same on every install.
   Use **🔑 Change Password** at the bottom of the Admin Panel sidebar.
4. In the Admin Panel add faculty and import students (CSV).

> Without `SKIP_SEED`, the first start fills the database with demo data and
> demo logins (`FAC001`/`faculty123`, students/`PASS123`). Fine for a demo,
> not for real use. Note that changing `SEED_VERSION` in `backend/src/seed.js`
> **wipes** the data tables on the next start of a server that isn't using
> `SKIP_SEED`.

### HTTPS

Put a reverse proxy (Caddy, nginx, Traefik, or the host's built-in TLS) in
front of port 3000, then set `COOKIE_SECURE=true` and `TRUST_PROXY=true`.
Caddy example (`Caddyfile`):

```
cdad.example.com {
    reverse_proxy localhost:3000
}
```

Sessions are kept in memory, so restarting the container logs everyone out.

## 4. Optional: store uploaded files in Supabase Storage

By default submitted files (project submissions and TA1/TA2/EndSem uploads)
are saved on the server's disk. To keep them in a Supabase Storage bucket
instead:

1. Create a project at https://supabase.com (the free plan is enough).
2. **Storage → New bucket**: name it `cdad-uploads`, leave **Public bucket OFF**,
   and optionally set the file size limit to 10 MB.
3. **Project Settings → API Keys**: copy the **secret** key (`sb_secret_...`; on
   older projects the `service_role` key). The project URL
   (`https://<ref>.supabase.co`) is on the project's home page / Data API settings.
4. Put the three values in `.env`:

   ```
   SUPABASE_URL=https://<ref>.supabase.co
   SUPABASE_SERVICE_KEY=sb_secret_...
   SUPABASE_BUCKET=cdad-uploads
   ```
5. `docker compose up -d --build` (or restart `npm start`). New uploads go to
   Supabase; the database stores a reference like `supabase:submissions/<id>.pdf`.

Supabase pauses free projects after about a week with no activity. If uploads
start failing with "Could not store the file", restore the project from the
Supabase dashboard.

Notes:
- **Existing files are not moved.** Files uploaded before switching on
  Supabase stay on local disk and keep working (the reference tells the
  server where each file is). Keep the volume until those are no longer needed.
- Students and faculty never talk to Supabase directly — every download goes
  through CDAD's own permission checks, so the bucket can stay private.
- If Supabase is unreachable when a student uploads, the upload is rejected
  with a clear error (nothing is half-saved).
- The database itself stays in SQLite; only files move.

## 5. Hosting on Render (managed)

`render.yaml` in the repo root describes the service, so Render can set it up for you.

1. Push the repo to GitHub (already done for `backend-migration`; use whichever branch you want live).
2. Render dashboard → **New → Blueprint** → connect the GitHub repo and branch.
3. Render reads `render.yaml` and asks for the three values marked `sync: false`:
   `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (`SUPABASE_BUCKET` is preset to `cdad-uploads`). Paste them there
   (not in git). Leave them empty to keep files on the disk instead.
4. Create. The first build takes a few minutes. You get a `https://cdad-xxxx.onrender.com` address.
5. Open it, log in on the **Admin** tab (`ADMIN001` / `admin123`), click
   **🔑 Change Password**, then add faculty and import students.

Important:
- **Use a paid instance (`starter` or above).** The database is a SQLite file on the
  persistent disk (`/app/server/data`), and Render only offers disks on paid instances.
  A free instance has no disk — data would be wiped on every restart.
- Only **one** instance: SQLite and in-memory sessions don't work across several. Don't scale out.
- Each deploy restarts the app, which logs everyone out (sessions are in memory).
- Render's disk is backed up as snapshots on its side; still export your own copy
  now and then (Render dashboard → Shell, or the backup command in section 1).
- For a custom domain, add it in the Render dashboard; HTTPS is automatic.

**Railway / Fly.io** work the same way: build from the `Dockerfile`, attach a volume
mounted at `/app/server/data`, run a single instance, and set the same environment
variables (`SKIP_SEED`, `COOKIE_SECURE`, `TRUST_PROXY`, `SUPABASE_*`).
