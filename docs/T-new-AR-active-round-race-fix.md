# T-new-AR — active-round race fix (`enqueueTalkTurnAtomic` + `runTalkJob`)

**Status:** Plan, **r1 draft**.
**Tracking:** [[project-llm-turn-latency]] (correctness branch — same bug surface, different lens). Carry-over from T-new-A2 codex C-H2 ("Active-round race is preserved by Option A — documented out of scope").
**Branch (planning):** `docs/t-new-ar-plan` (this doc).
**Branch (implementation, to be created):** `feature/t-new-ar-active-round-race-fix`.
**Estimated effort:** ~3 h human / ~30 min CC. (Smaller than T-new-A2 — no measurement gate, single structural change to two callers.)

---

## 1. Context

T-new-A2 r3 §5 documented this race explicitly:

> Existing active-round race (codex C-H2) is preserved. Lines 2265-2274 today: SELECT count then INSERT — two concurrent /chat requests on the same thread can both observe zero active runs and both succeed. **Out of scope.** Fix is a tx-level advisory lock or a partial unique index, both of which need their own design plan.

This is that plan. The race shipped in T-new-A2's diff exactly because Option A only changed the read shape, not the read-then-write atomicity. The window between the `loadEnqueueTurnContext` SELECT and the per-agent `createTalkRun` INSERTs is wide enough (~250 ms — the agent loop dominates) that concurrent /chat or scheduler-triggered jobs can both clear the `activeCount = 0` gate.

---

## 2. The cost — concrete race scenarios

### 2.1 Scenario A: two concurrent /chat requests on the same thread

| Time | Worker instance A | Worker instance B | Thread state |
|---|---|---|---|
| t=0 | `loadEnqueueTurnContext` → activeCount=0 | — | 0 active runs |
| t=10 ms | — | `loadEnqueueTurnContext` → activeCount=0 | 0 active runs |
| t=300 ms | `createTalkMessage` + 3× `createTalkRun` → 3 runs queued | — | 3 active runs |
| t=320 ms | — | `createTalkMessage` + 3× `createTalkRun` → 3 more queued | **6 active runs (BUG)** |

Both calls return 202 to the client; the SPA renders two response groups; the queue consumer dispatches all 6 runs; UserEventHub DO sees two concurrent streaming groups for the same thread; `sequence_index` ordering is violated across groups.

### 2.2 Scenario B: scheduler-triggered job races with /chat

`runTalkJob` (`src/clawtalk/db/job-accessors.ts:921`) gates only on `job_id`, NOT on `(talk_id, thread_id)`:

```sql
select count(*) from public.talk_runs
where job_id = ${job.id}::uuid
  and status in ('queued', 'running', 'awaiting_confirmation')
```

So a scheduler tick (`schedule: * * * * *` per `wrangler deploy` cron) that fires a job on thread T concurrently with a user `/chat` on T:

| Time | Scheduler → `runTalkJob` | /chat → `enqueueTalkTurnAtomic` | Thread T |
|---|---|---|---|
| t=0 | job_id check → 0 active for THIS JOB | — | 0 active |
| t=20 ms | — | `loadEnqueueTurnContext` → activeCount=0 | 0 active |
| t=200 ms | `createTalkRun` (job's run) | — | 1 active |
| t=400 ms | — | 3× `createTalkRun` (user's group) | **4 active (BUG)** |

This one is more realistic: the scheduler runs every minute, so any /chat issued during a job-triggered tick window can race.

### 2.3 Real-world likelihood for clawtalk

Joseph is the sole user, BUT:

- Cloudflare Workers are stateless — each request gets a fresh isolate, no per-thread mutex possible at the app layer.
- The scheduler runs `* * * * *` (every minute) and triggers any due jobs.
- T-new-B's UserEventHub DO is per-USER, not per-thread — concurrent rounds on the same thread share a DO and stream interleaved.

A solo user can trigger this by: enabling a recurring job on a thread, then typing into that thread when the scheduler fires. Today this races; the bug fires with low probability but real consequences.

### 2.4 Downstream consequences (what the bug actually breaks)

- **Sequence index invariants**: `sequence_index` is only unique within a `response_group_id`. Across response groups, queued runs with overlapping seq values exist. The queue consumer's promote-next logic (T7's `dispatch-in-process.ts` + `claimQueuedTalkRuns`) doesn't gate across response groups.
- **UserEventHub DO ordering**: two response groups stream `talk_response_started`/`delta`/`completed` events interleaved on the same WebSocket. The SPA renders both, but message ordering inside each group becomes inconsistent.
- **active_tool_families_snapshot drift**: each call snapshots `talks.active_tool_families_json` independently. If the user toggles a tool chip between the two calls, the two groups run with different tool sets — invisible to the user.
- **Idempotency cache pollution**: `enqueueTalkTurnAtomic`'s `idempotencyKey` is per-call. Two racing calls with different keys write two cache entries; future retries can hit either.

---

## 3. Options

### 3.1 Option 1 — Postgres advisory lock scoped to (talk_id, thread_id)

Add at the start of `enqueueTalkTurnAtomic` and `runTalkJob`:

```sql
select pg_advisory_xact_lock(
  hashtextextended(${talkId} || ':' || ${threadId}, 0)
)
```

`pg_advisory_xact_lock` is automatically released at tx end (commit or rollback). Concurrent callers asking for the same lock key block until the first tx ends. Then the second tx re-reads, sees `activeCount > 0`, and throws `TalkActiveRoundError`.

**Pros:**
- No schema change, no migration.
- Explicit "this is a race-protection lock" intent in the SQL.
- Doesn't lock any real catalog or user-data row.

**Cons:**
- Hash collisions are possible (two different `(talk_id, thread_id)` pairs hashing to the same int8 — astronomically unlikely with `hashtextextended` but non-zero).
- One extra round-trip per call.
- Easy to forget on a new caller — no DB-level enforcement.

### 3.2 Option 2 — Partial unique index on `talk_runs` (REJECTED)

Naive shape:
```sql
create unique index talk_runs_one_active_per_thread
  on public.talk_runs (talk_id, thread_id)
  where status in ('queued', 'running', 'awaiting_confirmation');
```

This **fails on fan-out**: `enqueueTalkTurnAtomic` legitimately INSERTs N rows in one tx (one per agent in the response group), all with the same `(talk_id, thread_id)` and status `'queued'`. The second INSERT in a single tx would violate the unique constraint. `DEFERRABLE INITIALLY DEFERRED` doesn't help — the constraint check at commit still sees N rows.

Refined shape — include `response_group_id`:
```sql
create unique index talk_runs_one_active_group_per_thread
  on public.talk_runs (talk_id, thread_id, response_group_id)
  where status in ('queued', 'running', 'awaiting_confirmation');
```

Also fails — same response_group still produces N rows with the same key tuple.

No natural per-row index encodes the "at most one active response_group per thread" invariant. Eliminating this option.

### 3.3 Option 3 — `SELECT ... FOR UPDATE OF th` on `talk_threads` (RECOMMENDED)

Add `for update of th` to the existing `loadEnqueueTurnContext` helper:

```sql
select
  tk.active_tool_families_json,
  th.title,
  (
    select count(*)::int from public.talk_runs
    where talk_id = tk.id and thread_id = th.id
      and status in ('queued', 'running', 'awaiting_confirmation')
  ) as active_count
from public.talks tk
join public.talk_threads th on th.talk_id = tk.id
where tk.id = ${talkId}::uuid and th.id = ${threadId}::uuid
for update of th       -- ← new: locks the thread row for the tx
limit 1
```

The `FOR UPDATE OF th` clause locks ONLY the `talk_threads` row (alias `th`), not `talks`. The locked row is the natural per-thread mutex.

For `runTalkJob`, add the same lock at the start of the job's tx. Call site:

```typescript
await getDbPg()`
  select 1 from public.talk_threads
  where id = ${job.threadId}::uuid and talk_id = ${job.talkId}::uuid
  for update
`;
```

**Pros:**
- Folds into existing helper for the /chat path — **zero extra round-trips**.
- One small `FOR UPDATE` query for the job path — same query the consumer would naturally make.
- Standard SQL, inspectable via `pg_locks` for debugging.
- The lock is on `talk_threads.id` (the natural unit of the invariant); no hash collisions possible.
- Automatic release at tx end (commit or rollback), same as advisory locks.

**Cons:**
- Locks the `talk_threads` row, which is read by many other queries. Plain `SELECT` from other txs is NOT blocked (Postgres only blocks other row-level write locks). Still, any other writer that touches the same row (e.g., `updateTalkThreadTitle`, `maybePersistTalkThreadTitleFromMessages`) will queue behind our lock.
  - In `enqueueTalkTurnAtomic` itself, `maybePersistTalkThreadTitleFromMessages` runs AFTER our FOR UPDATE — that's our own lock, so it doesn't wait.
  - Other txs writing to the same `talk_threads` row (e.g., a rename from settings) block until our tx commits. Latency impact: at most ~3 s in the pathological case where 3 agents are queued.
- The lock is acquired DURING the read, which is at the start of the function. If the caller has prior locks (e.g., a future `talks.updated_at` write), lock-order discipline matters. Today there is no such caller.

### 3.4 Why Option 3 over Option 1

Option 1 (advisory lock) is the textbook race-protection pattern. Option 3 (FOR UPDATE) is more elegant here because:

1. The /chat path's helper ALREADY reads `talk_threads` row. Adding `FOR UPDATE` is a one-clause change, zero extra round-trips.
2. The job path needs a fresh read anyway (today it reads `talk_jobs` but not `talk_threads`); same one-line add.
3. The lock is on a real row that maps 1:1 to the invariant ("at most one active round on THIS thread"). Easier to reason about than a hash.
4. Postgres' lock manager handles wait-queue ordering automatically; no extra application code.

Option 1 wins only if we expect cross-database-engine portability — clawtalk is Postgres-only. Eliminating advisory locks from the recommendation.

---

## 4. The fix — Option 3

### 4.1 What changes

1. **`src/clawtalk/db/accessors.ts` — `loadEnqueueTurnContext`**: add `for update of th` to the existing JOIN-and-subquery. Net +1 line.
2. **`src/clawtalk/db/job-accessors.ts` — `runTalkJob`**: add a `SELECT 1 FROM talk_threads WHERE id=$1 FOR UPDATE` at the start of the function, BEFORE the `job_id`-scoped active check. Also add a thread-level active check (the same one `enqueueTalkTurnAtomic` does). Net ~+15 lines.
3. **`src/clawtalk/db/accessors.test.ts`** — add 4 race tests (§7). Net ~+200 lines.
4. **`src/clawtalk/db/job-accessors.test.ts`** — add 1 race test for the job path. Net ~+50 lines.

No migration. No schema change. No new exports.

### 4.2 Why this composition

- The `FOR UPDATE` is sufficient for serialization. The thread-level active check in `runTalkJob` enforces the SAME invariant the /chat path enforces. Without it, the job path would still INSERT — the lock serializes but doesn't reject.
- The existing job-level active check (`where job_id = ...`) stays — it answers a different question ("don't start the same job twice"), independent of the thread invariant.

### 4.3 Out of scope (explicit)

- **`deleteTalkMessagesAtomic`'s `hasActiveTalkRuns` check** (accessors.ts:1334-1339) — also racy, but the failure mode is benign (a history edit completes while a fresh round just started → the edit only touches `talk_runs.trigger_message_id`, not the run's lifecycle). Documented as a separate follow-up.
- **`claimQueuedTalkRuns`** — transitions queued→running. Doesn't change active count. Not in scope.
- **Hyperdrive connection pinning** — the `FOR UPDATE` lock is tied to the tx, which is tied to one connection. Hyperdrive routes withUserContext txs to pooled connections; race-test reliability depends on each tx getting its own connection. Existing test infra (`accessors.test.ts`) uses postgres.js directly, NOT Hyperdrive — so tests will be reliable. Prod uses Hyperdrive; standard FOR UPDATE semantics apply.

### 4.4 Pre-deploy measurement

**Not applicable.** This is a correctness fix, not a perf change. The §4.5 measurement gate from T-new-A2 was about validating that an optimization actually saves time; here the only perf question is "does FOR UPDATE add measurable median latency?" — predicted ~0 ms (same query, one extra clause).

We do want a §4.5-style instrumentation if Joseph wants to confirm zero latency regression. The protocol would be: deploy instrumented build (same `[t-new-ar-meta] turn { sub_phase, elapsed_ms }` shape), run n=10 haiku bench at N=1 and N=3, compare to T-new-A2's 3520 ms baseline.

**Recommendation: SKIP §4.5 here.** The FOR UPDATE clause adds no extra round-trips and the lock is uncontended in the happy path. If post-deploy bench shows regression, we instrument then.

### 4.5 Local verification before push

```bash
npm run typecheck
npx vitest run src/clawtalk/db/accessors.test.ts
npx vitest run src/clawtalk/db/job-accessors.test.ts
npx vitest run                                      # full backend suite
npm run format:check
```

### 4.6 Post-deploy verification

- Race tests passing in CI is the primary signal — the bug was unreproducible in prod traffic, so post-deploy "the test that failed before now passes" is the verification.
- Smoke: enable a recurring job on a thread, type into that thread while the scheduler is about to fire (check `wrangler tail` for the cron tick), verify only one round actually streams.
- `wrangler tail` watch: zero `TalkActiveRoundError` exceptions during normal use. (Today these may already be zero because the race is rare; the new bug surface is "the fix throws on legit retries" — Test 3 below locks the non-regression.)

---

## 5. Risks and open questions

1. **`SELECT ... FOR UPDATE` blocks other writers of the same `talk_threads` row.** Today the only other writers are `updateTalkThreadTitle` (rare; user-initiated) and `maybePersistTalkThreadTitleFromMessages` (runs inside the same tx as our lock — no contention). Future writers must be aware: if they add a long-running `talk_threads` mutation, they could queue behind a streaming round (~3 s pathological case).
2. **Worker timeout interaction.** Cloudflare Workers have a CPU time limit (~30 s on Paid). If the lock-acquire wait exceeds the remaining budget, the worker errors. Predicted likelihood: very low (no path holds the lock more than a few hundred ms). If it ever fires, the user retries — same as a transient 503.
3. **Hyperdrive connection pool behavior under FOR UPDATE.** Hyperdrive returns connections to the pool when the tx commits/rolls back. If a worker is killed mid-tx (e.g., by CF runtime), the connection is released by Hyperdrive's timeout, releasing the lock. No "stuck lock" scenario.
4. **Test isolation.** Race tests run two concurrent `withUserContext` blocks. Each gets its own postgres.js tx. Postgres.js's pool is configured with sufficient connections for parallel txs (>= 2). Verified via the existing `enqueueTalkTurnAtomic: fans out N queued runs + outbox events` test at `accessors.test.ts:916` which does sequential ops.
5. **Deadlock potential with scheduler.** Both `enqueueTalkTurnAtomic` and `runTalkJob` lock the SAME row (`talk_threads.id`). No cross-row locking. No deadlock possible from this fix alone. If a future caller adds a second lock (e.g., on `talks.id`), lock order must match across callers.
6. **The job path's `runTalkJob` already takes a job_id-scoped check.** The new thread-level check is additive. A job that's blocked by the thread check should NOT mark itself `'blocked'` (that's a different terminal state) — it should return `{status: 'thread_busy'}` (new sentinel) or fall through to the next scheduler tick. The scheduler retries naturally; we don't need to retry inside `runTalkJob`.

---

## 6. What lands in the PR

1. `src/clawtalk/db/accessors.ts` — `loadEnqueueTurnContext`: add `for update of th`. Net +1 line.
2. `src/clawtalk/db/job-accessors.ts` — `runTalkJob`: add thread `FOR UPDATE` + thread-level active check (returns `{status: 'thread_busy', job}` if blocked). Net ~+20 lines.
3. `src/clawtalk/db/accessors.test.ts` — Tests 1-4 below. Net ~+200 lines.
4. `src/clawtalk/db/job-accessors.test.ts` — Test 5 below. Net ~+50 lines.

Net diff: ~+275 LoC (~25 src, ~250 test).

**Sequencing:**
1. Branch off main, write race tests FIRST (per §7) — confirm they fail on main.
2. Apply Option 3 fix to both callers.
3. Re-run race tests — confirm they pass.
4. Run full backend suite — zero regressions.
5. `/codex review` + `/karpathy-audit diff`. Address findings.
6. Squash-merge. Deploy. No §4.7 perf bench needed.

PR title: `fix(chat): close active-round race in enqueueTalkTurnAtomic + runTalkJob (T-new-AR)`.

---

## 7. Tests

5 tests total: 4 in `accessors.test.ts`, 1 in `job-accessors.test.ts`.

```
CODE PATHS                                            USER FLOWS
[+] enqueueTalkTurnAtomic (accessors.ts)
  ├── loadEnqueueTurnContext FOR UPDATE OF th
  │   ├── [★★★ Test 1] two concurrent /chat on same        [+] Same-thread race
  │   │   thread → exactly one succeeds, one throws         └── [★★★ Test 1]
  │   │   TalkActiveRoundError. Zero leftover active runs    serializes; one wins
  │   │   beyond the winner's N runs.
  │   ├── [★★ Test 2] two concurrent /chat on DIFFERENT    [+] Cross-thread isolation
  │   │   threads of the same talk → BOTH succeed.          └── [★★ Test 2]
  │   ├── [★★ Test 3] concurrent /chat on different talks  [+] Cross-talk isolation
  │   │   → BOTH succeed.                                   └── [★★ Test 3]
  │   └── [★★★ Test 4] /chat → retries against in-progress [+] Legit-retry non-regression
  │       (same `idempotencyKey`) — confirm still throws    └── [★★★ Test 4] TalkActiveRoundError,
  │       TalkActiveRoundError, no double-write.              not double-write
[+] runTalkJob (job-accessors.ts)
  └── thread FOR UPDATE + new thread-level active check
      └── [★★★ Test 5] /chat fires, then scheduler tries    [+] Scheduler-vs-/chat race
          to runTalkJob on same thread → job returns        └── [★★★ Test 5] thread_busy,
          {status: 'thread_busy'}, NO new run inserted.       no new run
COVERAGE: 5 tests for 2 new code paths.
QUALITY: ★★★:3 ★★:2
```

Legend: ★★★ behavior + edge + error  |  ★★ happy path

**Tests:**

- **Test 1 (★★★) — same-thread concurrent /chat.** Seed talk + thread + 2 agents. Wrap each `enqueueTalkTurnAtomic` in its own `withUserContext` block. Run via `await Promise.all([call1, call2])` (or `Promise.allSettled` if one is expected to throw). Assert exactly one resolves successfully, exactly one rejects with `TalkActiveRoundError`. SELECT `talk_runs WHERE talk_id, thread_id` — assert count = 2 (the winner's N=2 runs, not 4).
- **Test 2 (★★) — cross-thread isolation.** Seed talk + 2 threads + 1 agent. Two `enqueueTalkTurnAtomic` calls in parallel, one per thread. Assert both succeed; each thread has its own run.
- **Test 3 (★★) — cross-talk isolation.** Seed 2 talks + their default threads. Concurrent /chat on each. Both succeed.
- **Test 4 (★★★) — legit-retry non-regression.** Seed talk + thread + agent. First `enqueueTalkTurnAtomic` succeeds. Second call (with same `idempotencyKey` or just a fresh call after first commits but before its runs drain) throws `TalkActiveRoundError`. Assert no second message + no extra runs. (This locks that the FOR UPDATE doesn't accidentally allow same-tx retries.)
- **Test 5 (★★★) — scheduler-vs-/chat race.** In `job-accessors.test.ts`. Seed a job + talk + thread. /chat fires `enqueueTalkTurnAtomic` (commits, runs queued). Scheduler calls `runTalkJob` on the same thread. Assert `runTalkJob` returns `{status: 'thread_busy', job}` (new sentinel). No new run inserted. No mark on `talk_jobs.last_run_status` (the scheduler will retry on the next tick).

### 7.1 Test discipline

- Race tests require **two real txs on different connections.** Use `withUserContext` twice; postgres.js's pool returns separate connections per concurrent call. Verified by the existing test infra; `getDbPg()` returns a pooled client.
- Test 1's "exactly one succeeds, one fails" pattern: `Promise.allSettled` returns `[{status: 'fulfilled', ...}, {status: 'rejected', reason: TalkActiveRoundError}]` in some order. Assert the counts of fulfilled vs rejected, not the order.
- **Hard requirement for race tests: a real Supabase local instance.** Tests using `getDbPg()` route to `npm run db:start`'s postgres on port 54432. Mock-based tests won't reproduce the lock behavior.
- Use the existing `seedAuthUser` + `purge` helpers. No new helpers needed.

---

## 8. Failure modes (new codepaths only)

| Codepath | Realistic failure mode | Test covers? | Error handling? | User visibility? |
|---|---|---|---|---|
| `loadEnqueueTurnContext FOR UPDATE OF th` | Lock wait exceeds Worker CPU budget | No — pathological case | postgres.js raises; outer tx aborts; route catches as generic 500 | User sees error; retries |
| `loadEnqueueTurnContext FOR UPDATE OF th` | Talk/thread deleted between resolveThreadIdForTalk and the FOR UPDATE | Existing Test 2 (no-row contract) | Throws `EnqueueTurnContextNotFoundError` → 404 talk_not_found | Same as today |
| `runTalkJob thread-level FOR UPDATE + check` | Job blocked by /chat on the same thread | Test 5 | Returns `{status: 'thread_busy', job}` | None (scheduler retries) |
| `runTalkJob thread-level FOR UPDATE + check` | Lock wait under sustained burst | No — pathological | postgres.js raises; scheduler retry handles | None |

**Critical gaps:** none — all new code paths have rollback or test coverage. Pathological lock-wait timeouts are not common enough to warrant a test; the worker error path is already exercised by other timeout tests.

---

## 9. Implementation tasks

- [ ] **AR1 (P1, human: ~30 min / CC: ~15 min)** — write Tests 1-5 first (red phase). Run vitest; confirm Tests 1, 4, 5 fail on main; Tests 2, 3 pass (isolation already works).
  - Files: `accessors.test.ts`, `job-accessors.test.ts`
  - Verify: `npx vitest run src/clawtalk/db/` — Tests 1, 4, 5 fail with race-condition assertion errors

- [ ] **AR2 (P1, human: ~30 min / CC: ~10 min)** — apply Option 3 fix: `FOR UPDATE OF th` in `loadEnqueueTurnContext`; thread `FOR UPDATE` + thread-level active check in `runTalkJob` (with `{status: 'thread_busy'}` sentinel).
  - Files: `accessors.ts`, `job-accessors.ts`
  - Verify: re-run race tests; all 5 pass (green phase)

- [ ] **AR3 (P1, human: ~15 min / CC: ~5 min)** — full backend suite + format + typecheck.
  - Files: none
  - Verify: 957+ tests pass; format:check + typecheck clean

- [ ] **AR4 (P1, human: ~45 min / CC: ~15 min)** — push, `/codex review` + `/karpathy-audit diff`, absorb findings, squash-merge.
  - Files: none
  - Verify: PR green, codex PASS, karpathy PASS, deploy.yml succeeds

- [ ] **AR5 (P2, human: ~15 min)** — docs r2 footer + memory entry update.
  - Files: `docs/T-new-AR-active-round-race-fix.md` (this doc), `project_llm_turn_latency` memory.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | not run | Will run on r1 before locking design. |
| Codex Consult (plan, r1) | `/codex` consult on r1 | Independent 2nd opinion | 0 | not run | Per [[feedback-codex-review-before-locking-cf-anthropic-decisions]] — run BEFORE Joseph's AskUserQuestion answers lock the design. |
| Karpathy Audit (diff, r1) | `/karpathy-audit diff` on r1 | Style lens + four principles | 0 | not run | Will run on r1 alongside codex. |
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (correctness fix, scope self-evident) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run (backend-only) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

**VERDICT (r1):** **DRAFT — pending review.** Plan ready for Joseph's review + `/codex` consult + `/karpathy-audit diff`. Critical constraints to remember during implementation:
1. `loadEnqueueTurnContext` already throws `EnqueueTurnContextNotFoundError` on no-row — adding `FOR UPDATE OF th` does NOT change that contract.
2. `runTalkJob`'s NEW thread-level check returns `{status: 'thread_busy', job}` — a new sentinel. Scheduler retries naturally on the next tick; do NOT add app-level retry inside `runTalkJob`.
3. Tests MUST run against real Supabase local postgres; no mocks. Race semantics depend on concurrent real txs.
4. The job path's existing per-job check stays — it answers a different invariant ("don't double-fire the same job") than the new per-thread check.
5. `deleteTalkMessagesAtomic`'s `hasActiveTalkRuns` race is OUT OF SCOPE — file as a follow-up if it surfaces.
