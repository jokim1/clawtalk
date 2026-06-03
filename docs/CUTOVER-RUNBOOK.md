# ClawTalk Greenfield Cutover Runbook

> **Status:** execution runbook · **Last updated:** 2026-06-02
> Orientation: [REFACTOR-OVERVIEW.md](./REFACTOR-OVERVIEW.md) (§14 cutover risk) · [IMPLEMENTATION-HANDOFF.md](./IMPLEMENTATION-HANDOFF.md)
>
> This runbook cuts production from the **legacy** Supabase project to the **greenfield** schema
> (`supabase/migrations/0001_clawtalk_greenfield.sql`) on branch `codex/clawtalk-greenfield-cutover`,
> using a **fresh Supabase project** (decided by Joseph 2026-06-02 — NOT an in-place wipe).

## Why a fresh project (not an in-place wipe)

A fresh project:

- **Reproduces the validated `db reset`-from-zero path.** `supabase db push` against an empty project applies
  `0001` exactly like the local `supabase db reset` we validate below.
- **Keeps the old project as an instant rollback.** Nothing is destroyed on the legacy project; reverting is
  "point the Worker + GitHub secrets back at the old ref."
- **Sidesteps the `on_auth_user_created` footgun (CT101).** `0001` installs a trigger that inserts
  `public.users` on `auth.users` INSERT, and `ensure_user_workspace_bootstrap()` raises **`CT101` unknown-user**
  if `public.users` is empty. Wiping `public` on the *existing* project leaves the old `auth.users` rows in
  place — they do **not** re-fire the trigger on next login, so bootstrap hits CT101. A fresh project has no
  `auth.users` yet, so the **first** Google sign-in inserts a brand-new `auth.users` row that fires the trigger
  cleanly. (See `0001` lines ~62-84 `handle_new_auth_user` + ~1815 `ensure_user_workspace_bootstrap`.)

---

## TL;DR checklist

Legend: 🔴 = **Joseph executes** (irreversible and/or needs credentials I don't have) · ⚙️ = automated by `deploy.yml` · ✅ = safe/reversible.

- [ ] **0.** ✅ Pre-flight: confirm branch + validate `0001` applies from zero locally (`npm run db:reset`).
- [ ] **1.** 🔴 Create fresh Supabase project — capture **ref**, **db password**, **publishable (anon) key**, **project URL**.
- [ ] **2.** 🔴 Google Cloud: add the **new** project's `https://<newref>.supabase.co/auth/v1/callback` to the OAuth client's authorized redirect URIs.
- [ ] **3.** 🔴 Supabase Auth: enable **Google** provider (same client id/secret), set **Site URL** + **Redirect URLs**.
- [ ] **4.** 🔴 **Apply `0001` to the cloud DB now** via `supabase link` + `supabase db push` (creates the `clawtalk_event_hub` role that step 5 needs, and de-risks the deploy).
- [ ] **5.** 🔴 Set the `clawtalk_event_hub` role password + Worker secret **`DB_EVENT_HUB_URL`** ⚠️ (requires step 4 done; the old predeploy gate no longer fires — see §5).
- [ ] **6.** 🔴 Cloudflare: `wrangler hyperdrive create` against the new pooler → capture new **Hyperdrive id**.
- [ ] **7.** 🔴 Edit + commit `wrangler.toml`: `[[hyperdrive]] id` + `[vars] SUPABASE_PROJECT_URL` → new values.
- [ ] **8.** 🔴 Repoint GitHub Actions secrets: `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (+ `SUPABASE_ACCESS_TOKEN` only if new account/org).
- [ ] **9.** 🔴 Merge `codex/clawtalk-greenfield-cutover` → `main` (**admin-merge past red CI** — legacy backend tests are red by design per §14).
- [ ] **10.** ⚙️ `deploy.yml` auto-runs on push to `main`: webapp build → `supabase db push --include-all` → sync `SUPABASE_PUBLISHABLE_KEY` → `wrangler deploy`.
- [ ] **11.** 🔴 First sign-in at https://clawtalk.app (fires trigger → bootstrap seeds workspace + agents).
- [ ] **12.** 🔴 Re-add LLM provider keys + re-OAuth Google/Slack connectors (DB was empty on the fresh project).
- [ ] **13.** ✅ Smoke test (chat → agent reply → live stream) and keep the old project until confident.

**`deploy.yml` needs no code changes** — every project-specific value is read from GitHub Actions secrets. The
only repo edits are the two `wrangler.toml` values in step 7. The one caveat is the `DB_EVENT_HUB_URL` gate
(step 5) is now a silent no-op — call it out and set the secret manually.

---

## Step 0 — Pre-flight (✅ on the branch, no cloud yet)

```bash
cd /Users/josephkim/.codex/worktrees/381b/clawtalk
git switch codex/clawtalk-greenfield-cutover
git status                       # expect clean (or only intended cutover edits)

# Validate that 0001 applies to an EMPTY database from zero — this is the
# exact path `supabase db push` runs against the fresh cloud project.
# WARNING: db:reset WIPES the local DB (including the local login user).
npm run db:reset                 # supabase db reset --workdir . → drops, recreates, applies 0001 + seed

# Restore the local login user (the trigger only fires on a NEW auth.users insert):
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54432 -U postgres -d postgres -c \
  "insert into auth.users (id,email,raw_user_meta_data) values \
   ('4bbda411-0eae-4a6e-ab6a-f5289b406f3b','jokim1@gmail.com','{\"full_name\":\"Joseph Kim\"}'::jsonb) \
   on conflict (id) do nothing;"

# Confirm the webapp still builds against the current branch:
npm --prefix webapp run build
```

A clean `db:reset` is the green light: it proves the same DDL `deploy.yml` will push applies to an empty DB.

---

## Step 1 — Create the fresh Supabase project (🔴 Joseph)

In the [Supabase dashboard](https://supabase.com/dashboard) → **New project**:

- Same org as the legacy project (so `SUPABASE_ACCESS_TOKEN` keeps working — see step 8).
- Pick a region close to the Cloudflare Hyperdrive region you'll use (latency).
- Set a strong DB password — **write it down**.

**Capture these four values** (you need them in later steps):

| Value | Where | Used in |
| --- | --- | --- |
| **Project ref** (e.g. `abcdwxyz...`) | Project Settings → General | `SUPABASE_PROJECT_REF`, Hyperdrive conn string, Google redirect URI |
| **DB password** | the password you just set | `SUPABASE_DB_PASSWORD`, Hyperdrive + `DB_EVENT_HUB_URL` conn strings |
| **Publishable (anon) key** (`sb_publishable_...`) | Project Settings → API keys | `VITE_SUPABASE_ANON_KEY` (→ auto-synced to Worker `SUPABASE_PUBLISHABLE_KEY`) |
| **Project URL** (`https://<ref>.supabase.co`) | Project Settings → API | `VITE_SUPABASE_URL` + `wrangler.toml [vars] SUPABASE_PROJECT_URL` |

> The fresh project's `public` schema is empty; `auth`/`storage` are Supabase-managed. `0001` creates everything
> in `public` and installs the `auth.users` trigger.

---

## Step 2 — Google Cloud OAuth redirect (🔴 Joseph)

The **new** project has a new `*.supabase.co` domain, so its Auth callback URL changes. Reuse the existing
Google OAuth **app** (no need to create a new one — same `clawtalk.app` origin), but add the new callback:

- [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → your OAuth 2.0 Client ID →
  **Authorized redirect URIs** → add:
  ```
  https://<newref>.supabase.co/auth/v1/callback
  ```
- Leave the existing `clawtalk.app` redirect URIs in place. (You may remove the old project's
  `*.supabase.co/auth/v1/callback` after the cutover is confirmed.)

> The Worker's own `GOOGLE_OAUTH_REDIRECT_URI` (`https://clawtalk.app/api/v1/auth/google/callback`, in
> `wrangler.toml [vars]`) is unchanged — it's keyed to the app domain, not the Supabase project.

---

## Step 3 — Supabase Auth config (🔴 Joseph)

New project → **Authentication**:

- **Providers → Google:** enable; paste the **same** Google OAuth client id + secret as the legacy project.
- **URL Configuration → Site URL:** `https://clawtalk.app`
- **URL Configuration → Redirect URLs:** add `https://clawtalk.app` (and `https://clawtalk.app/**` if the
  dashboard wants a wildcard for the post-login redirect).

> Auth here is the Supabase-side client OAuth (`signInWithOAuth({ provider: 'google' })`). The Worker then
> exchanges the resulting tokens for HttpOnly cookies via `POST /api/v1/auth/callback`.

---

## Step 4 — Apply the schema to the cloud project now (🔴 Joseph)

`deploy.yml` will apply the schema again at step 10 (idempotent no-op once recorded), but apply it **now** for
two reasons: it de-risks the deploy, and it **creates the `clawtalk_event_hub` role that step 5 configures**
(you can't `ALTER ROLE` a role that doesn't exist yet).

```bash
cd /Users/josephkim/.codex/worktrees/381b/clawtalk
export SUPABASE_ACCESS_TOKEN=<management-api-token>   # account-level; same as GitHub secret
supabase link --project-ref <newref>
# Prompts for the DB password (or set SUPABASE_DB_PASSWORD).
supabase db push --include-all          # applies 0001 to the empty project from zero
```

Expect `0001_clawtalk_greenfield.sql` to apply with no diff afterward. (`--include-all` matches `deploy.yml`;
harmless with a single migration.)

---

## Step 5 — `clawtalk_event_hub` role + `DB_EVENT_HUB_URL` (🔴 Joseph) ⚠️ silent gate regression

> ⚠️ **This step used to be enforced by a predeploy gate that no longer fires.**
> `scripts/verify-deploy-secrets.sh` blocks the deploy only when a `supabase/migrations/0006_*.sql` file is
> present. The greenfield baseline collapsed everything into `0001`, so that glob never matches and the gate
> **silently skips**. But `0001` still `revoke all on public.event_outbox from authenticated` and creates the
> `clawtalk_event_hub` login role (lines ~2259-2267) **without a password**. The cloud Worker only INSERTs to
> the outbox, but the `UserEventHub` Durable Object **reads** it as `clawtalk_event_hub` via the
> `DB_EVENT_HUB_URL` Worker secret. If that secret is unset, **live event streaming silently breaks** and
> nothing blocks the deploy.

**Prerequisite:** step 4 must be done — `0001` creates the `clawtalk_event_hub` role (you can't set a password
on a role that doesn't exist). If you skipped step 4, this step has to wait until after the step-10 deploy
applies the schema, during which live event streaming is broken — another reason to do step 4 first.

`event_outbox` is protected purely by GRANT/REVOKE (no RLS policy), so the role needs only: login + a password +
a `SELECT` grant (already in `0001`) + `USAGE` on `public` (granted to all in `0001`).

1. Set the role password (Supabase SQL editor or `psql` as `postgres`):
   ```sql
   alter role clawtalk_event_hub with password '<event-hub-role-password>';
   ```
2. Build the connection string — use the **Supavisor session pooler** (port 5432, same host family as
   Hyperdrive), substituting the event-hub role:
   ```
   postgresql://clawtalk_event_hub.<newref>:<event-hub-role-password>@aws-1-<region>.pooler.supabase.com:5432/postgres
   ```
   (Copy the host/format from Supabase → Project Settings → Database → Connection string, then swap the role
   and password.)
3. Set the Worker secret:
   ```bash
   cd /Users/josephkim/.codex/worktrees/381b/clawtalk
   wrangler secret put DB_EVENT_HUB_URL      # paste the connection string
   ```

See the canonical notes in `wrangler.toml` (the `DB_EVENT_HUB_URL` comment block) for the full rationale.

---

## Step 6 — Cloudflare Hyperdrive (🔴 Joseph)

Create a new Hyperdrive connection pointing at the **new** project's session pooler:

```bash
cd /Users/josephkim/.codex/worktrees/381b/clawtalk
wrangler hyperdrive create clawtalk-pg-greenfield \
  --connection-string "postgresql://postgres.<newref>:<db-password>@aws-1-<region>.pooler.supabase.com:5432/postgres"
```

> Use the **session** pooler (port 5432). Hyperdrive needs prepared statements, which the transaction pooler
> (6543) disallows. (Same rule as the current `wrangler.toml` comment.)

**Capture the new Hyperdrive id** that `wrangler hyperdrive create` prints — it goes in `wrangler.toml` next.

---

## Step 7 — Edit + commit `wrangler.toml` (🔴 Joseph)

Two values are committed (not secrets), so they're code edits on the branch:

```toml
# [[hyperdrive]]
id = "<new-hyperdrive-id-from-step-6>"        # was 6612a8ac15c4450a8bcdf0fdd2a1df35

# [vars]
SUPABASE_PROJECT_URL = "https://<newref>.supabase.co"   # was https://llklxclnredhtpxmhyea.supabase.co
```

```bash
git add wrangler.toml
git commit -m "chore(cutover): repoint Hyperdrive id + SUPABASE_PROJECT_URL to fresh project"
```

> Everything else in `wrangler.toml` stays: Worker name, KV `JWKS_CACHE`, R2 buckets, queues, DO, cron,
> `CLAWTALK_ALLOWED_ORIGINS`, `APP_ORIGIN`, `GOOGLE_OAUTH_REDIRECT_URI`, `SLACK_OAUTH_REDIRECT_URI` — all are
> project-independent (keyed to the `clawtalk.app` domain or to Cloudflare resources).
>
> **Optional:** purge the `JWKS_CACHE` KV namespace after deploy — it caches the *old* project's JWKS, and a
> stale entry could briefly reject tokens minted by the new project until the cache TTL expires.

---

## Step 8 — Repoint GitHub Actions secrets (🔴 Joseph)

Repo → Settings → Secrets and variables → Actions:

| Secret | New value | Notes |
| --- | --- | --- |
| `SUPABASE_PROJECT_REF` | new project ref | used by `supabase link` in `deploy.yml` |
| `SUPABASE_DB_PASSWORD` | new DB password | used by `supabase db push` |
| `VITE_SUPABASE_URL` | `https://<newref>.supabase.co` | baked into webapp at build time |
| `VITE_SUPABASE_ANON_KEY` | new publishable key | baked into webapp **and** auto-synced to Worker `SUPABASE_PUBLISHABLE_KEY` |
| `SUPABASE_ACCESS_TOKEN` | unchanged | account-level Management API token — repoint **only** if the new project is in a different Supabase account/org |
| `CLOUDFLARE_API_TOKEN` | unchanged | Cloudflare account-scoped |

> You do **not** manually set the Worker `SUPABASE_PUBLISHABLE_KEY` secret — `deploy.yml`'s "Sync
> SUPABASE_PUBLISHABLE_KEY" step does it from `VITE_SUPABASE_ANON_KEY` on every deploy.

---

## Step 9 — Merge to `main` (🔴 Joseph) — admin-merge past red CI

```bash
# From the branch:
git push origin codex/clawtalk-greenfield-cutover
gh pr create --base main --head codex/clawtalk-greenfield-cutover \
  --title "Greenfield cutover" --body "Fresh-project cutover per docs/CUTOVER-RUNBOOK.md"
```

**CI (`ci.yml`) will be RED — by design.** It runs `format:check`, backend `tsc --noEmit`, webapp
typecheck/tests, then `supabase start` + backend `vitest run`. The **backend Tests step fails** because the
legacy accessor/google-drive tests still query dropped tables (`talks.owner_id`, `registered_agents`, …) — this
is exactly what §14 predicted (38/38 accessor + 21/30 google-drive). Webapp typecheck/tests/format should be
green.

Merge anyway (you are the only user; legacy test cleanup is part of the ongoing `src/` rewrite, not a deploy
blocker):

- **GitHub UI:** "Merge without waiting for requirements to be met (administrator)", **or** temporarily relax
  the branch-protection required-checks rule, merge, then restore it.
- Or push the branch straight to `main` (no PR → `ci.yml` doesn't gate; `deploy.yml` fires on the push).

> ⚠️ Step 7's `wrangler.toml` edit MUST be in the merged commit, or the deployed Worker connects to the **old**
> Hyperdrive/project.

---

## Step 10 — Automated deploy (⚙️ `deploy.yml` on push to `main`)

No action needed — `deploy.yml` runs:

1. `npm ci` + `npm --prefix webapp ci`
2. **Build webapp** — bakes `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` into the static bundle.
3. **Verify deploy-time secrets (W7 gate)** — **no-op** now (no `0006_*` migration). See step 5.
4. **Apply Supabase migrations** — `supabase link --project-ref $SUPABASE_PROJECT_REF` + `supabase db push
   --include-all` → applies `0001` to the fresh project from zero.
5. **Sync `SUPABASE_PUBLISHABLE_KEY`** Worker secret from `VITE_SUPABASE_ANON_KEY`.
6. **Deploy Worker** — `wrangler deploy` (ships `webapp/dist` via the `[assets]` binding).

Watch the run: `gh run watch` (or the Actions tab). If the migrate step fails, the Worker is **not** deployed
(steps are sequential), so the old Worker keeps serving — safe.

---

## Step 11 — First sign-in + bootstrap (🔴 Joseph)

1. Open https://clawtalk.app and **Sign in with Google**.
2. Behind the scenes: Supabase creates the first `auth.users` row → `on_auth_user_created` fires →
   `handle_new_auth_user()` inserts `public.users` → the app calls `ensure_user_workspace_bootstrap()` which
   seeds your `workspaces` row, `workspace_members` (owner), and the default `agents` from
   `agent_role_templates`.
3. Confirm the workspace name shows top-left and the app shell renders.

> There is intentionally **no create-workspace flow** — bootstrap creates the single workspace. The workspace
> switcher only has something to switch to once a second workspace exists (out of scope for solo dogfooding).

---

## Step 12 — Re-add provider keys + connectors (🔴 Joseph)

The fresh project's DB is empty, so all per-user/workspace secrets are gone (they were AES-encrypted blobs in
the old project's `llm_provider_secrets` / `workspace_provider_secrets` / `connector_secrets`):

- **Settings → AI Agents / Providers:** re-add Anthropic / NVIDIA / OpenAI keys (re-runs model discovery).
- **Settings → Tools → Google Account:** re-connect Google (Docs/Drive/Sheets) — `connector_secrets` was empty.
- **Slack** connector: re-OAuth if used.
- **Web Search:** re-add the provider key + pick the preferred provider if used.

> `CLAWTALK_PROVIDER_SECRET_KEY` (the AES passphrase) can stay the same — but since the **ciphertext** rows were
> wiped with the old DB, the keys themselves must be re-entered regardless.

---

## Step 13 — Smoke test + rollback (✅)

**Smoke:**

- Workspace name top-left; create a Folder + Talk.
- Add an agent to the roster; send a message; confirm an agent reply streams in (exercises
  chat → `TALK_RUN_QUEUE` → queue consumer → executor → `event_outbox` → `UserEventHub` DO → WebSocket).
- Live streaming working confirms **`DB_EVENT_HUB_URL`** (step 5) is correct.
- Create a Job and run-now; confirm it produces a run.

**Rollback (the old project is untouched):**

1. `git revert` the step-7 `wrangler.toml` commit (restore old Hyperdrive id + `SUPABASE_PROJECT_URL`).
2. Restore the GitHub secrets to the old project's ref/password/URL/anon-key.
3. Push to `main` → `deploy.yml` redeploys the Worker against the old project.
4. (Restore the old `DB_EVENT_HUB_URL` Worker secret if you overwrote it.)

Keep the legacy Supabase project around until you've confirmed several days of clean greenfield operation, then
delete it.

---

## Appendix — what changes vs. what stays

| Concern | Fresh project | Stays |
| --- | --- | --- |
| Supabase ref / URL / anon key / DB password | **new** | — |
| Hyperdrive connection + id (`wrangler.toml`) | **new** | — |
| `SUPABASE_PROJECT_URL` (`wrangler.toml [vars]`) | **new** | — |
| `DB_EVENT_HUB_URL` Worker secret | **new** (role pw + conn string) | — |
| GitHub: `SUPABASE_PROJECT_REF` / `_DB_PASSWORD` / `VITE_SUPABASE_URL` / `_ANON_KEY` | **new** | — |
| Google OAuth app + `GOOGLE_OAUTH_*` Worker secrets | — | **stays** (add new supabase.co callback) |
| `GOOGLE_PICKER_*`, `SLACK_*` Worker secrets | — | **stays** |
| `CLAWTALK_PROVIDER_SECRET_KEY` Worker secret | — | **stays** (but re-enter provider keys) |
| `SUPABASE_ACCESS_TOKEN`, `CLOUDFLARE_API_TOKEN` | — | **stays** (unless new account) |
| KV `JWKS_CACHE`, R2 buckets, Queues, DO, cron, Worker name | — | **stays** (optionally purge KV) |
| `deploy.yml` | — | **stays** (no code changes) |
