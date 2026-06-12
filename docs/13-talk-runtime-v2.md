# 13 — Talk Runtime v2: Durable Object Run Execution

> **Status:** ACCEPTED, AS AMENDED — locked 2026-06-12 via `/plan-eng-review` (11 issues, 1 critical gap) plus two Codex gates; every §8 decision is resolved and the amendments are inlined below (see [§8](#8-locked-decisions-d1d5-resolved--review-amendments)). Implementation order: Wave 0 (6A queue routing + P1-0 + P1-f), then the remaining Phase 1 lanes, then Phase 2. · **Author:** Claude (session 2026-06-12, with Joseph)
>
> Provenance: the 2026-06-12 wedged-run incidents (rounds 18 and 20 of talk `1343f8e1`, PRs #608/#609). This doc proposes the structural fix; #608/#609 are containment.

## 1. Problem

A user-visible agent turn ("run a web search, summarize") can take 10+ minutes or wedge a Talk entirely. Twice on 2026-06-12, a run froze mid-tool-call with the composer locked; the first froze for 24 minutes until manually cancelled, the second was provably stuck in `db.begin` — `pg_stat_activity` was **empty** while the UI showed "Running," meaning the wedge was client-side in the worker's single pooled Postgres connection, upstream of every timeout we had shipped that morning.

**The review's biggest discovery (the eng review's one critical gap):** the diagram in §2 was wrong for the most common case. Single-run `/chat` did **not** go through the queue — a T7 latency optimization dispatched it **in-process under `ctx.waitUntil`** (`greenfield-api.ts`, via `dispatch-in-process.ts`), which Cloudflare kills **~30 seconds** after the 202 response. The #609 run watchdog lived in that same isolate, so it died with the run it was meant to guard — single-agent tool turns longer than ~30s wedged silently with no surviving timer, until the 1h sweep. Both 2026-06-12 incidents froze within the ceiling window. Resolution **6A** (Wave 0, T1): the bypass and `dispatch-in-process.ts` are deleted and every run — single-run included — dispatches through `TALK_RUN_QUEUE`, where invocations have no 30s ceiling and the #609 watchdog is real for all turns. This re-accepts the ~4.5s dispatch hop until Phase 2's PR-C removes it structurally.

The deeper issue isn't any one bug. It's that **a multi-minute, streaming, external-I/O-heavy agent loop runs as one giant `await` chain inside a single stateless queue invocation, with one shared Postgres connection as the spine of everything**. In that shape, every component is load-bearing for liveness: one flaky leg anywhere (provider fetch, DB socket, anything new we add) stalls the whole run, and the only remedies are hand-placed timers. We now have **49 separate deadline/abort sites across four files** (`queue-consumer.ts` 22, `greenfield-executor.ts` 9, `new-executor.ts` 5, `llm-client.ts` 13) — that count is the diagnosis. Bounding legs one at a time is whack-a-mole; #608 bounded the fetch, then the very next incident wedged one frame up in connection acquisition.

The happy path is also slower than it should be: ~4.5s of queue hop before execution starts (run `fea9ade4`: created 15:41:57.99 → started 15:42:02.47; matches the T9 baseline note in `wrangler.toml`), full-context LLM re-sends on every tool iteration with **no prompt caching** (`cacheControl` exists only for PDF document blocks — `llm-client.ts:119,633`), and strictly **sequential tool execution** (`agent-router.ts:651`) so three 1.5s searches cost 4.5s.

## 2. Current architecture (v1, accurate as of `c633bb8` **plus amendment 6A**)

> Correction (2026-06-12 review): as written at `c633bb8` this diagram held only for multi-run sends — single-run `/chat` took the T7 in-process bypass described in §1. Amendment 6A deleted the bypass, so the diagram below is accurate again for **all** sends.

```
POST /chat ──► TALK_RUN_QUEUE (CF Queues, max_batch_size=1) ── ~4.5s ──►
queue consumer invocation (src/clawtalk/talks/queue-consumer.ts)
  ├─ withRequestScopedDb: postgres.js client, max:1, via Hyperdrive ◄── THE SPINE
  ├─ claim run row → load context (history/sources/docs)        [same connection]
  ├─ agent-router loop: ≤10 iterations
  │    ├─ streamLlmResponse (20–300s, has TTFT/idle/absolute timeouts)
  │    └─ tools, SEQUENTIALLY; web_search opens a per-call tx    [same connection]
  ├─ streaming events → outbox INSERT + UserEventHub DO notify   [out-of-band conn]
  ├─ cancel = poll runs.status every 500ms                       [same connection]
  └─ completion persisted transactionally                        [same connection]
Recovery: CF redelivery (3×, re-runs the WHOLE turn) · 10-min watchdog (#609) · 1h cron sweep
```

This is a lift-and-shift of the old Node polling worker (`run-worker.ts:executeRun`, see the header comment in `queue-consumer.ts`) onto serverless. The run's progress — which iteration, which tools returned, partial text — lives only in invocation memory.

## 3. Failure & latency inventory

| # | Symptom | Root cause | Class |
|---|---------|-----------|-------|
| F1 | Round wedges "Running" for 24–54 min, composer locked (2× on 2026-06-12) | Unbounded await on the max:1 connection (`db.ts:buildRequestPgClient`); everything queues behind it, including the cancel poller meant to rescue it | Structural |
| F2 | Wedges invisible to operators | `wrangler tail` reports only **completed** invocations; `tool_result` events map to null in the outbox (`greenfield-executor.ts:~1240` — **P1-f closes this**); no heartbeat | Structural (partially fixed: `[observability]` + breadcrumbs, #609; tool_result visibility via P1-f) |
| F3 | Failure recovery re-pays the entire turn | No durable checkpoints — redelivery restarts from scratch, so the consumer must never die, which conflicts with failing fast | Structural |
| F4 | Timeout sprawl, every new leg re-introduces wedge risk | Deadlines are hand-placed per-leg (49 sites) instead of enforced at one chokepoint | Structural |
| F5 | ~4.5s dead air before any token | CF Queues hop for an interactive request | Latency |
| F6 | Tool rounds cost N× provider TTFT + full-context input | No Anthropic prompt caching on system/history/tools; iterations 2–10 re-pay everything | Latency |
| F7 | Multi-search turns 3× slower than needed | Sequential tool execution in `agent-router.ts` | Latency |
| F8 | Cancel takes ≥500ms and can starve entirely (F1) | Poll-based cancellation on the shared connection | Structural |
| F9 | Stale-UI traps (cancel says "no running chat" while pill shows Running) | Terminal state changes are only propagated if the exact event emit succeeds; client never resyncs on contradiction | Robustness (backlog item g) |

## 4. Goals / non-goals

**Goals**
1. First streamed token of a turn in **< 2s p50** after send (from ~6–10s).
2. **No single I/O failure can wedge a run.** Worst case for any leg: one bounded, retried *step*, with the failure narrated in the UI.
3. Crash/wedge recovery resumes from the last completed step, never re-pays prior LLM calls.
4. Cancellation is instant and unconditional.
5. New tools/legs are bounded **by construction**, not by remembering to add a timer.

**Non-goals**
- Multi-region, multi-tenant scale-out (solo-user product; per engineering defaults we optimize for long-term architecture, not hypothetical load).
- Preserving the v1 queue-consumer path once v2 lands (greenfield norms: no old+new in parallel).
- Changing prompts, agents, tools, or product behavior — this is a runtime swap.

## 5. Phase 1 — responsiveness inside v1 (independent lanes, no migration)

Each lane is shippable alone, survives Phase 2 (these all live in code Phase 2 reuses), and has a concrete verification.

| Lane | Change | Where | Verify |
|------|--------|-------|--------|
| **P1-0** (Wave 0, Codex round 1) | **web_search transaction split**: resolve provider + decrypted key in a **short `withUserContext` tx → commit → fetch outside any tx**. A hung provider fetch can then never hold the run's max:1 connection / an open transaction | `web-search/registry.ts` (resolution), `talks/new-executor.ts` `executeWebSearch`, `talks/greenfield-executor.ts` (drop the per-call tx wrapper around the fetch) | Regression test: hung fetch ⇏ blocked run persistence (concurrent DB write completes while the fetch hangs); fetch-fails-after-commit → tool error, not run failure |
| P1-a | **Anthropic prompt caching**: `cache_control: ephemeral` breakpoints on the system prompt, tool definitions, and the history prefix; subsequent tool-loop iterations then re-send only the delta at cache-read pricing/latency. **Gated on a prefix-stability test (10b): byte-identical prefixes across iterations; live `cache_read_input_tokens > 0` asserted on a NON-forced turn** (doc-edit turns flip `tool_choice` and eat one expected miss) | `llm-client.ts` `buildAnthropicRequest` (mechanism already exists for PDF blocks — generalize placement) | Unit-test request shape; live: compare `usage.cache_read_input_tokens` > 0 on iteration 2 of a non-forced tool turn; before/after TTFT of iteration-2 calls in Workers Logs |
| P1-b | **Parallel tool execution — read-only tools only (10a)**: partition a turn's tool batch by a **single explicit registry of read-only flags; tools absent from the registry default to SEQUENTIAL** (no name/family inference). `Promise.all` the reads, run writes sequentially, preserve result ordering by tool_use id | `agent-router.ts:651` loop + a read-only registry | Existing tool tests + a new test asserting 3 mocked 100ms read-only tools settle in ~100ms, not ~300ms; side-effect tool ordering test; unknown-tool-defaults-sequential test |
| P1-c | **One deadline-budget primitive**: a run-scoped `DeadlineBudget` (total + per-step caps); every external await (`executeToolCall`, LLM call wrapper, context loads) passes through `budget.bound(promise, label)`. Absorbs the ad-hoc 20s (#608) and 30s tool-call (#609) timers. **Rails (10c): DB-owning work is bounded via abort/statement_timeout/alarm — `Promise.race` is forbidden for it** (the #609 COMMIT-wedge trap). **Sanctioned exception: the queue-consumer 10-min run watchdog (`queue-consumer.ts`) is NOT absorbed — it remains as the detached-fail escape hatch until PR-D retires the queue path** (safe: it never touches the wedged connection) | new `talks/deadline-budget.ts`; call sites in `agent-router.ts`, `greenfield-executor.ts`, `queue-consumer.ts` | Grep gate: no bare `setTimeout`-deadline outside the primitive in `talks/` EXCEPT the run-watchdog site; unit tests for budget exhaustion, label propagation into the tool-error string |
| P1-d | **Isolate the cancel poller** on its own detached connection (`withDetachedDbClient`, exists since #609) so it can never queue behind a wedged run tx | `queue-consumer.ts` cancel poller | Existing cancel tests + new test: poller still observes `cancelled` while the request client is artificially held in a long tx |
| P1-e | **Client resync on contradiction** (F9): when cancel returns "no running or queued chat," the client refetches run state instead of dead-ending | `webapp` cancel mutation error path | webapp test: stale Running state + 404-ish cancel → state resyncs, composer unlocks |
| **P1-f** (Wave 0, Codex round 1) | **`tool_result` outbox events**: name, ~500-char-truncated result, `isError`, `durationMs`. `tool_result` previously mapped to **null** in `mapExecutionEvent` — invisible tool outcomes blinded wedge diagnosis twice on 2026-06-12 | `talks/executor.ts` (event union), `talks/greenfield-executor.ts` `mapExecutionEvent`, webapp stream parser + reducer (render optional) | Mapping unit tests (truncation, isError/durationMs passthrough); stream-parser test dispatches the new frame; events visible in `event_outbox` on a live tool turn |

Phase 1 explicitly does **not** touch F1/F3/F5 — those are architectural. (6A — Wave 0's queue rerouting of single-run `/chat`, see §1 — rides ahead of all Phase 1 lanes as pure containment.)

## 6. Phase 2 — `TalkRunner` Durable Object

### 6.1 Shape (amended per 9A — Postgres acceptance + TalkRunner coordination)

One DO class, **one instance per Talk** (`idFromName(talkId)`), owning run execution for that Talk. **`/chat` keeps its existing acceptance transaction byte-for-byte** (message insert + `runs` rows + queued event + idempotency cache); only the dispatch call changes — `TalkRunner.start(runIds)` replaces the queue send, so the cutover diff is ≈ one dispatch call:

```
POST /chat ──► acceptance tx in Postgres (UNCHANGED: message + runs rows + queued event)
          └──► TalkRunner.start(runIds)   (direct DO invocation, no queue)
  ├─ run state machine + step log in DO SQLite storage   ◄── hot path, zero-latency, transactional
  ├─ executes the agent loop (same executor/llm-client/tool code as today)
  │    └─ every step (LLM call, tool batch) = checkpoint row before/after
  ├─ DO alarm = watchdog (min-deadline table, see §6.3): armed per in-flight step;
  │    if it fires, the runtime wakes a FRESH invocation that fails/retries the step
  ├─ streams tokens to UserEventHub DO (unchanged client protocol), or directly
  │    over its own WebSocket in a later simplification
  ├─ cancel = direct RPC: instant flag + AbortController, no polling
  └─ write-behind to Postgres for run/message state (system of record): async + batched,
       terminal persist AWAITED with bounded retry before the terminal event is emitted
       (the snapshot API reads Postgres — a completed run must survive a hard refresh)
```

Postgres keeps: messages, runs (terminal truth), documents, RLS — everything user-facing reads. It stops being the *liveness spine*: a Postgres blip delays persistence, never the conversation. A **reconciliation cron** replaces today's sweeps: it flags `queued`/`running` rows in Postgres whose DO state disagrees, so DO/PG divergence is bounded and visible.

### 6.2 Why this maps onto every structural failure

| v1 failure | v2 answer |
|---|---|
| F1 one-connection spine | Hot path is DO SQLite (embedded, no socket to die). Postgres is async write-behind. |
| F2 invisible wedges | Step log **is** the progress record; a `GET /debug/state` on the DO dumps the live state machine. Alarms guarantee a wedge becomes a visible failed step. |
| F3 re-pay everything | Steps checkpoint; resume re-runs at most one step. Redelivery semantics disappear with the queue. |
| F4 timer sprawl | One watchdog primitive (the alarm) owned by the runtime, not 49 timers owned by hope. Per-step budgets come from P1-c's primitive, enforced at the step boundary. |
| F5 queue hop | Direct DO invocation: dispatch in ~ms. First token ≈ TTFT + context load. |
| F8 cancel | RPC sets the abort flag in the same isolate that owns the run. |

### 6.3 Design points (amended per the locked decisions — see §8)

- **Concurrency:** parallel-mode rounds run N agent runs concurrently *inside* the one Talk DO (I/O-bound; `Promise.all` of executor instances). DOs are single-threaded for compute but fine for concurrent awaits. Ordered mode serializes naturally.
- **Step granularity & checkpoints (8A — D5 overturned):** `step = one LLM streaming call` or `one tool batch`. Checkpoint payload is **reference-based**: text/structure plus **R2 keys for binary blocks** (PDF pages, images), rehydrated on resume via the existing `loadPageImage`/attachment-storage path. **Hard assert: serialized checkpoint < 1MB**, tested with a multi-page-PDF fixture (DO SQLite has a 2MB value cap — a full provider-shape message array with inlined images blows it). Mid-stream token loss on crash is acceptable — resume re-runs that one LLM call.
- **Alarm protocol (1A — min-deadline table):** a DO has **one** alarm slot, and in-DO concurrency means several steps can be in flight; naive `setAlarm`/`deleteAlarm` per step collides. Instead: a SQLite `step_deadlines` table; the single alarm always targets the **earliest** in-flight deadline; `alarm()` fails every expired step, then re-arms to the next-earliest. Because alarms run in a fresh invocation, a wedged in-flight await can never block its own watchdog — the property v1 fundamentally cannot have.
- **Tool reads keep RLS (2A):** tools keep their **`withUserContext` RLS transactions** — short-lived, per-call, bounded by the step alarm. No privileged detached reads for tools (an earlier draft of this section proposed detached connections; the review rejected that as an RLS regression).
- **Restart recovery (4A):** DO startup (`blockConcurrencyWhile`) scans for in-flight steps and resumes immediately; the alarm remains the backstop. Startup and alarm share **one idempotent resume function**.
- **Event replay (3A):** streamed events keep today's **insert-before-push** invariant (`outbox-emit.ts`). Write-behind batching applies **only to run/message state**; terminal persists are awaited. Replay stays gap-free; zero frontend changes.
- **Write-behind contract:** every Postgres write idempotent (upsert keyed by run/step ids, monotonic status transitions only — `running → failed` may not regress). Flush triggers: terminal state (awaited), N events or T seconds (async), DO eviction hook (best-effort; reconciliation cron backstops).
- **Scheduler/jobs:** cron `scheduler.ts` stops enqueueing to `TALK_RUN_QUEUE` and instead invokes the target Talk's DO (`runJob(jobId)`). The queue + DLQ + consumer are then **retired entirely** (engineering default: remove dead paths). The 1h sweeps shrink to a reconciliation pass over Postgres-vs-DO disagreement.
- **What carries over unchanged:** `agent-router.ts` loop, `llm-client.ts`, all tool implementations, prompt building (`greenfield-executor.ts` context assembly), outbox event *shapes*, the entire frontend protocol, per-call `withUserContext` tool transactions (2A). What dies: `queue-consumer.ts` (claim/redelivery/watchdog scaffolding), `queue-producer.ts`, the #609 watchdog (subsumed by alarms — and only at PR-D; see §5 P1-c).
- **Cost/limits notes:** a DO is billed on wall-clock while awake; streaming turns keep it awake for their duration — negligible at solo-user volume. WebSocket Hibernation continues to live in UserEventHub, so TalkRunner only wakes per run. DO SQLite limits (10GB/instance) are orders of magnitude beyond per-Talk state.

### 6.4 Migration order (big-bang per greenfield norms, but staged in PRs)

1. **PR-A:** `TalkRunner` DO skeleton — SQLite schema, step log, **min-deadline alarm table (1A)**, **startup resume (4A)**, cancel RPC, and **stale-attempt fencing**: every post-await checkpoint, event emission, and terminal write CAS-guards on `(run_id, step idx, attempt, status='running')`, so an abandoned attempt that resolves after the alarm already retried it can write nothing (the durable analog of #609's `runAbandoned` guard). Executes a run end-to-end behind a dev-only route; reuses executor code untouched. Vitest with `@cloudflare/vitest-pool-workers` (alarm under N concurrent steps; checkpoint resume; the 8A <1MB size assert; fencing test: attempt 1 times out → attempt 2 starts → attempt 1 resolves late → zero stale writes). **SDK tripwire (5C) is checked here:** if the scaffolding (state machine + alarm table + resume) exceeds ~500 LOC or reimplements a third Agents-SDK feature, STOP and run a 1-day SDK spike before continuing.
2. **PR-B:** write-behind layer + outbox/hub emission from the DO (3A insert-before-push); prove a full streamed turn against local stack; prove hard-refresh consistency (terminal awaited); reconciliation-cron fixture.
3. **PR-C:** per 9A, `/chat` and `/chat/cancel` keep their acceptance transactions; dispatch flips to `TalkRunner.start(runIds)`; delete the interactive queue path. Smoke on prod (Joseph click-list).
4. **PR-D:** scheduler → DO dispatch; retire queue/DLQ/consumer + #609 watchdog scaffolding (the P1-c sanctioned exception ends here); shrink sweeps to reconciliation.

Rollback story: PR-C is the cutover commit; revert = restore queue dispatch (one route file). No schema migrations required in Postgres (additive only, if any), so revert is clean.

## 7. What we got wrong (so reviewers can check the lesson, not just the fix)

1. Porting a long-lived daemon loop onto a stateless invocation without making state durable — the platform mismatch behind F1/F3/F4.
2. Letting the system-of-record database double as the liveness spine of a streaming hot path.
3. Treating timeouts as per-bug patches rather than a runtime property (49 sites and counting before #609).
4. Observability after the fact: we could not see a wedged invocation at all until `[observability]` landed mid-incident.

## 8. Locked decisions (D1–D5 resolved + review amendments)

All decisions were resolved 2026-06-12 by `/plan-eng-review` (full two-phase scope) plus two Codex gates; none auto-applied — each carries an explicit user decision.

**Original open decisions, resolved:**

| # | Question | Resolution |
|---|----------|------------|
| D1 | Per-**Talk** DO vs per-**run** DO | **Per-Talk**, as recommended (`idFromName(talkId)`). |
| D2 | Cloudflare **Agents SDK** vs hand-rolled DO | **Hand-rolled per `user-event-hub.ts` patterns, with a tripwire (5C):** if PR-A scaffolding (state machine + alarm table + resume) exceeds ~500 LOC or reimplements a third Agents-SDK feature, STOP and run a 1-day SDK spike before continuing. |
| D3 | Cloudflare **Workflows** for scheduled jobs | **No** — one runtime is simpler; revisit if jobs become multi-step pipelines. |
| D4 | UserEventHub relay vs direct TalkRunner WebSocket | **Keep the relay through PR-D**; collapse later only if the hop measurably matters. |
| D5 | Checkpoint payload: full message array vs incremental log | **OVERTURNED (8A)** — neither as framed: **reference-based checkpoints** (text/structure + R2 keys for binary blocks, rehydrated via `loadPageImage`/attachment-storage), because a full provider-shape array with inlined PDF pages/images can exceed the DO SQLite 2MB value cap. Hard assert serialized checkpoint < 1MB with a multi-page-PDF fixture. |

**Review amendments (the locked-decisions table from the implementation plan):**

| # | Decision | Resolution |
|---|----------|------------|
| 1A | Alarm protocol | **Min-deadline table**: SQLite `step_deadlines`; the single DO alarm always targets the earliest in-flight deadline; `alarm()` fails expired steps, re-arms to next. Fixes the one-alarm-slot collision under in-DO concurrency. |
| 2A | Tool-read RLS | Tools keep `withUserContext` RLS transactions (short-lived, per-call); the step alarm bounds them. No privileged detached reads for tools. |
| 3A | Event replay | Streamed events keep **insert-before-push** (today's `outbox-emit.ts` invariant). Write-behind batching applies only to run/message state; terminal persist awaited. Replay stays gap-free; zero frontend changes. |
| 4A | Restart recovery | DO startup (`blockConcurrencyWhile`) scans for in-flight steps and resumes immediately; alarm remains backstop. Shares one idempotent resume function with the alarm path. |
| 5C | D2 tripwire | Hand-roll with the ~500 LOC / third-SDK-feature stop-and-spike tripwire (see D2 above). |
| 6A | **30s ceiling (the review's P0)** | Route single-run `/chat` through the queue NOW: delete `dispatchRunInProcess` + the T7 bypass. Queue invocations have no 30s ceiling; the #609 watchdog becomes real for all turns. Accepts ~4.5s dispatch latency until PR-C removes it. |
| 7 | Codex containment | Both added to Phase 1 Wave 0: **P1-0** web_search tx split and **P1-f** tool_result outbox events (see §5). |
| 8A | D5 overturned | Reference-based checkpoints + <1MB assert (see D5 above). |
| 9A | Phase 2 shape | **Postgres acceptance + TalkRunner coordination**: `/chat` keeps its acceptance tx; `TalkRunner.start(runIds)` replaces dispatch; DO owns steps/cancel/heartbeat/resume; Postgres stays terminal truth; reconciliation cron flags disagreement. Cutover diff ≈ one dispatch call. |
| 10 | Lane rails | (a) P1-b parallelizes read-only tools only, via a single explicit registry, default-SEQUENTIAL for unlisted tools. (b) P1-a gated on a prefix-stability test + live cache-read assert on a non-forced turn. (c) DeadlineBudget bounds DB-owning work via abort/statement_timeout/alarm — `Promise.race` forbidden for it; sanctioned exception: the queue-consumer run watchdog until PR-D. |
| 11 | Codex final gate | All four absorbed: P1-c watchdog carve-out, stale-attempt fencing in PR-A, the `tool_result` event-union spec, and the read-only registry with default-sequential. |

## 9. Review checklist (for reviewing agents)

- [ ] Attack §6.3's write-behind contract: find a sequence where the UI shows a completed run that a hard refresh loses, or Postgres regresses a terminal status.
- [ ] Attack the alarm protocol: can a step legitimately exceed its budget (huge context + slow provider) and get falsely failed? What's the right per-step budget table (LLM step vs tool step)?
- [ ] Ordered rounds: does per-Talk serialization + checkpoint-resume preserve the ack-on-block/promotion semantics from PR #488/#494, or do those concepts disappear with the queue?
- [ ] RLS: tool DB reads keep their `withUserContext` RLS transactions (2A) — verify every accessor the executor touches stays correctly user-scoped under the DO runtime (see `rls-accessor-auditor` agent).
- [ ] Phase 1 lanes: confirm P1-a cache breakpoints interact correctly with per-iteration tool_result appends (cache prefix must stay byte-stable across iterations).
- [ ] Cost sanity: estimate DO wall-clock $ for a heavy day (50 multi-minute turns) vs current queue consumer.
- [ ] What does `/chat` return when the DO is mid-eviction or hits `Durable Object reset`? Define the client retry contract.

## 10. References

- Incidents + diagnosis: PRs #608, #609; memory `project_post_salon_backlog` item 0; `pg_stat_activity` discriminator technique in `reference_prod_db_query_via_management_api`.
- Code anchors: `src/clawtalk/talks/queue-consumer.ts` (v1 runtime), `src/db.ts:buildRequestPgClient` (max:1 spine), `src/clawtalk/agents/agent-router.ts:651` (sequential tools), `src/clawtalk/agents/llm-client.ts:119` (cacheControl, doc-blocks only), `src/clawtalk/talks/user-event-hub.ts` (existing DO precedent).
- Platform: Cloudflare Durable Objects (SQLite storage, alarms), Agents SDK, Workflows — verify current limits against docs at implementation time; do not trust this doc's recollection of quotas.
