# 13 — Talk Runtime v2: Durable Object Run Execution

> **Status:** PROPOSAL — open for agent review · **Author:** Claude (session 2026-06-12, with Joseph) · **Reviewers:** any agent — see [§9 Review checklist](#9-review-checklist-for-reviewing-agents)
>
> Provenance: the 2026-06-12 wedged-run incidents (rounds 18 and 20 of talk `1343f8e1`, PRs #608/#609). This doc proposes the structural fix; #608/#609 are containment.

## 1. Problem

A user-visible agent turn ("run a web search, summarize") can take 10+ minutes or wedge a Talk entirely. Twice on 2026-06-12, a run froze mid-tool-call with the composer locked; the first froze for 24 minutes until manually cancelled, the second was provably stuck in `db.begin` — `pg_stat_activity` was **empty** while the UI showed "Running," meaning the wedge was client-side in the worker's single pooled Postgres connection, upstream of every timeout we had shipped that morning.

The deeper issue isn't any one bug. It's that **a multi-minute, streaming, external-I/O-heavy agent loop runs as one giant `await` chain inside a single stateless queue invocation, with one shared Postgres connection as the spine of everything**. In that shape, every component is load-bearing for liveness: one flaky leg anywhere (provider fetch, DB socket, anything new we add) stalls the whole run, and the only remedies are hand-placed timers. We now have **49 separate deadline/abort sites across four files** (`queue-consumer.ts` 22, `greenfield-executor.ts` 9, `new-executor.ts` 5, `llm-client.ts` 13) — that count is the diagnosis. Bounding legs one at a time is whack-a-mole; #608 bounded the fetch, then the very next incident wedged one frame up in connection acquisition.

The happy path is also slower than it should be: ~4.5s of queue hop before execution starts (run `fea9ade4`: created 15:41:57.99 → started 15:42:02.47; matches the T9 baseline note in `wrangler.toml`), full-context LLM re-sends on every tool iteration with **no prompt caching** (`cacheControl` exists only for PDF document blocks — `llm-client.ts:119,633`), and strictly **sequential tool execution** (`agent-router.ts:651`) so three 1.5s searches cost 4.5s.

## 2. Current architecture (v1, accurate as of `c633bb8`)

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
| F2 | Wedges invisible to operators | `wrangler tail` reports only **completed** invocations; `tool_result` events map to null in the outbox (`greenfield-executor.ts:~1240`); no heartbeat | Structural (partially fixed: `[observability]` + breadcrumbs, #609) |
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
| P1-a | **Anthropic prompt caching**: `cache_control: ephemeral` breakpoints on the system prompt, tool definitions, and the history prefix; subsequent tool-loop iterations then re-send only the delta at cache-read pricing/latency | `llm-client.ts` `buildAnthropicRequest` (mechanism already exists for PDF blocks — generalize placement) | Unit-test request shape; live: compare `usage.cache_read_input_tokens` > 0 on iteration 2 of a tool turn; before/after TTFT of iteration-2 calls in Workers Logs |
| P1-b | **Parallel tool execution**: `Promise.all` over a turn's tool batch | `agent-router.ts:651` loop | Existing tool tests + a new test asserting 3 mocked 100ms tools settle in ~100ms, not ~300ms; assert result ordering by tool_use id is preserved |
| P1-c | **One deadline-budget primitive**: a run-scoped `DeadlineBudget` (total + per-step caps); every external await (`executeToolCall`, LLM call wrapper, context loads) passes through `budget.bound(promise, label)`. Replaces/absorbs the ad-hoc 20s/30s/10-min timers from #608/#609 | new `talks/deadline-budget.ts`; call sites in `agent-router.ts`, `greenfield-executor.ts`, `queue-consumer.ts` | Grep gate: no bare `setTimeout`-deadline outside the primitive in `talks/`; unit tests for budget exhaustion, label propagation into the tool-error string |
| P1-d | **Isolate the cancel poller** on its own detached connection (`withDetachedDbClient`, exists since #609) so it can never queue behind a wedged run tx | `queue-consumer.ts` cancel poller | Existing cancel tests + new test: poller still observes `cancelled` while the request client is artificially held in a long tx |
| P1-e | **Client resync on contradiction** (F9): when cancel returns "no running or queued chat," the client refetches run state instead of dead-ending | `webapp` cancel mutation error path | webapp test: stale Running state + 404-ish cancel → state resyncs, composer unlocks |

Phase 1 explicitly does **not** touch F1/F3/F5 — those are architectural.

## 6. Phase 2 — `TalkRunner` Durable Object

### 6.1 Shape

One DO class, **one instance per Talk** (`idFromName(talkId)`), owning run execution for that Talk:

```
POST /chat ──► TalkRunner DO (direct invocation, no queue)
  ├─ run state machine + step log in DO SQLite storage   ◄── hot path, zero-latency, transactional
  ├─ executes the agent loop (same executor/llm-client/tool code as today)
  │    └─ every step (LLM call, tool batch) = checkpoint row before/after
  ├─ DO alarm = watchdog: armed at step start, cleared at step end;
  │    if it fires, the runtime wakes a FRESH invocation that fails/retries the step
  ├─ streams tokens to UserEventHub DO (unchanged client protocol), or directly
  │    over its own WebSocket in a later simplification
  ├─ cancel = direct RPC: instant flag + AbortController, no polling
  └─ write-behind to Postgres (system of record): intermediate state async + batched,
       terminal persist AWAITED with bounded retry before the terminal event is emitted
       (the snapshot API reads Postgres — a completed run must survive a hard refresh)
```

Postgres keeps: messages, runs (terminal truth), documents, RLS — everything user-facing reads. It stops being the *liveness spine*: a Postgres blip delays persistence, never the conversation.

### 6.2 Why this maps onto every structural failure

| v1 failure | v2 answer |
|---|---|
| F1 one-connection spine | Hot path is DO SQLite (embedded, no socket to die). Postgres is async write-behind. |
| F2 invisible wedges | Step log **is** the progress record; a `GET /debug/state` on the DO dumps the live state machine. Alarms guarantee a wedge becomes a visible failed step. |
| F3 re-pay everything | Steps checkpoint; resume re-runs at most one step. Redelivery semantics disappear with the queue. |
| F4 timer sprawl | One watchdog primitive (the alarm) owned by the runtime, not 49 timers owned by hope. Per-step budgets come from P1-c's primitive, enforced at the step boundary. |
| F5 queue hop | Direct DO invocation: dispatch in ~ms. First token ≈ TTFT + context load. |
| F8 cancel | RPC sets the abort flag in the same isolate that owns the run. |

### 6.3 Design points (recommendations; see §8 for open decisions)

- **Concurrency:** parallel-mode rounds run N agent runs concurrently *inside* the one Talk DO (I/O-bound; `Promise.all` of executor instances). DOs are single-threaded for compute but fine for concurrent awaits. Ordered mode serializes naturally.
- **Step granularity:** `step = one LLM streaming call` or `one tool batch`. Checkpoint payload: accumulated messages array (provider-shape), usage, emitted-message ids. Mid-stream token loss on crash is acceptable — resume re-runs that one LLM call.
- **Alarm protocol:** `storage.setAlarm(now + stepBudget)` at step start; `deleteAlarm` on step end. `alarm()` handler: mark step failed in SQLite, decide retry-vs-fail-run (per-step retry budget), notify hub, continue or finalize. Because alarms run in a fresh invocation, a wedged in-flight await can never block its own watchdog — this is the property v1 fundamentally cannot have.
- **Write-behind contract:** every Postgres write idempotent (upsert keyed by run/step ids, monotonic status transitions only — `running → failed` may not regress). Flush triggers: terminal state (awaited), N events or T seconds (async), DO eviction hook (best-effort; alarm sweep reconciles).
- **Scheduler/jobs:** cron `scheduler.ts` stops enqueueing to `TALK_RUN_QUEUE` and instead invokes the target Talk's DO (`runJob(jobId)`). The queue + DLQ + consumer are then **retired entirely** (engineering default: remove dead paths). The 1h sweeps shrink to a reconciliation pass over Postgres-vs-DO disagreement.
- **What carries over unchanged:** `agent-router.ts` loop, `llm-client.ts`, all tool implementations, prompt building (`greenfield-executor.ts` context assembly), outbox event *shapes*, the entire frontend protocol. What dies: `queue-consumer.ts` (claim/redelivery/watchdog scaffolding), `queue-producer.ts`, the #609 watchdog (subsumed by alarms), per-call `withUserContext` transactions for tools (tool reads go through short-lived detached connections or DO-cached context).
- **Cost/limits notes:** a DO is billed on wall-clock while awake; streaming turns keep it awake for their duration — negligible at solo-user volume. WebSocket Hibernation continues to live in UserEventHub, so TalkRunner only wakes per run. DO SQLite limits (10GB/instance) are orders of magnitude beyond per-Talk state.

### 6.4 Migration order (big-bang per greenfield norms, but staged in PRs)

1. **PR-A:** `TalkRunner` DO skeleton + SQLite schema + step log + alarm watchdog; executes a run end-to-end behind a dev-only route; reuses executor code untouched. Vitest with `@cloudflare/vitest-pool-workers` for DO unit tests (alarm firing, checkpoint resume, cancel RPC).
2. **PR-B:** write-behind layer + outbox/hub emission from the DO; prove a full streamed turn against local stack; prove hard-refresh consistency (terminal awaited).
3. **PR-C:** cut `/chat` and `/chat/cancel` over to the DO; delete the interactive queue path. Smoke on prod (Joseph click-list).
4. **PR-D:** scheduler → DO dispatch; retire queue/DLQ/consumer + #609 scaffolding; shrink sweeps to reconciliation.

Rollback story: PR-C is the cutover commit; revert = restore queue dispatch (one route file). No schema migrations required in Postgres (additive only, if any), so revert is clean.

## 7. What we got wrong (so reviewers can check the lesson, not just the fix)

1. Porting a long-lived daemon loop onto a stateless invocation without making state durable — the platform mismatch behind F1/F3/F4.
2. Letting the system-of-record database double as the liveness spine of a streaming hot path.
3. Treating timeouts as per-bug patches rather than a runtime property (49 sites and counting before #609).
4. Observability after the fact: we could not see a wedged invocation at all until `[observability]` landed mid-incident.

## 8. Open decisions for review (D1–D5)

| # | Question | Recommendation | Why it's genuinely open |
|---|----------|----------------|------------------------|
| D1 | Per-**Talk** DO vs per-**run** DO | Per-Talk | Per-run gives cleaner isolation + parallelism but explodes instance count, complicates cancel routing and ordered-round sequencing; per-Talk keeps one address per conversation. Counter-argument welcome from anyone who pokes at parallel-mode fairness. |
| D2 | Cloudflare **Agents SDK** vs hand-rolled DO | Hand-rolled, following `user-event-hub.ts` patterns | SDK gives scheduling/retries/WS for free but imports framework opinions into our most load-bearing path; we already maintain a production DO. Revisit if PR-A's scaffolding exceeds ~500 LOC. |
| D3 | Cloudflare **Workflows** for scheduled jobs instead of DO dispatch | No for now | Workflows' durable steps are attractive for cron jobs, but token streaming doesn't fit, and one runtime is simpler than two. Reconsider when jobs grow long multi-step pipelines. |
| D4 | Streaming path: keep UserEventHub relay vs direct TalkRunner WebSocket | Keep relay in PR-A–D | Zero frontend changes during the risky migration; collapse to direct WS as a later simplification if the hop measurably matters. |
| D5 | Step checkpoint payload: full message array vs incremental event log | Full array per checkpoint | Simpler resume logic; size is bounded by context window anyway. Incremental wins only if checkpoints prove hot in profiling. |

## 9. Review checklist (for reviewing agents)

- [ ] Attack §6.3's write-behind contract: find a sequence where the UI shows a completed run that a hard refresh loses, or Postgres regresses a terminal status.
- [ ] Attack the alarm protocol: can a step legitimately exceed its budget (huge context + slow provider) and get falsely failed? What's the right per-step budget table (LLM step vs tool step)?
- [ ] Ordered rounds: does per-Talk serialization + checkpoint-resume preserve the ack-on-block/promotion semantics from PR #488/#494, or do those concepts disappear with the queue?
- [ ] RLS: tool DB reads currently run under `withUserContext` RLS transactions. §6.3 moves them to short-lived detached connections — verify every accessor the executor touches stays correctly user-scoped (see `rls-accessor-auditor` agent).
- [ ] Phase 1 lanes: confirm P1-a cache breakpoints interact correctly with per-iteration tool_result appends (cache prefix must stay byte-stable across iterations).
- [ ] Cost sanity: estimate DO wall-clock $ for a heavy day (50 multi-minute turns) vs current queue consumer.
- [ ] What does `/chat` return when the DO is mid-eviction or hits `Durable Object reset`? Define the client retry contract.

## 10. References

- Incidents + diagnosis: PRs #608, #609; memory `project_post_salon_backlog` item 0; `pg_stat_activity` discriminator technique in `reference_prod_db_query_via_management_api`.
- Code anchors: `src/clawtalk/talks/queue-consumer.ts` (v1 runtime), `src/db.ts:buildRequestPgClient` (max:1 spine), `src/clawtalk/agents/agent-router.ts:651` (sequential tools), `src/clawtalk/agents/llm-client.ts:119` (cacheControl, doc-blocks only), `src/clawtalk/talks/user-event-hub.ts` (existing DO precedent).
- Platform: Cloudflare Durable Objects (SQLite storage, alarms), Agents SDK, Workflows — verify current limits against docs at implementation time; do not trust this doc's recollection of quotas.
