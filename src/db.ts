// clawtalk Phase 5 — Postgres data layer.
//
// Two execution modes share this code:
//
//   Node (`tsx src/server.ts`, local dev): single module-scoped
//   postgres.js client. Connections pooled in-client. tsx is a
//   long-lived process so this is fine.
//
//   Cloudflare Workers (`src/worker.ts`): per-request client via
//   `withRequestScopedDb`. Workers' I/O isolation rejects cross-request
//   sockets, so a module-scoped client throws on the second request.
//
// Per-user routes wrap accessor segments in `withUserContext(userId, fn)`
// which opens a transaction, downgrades to the `authenticated` role, and
// binds `request.jwt.claims->>'sub'` so `auth.uid()` returns the caller's
// userId. The 0002_rls_policies.sql migration enforces per-row ownership
// through these claims.
//
// Lookup chain in `getDbPg()`: userContext (inside withUserContext) →
// requestScoped (Worker) → nodeScoped (Node). Once inside a wrapped
// block, every accessor MUST use the tx — anything else silently bypasses
// RLS via the BYPASSRLS pooled connection.
//
// W7-evtsse U1 adds three sibling ALS scopes opened inside
// `withRequestScopedDb`:
//   - `notifyQueueStorage` — drains DO RPC notifies once per request (U2).
//   - `outOfBandDbStorage` — auto-commit sql for the G1 streaming-emit
//     path (U2 writes `talk_response_delta` rows outside the run's tx).
//   - `streamingCoalesceStorage` — debounce window for G7 (U2).
// U1 declares the scopes + shapes; U2 wires producers + consumers.

import { AsyncLocalStorage } from 'node:async_hooks';

import postgres from 'postgres';

export const DATABASE_URL_ENV = 'CLAWTALK_DATABASE_URL';
const LOCAL_FALLBACK_URL =
  'postgresql://postgres:postgres@127.0.0.1:54432/postgres';

let nodeScopedDb: postgres.Sql | null = null;

export type Sql = postgres.Sql;

// ─── DB-scope env bindings (minimal subset of Env) ──────────────────────
//
// Modules running under `withRequestScopedDb` can reach Worker bindings
// via `requestScopedDbStorage.getStore()?.env`. Kept minimal so node-mode
// tests can pass `null` without faking the whole Env shape.
export interface DbScopeEnvBindings {
  DB_EVENT_HUB_URL?: string;
  USER_EVENT_HUB?: UserEventHubNamespace;
}

interface UserEventHubNamespace {
  idFromName(name: string): UserEventHubId;
  get(id: UserEventHubId): UserEventHubStub;
}
interface UserEventHubId {
  readonly __brand: 'UserEventHubId';
}
interface UserEventHubStub {
  fetch(input: Request | URL | string, init?: RequestInit): Promise<Response>;
}

// ─── Notify queue (U1 placeholder; U2 implements .flush) ────────────────
export interface NotifyEntry {
  ownerId: string;
  topic: string;
  eventId: number;
}

export interface NotifyQueue {
  enqueue(entry: NotifyEntry): void;
  flush(env: DbScopeEnvBindings | null): Promise<void>;
}

class NotifyQueueImpl implements NotifyQueue {
  private entries: NotifyEntry[] = [];

  enqueue(entry: NotifyEntry): void {
    this.entries.push(entry);
  }

  async flush(_env: DbScopeEnvBindings | null): Promise<void> {
    // U1 placeholder. U2 batches entries by ownerId and POSTs to the
    // UserEventHub DO via env.USER_EVENT_HUB.idFromName(ownerId).fetch().
    this.entries = [];
  }
}

// ─── Streaming coalescer (U1 placeholder; U2 implements .flush) ─────────
//
// U2 will replace this with the debounced coalescer described in V4 §3c
// (G7). U1 just declares the ALS scope so U2 doesn't have to revisit
// withRequestScopedDb's plumbing.
export interface StreamingCoalescer {
  enqueue(entry: NotifyEntry): void;
  flush(env: DbScopeEnvBindings | null): Promise<void>;
}

class StreamingCoalescerImpl implements StreamingCoalescer {
  enqueue(_entry: NotifyEntry): void {}
  async flush(_env: DbScopeEnvBindings | null): Promise<void> {}
}

// ─── ALS scopes ─────────────────────────────────────────────────────────

interface RequestScopedDbStore {
  sql: postgres.Sql;
  ctx: RequestExecutionContext | null;
  env: DbScopeEnvBindings | null;
}
const requestScopedDbStorage = new AsyncLocalStorage<RequestScopedDbStore>();

interface UserContextStore {
  tx: postgres.TransactionSql;
  userId: string;
}
const userContextStorage = new AsyncLocalStorage<UserContextStore>();

const notifyQueueStorage = new AsyncLocalStorage<NotifyQueue>();
const outOfBandDbStorage = new AsyncLocalStorage<postgres.Sql>();
const streamingCoalesceStorage = new AsyncLocalStorage<StreamingCoalescer>();

function resolveDatabaseUrl(override?: string): string {
  return (
    override?.trim() ||
    process.env[DATABASE_URL_ENV]?.trim() ||
    LOCAL_FALLBACK_URL
  );
}

export function getDbPg(): Sql {
  const fromUserContext = userContextStorage.getStore();
  // TransactionSql is a structural subset of Sql (no .end, no listen, etc.)
  // but exposes the tagged-template query API every accessor uses. Cast
  // is safe in practice — the missing methods aren't called inside
  // withUserContext.
  if (fromUserContext) return fromUserContext.tx as unknown as Sql;
  const fromRequest = requestScopedDbStorage.getStore();
  if (fromRequest) return fromRequest.sql;
  if (!nodeScopedDb) throw new Error('Postgres database not initialized');
  return nodeScopedDb;
}

export function getCurrentNotifyQueue(): NotifyQueue | null {
  return notifyQueueStorage.getStore() ?? null;
}

export function getOutOfBandSql(): Sql | null {
  return outOfBandDbStorage.getStore() ?? null;
}

export function getStreamingCoalescer(): StreamingCoalescer | null {
  return streamingCoalesceStorage.getStore() ?? null;
}

/**
 * Open a Postgres transaction, downgrade to `authenticated`, bind
 * `request.jwt.claims` so `auth.uid()` returns the caller's userId, and
 * run `fn` in an ALS scope where `getDbPg()` returns that transaction.
 *
 * Re-entrancy with the same userId reuses the outer transaction. Nested
 * calls with a different userId are a caller bug and throw synchronously
 * — cross-user nesting would silently leak data via the outer tx's claims.
 */
export async function withUserContext<T>(
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = userContextStorage.getStore();
  if (existing) {
    if (existing.userId !== userId) {
      throw new Error(
        `withUserContext re-entered with a different userId (outer=${existing.userId}, inner=${userId}); cross-user nesting is a caller bug`,
      );
    }
    return fn();
  }
  const db = requestScopedDbStorage.getStore()?.sql ?? nodeScopedDb;
  if (!db) throw new Error('Postgres database not initialized');
  const claims = JSON.stringify({ sub: userId, role: 'authenticated' });
  return db.begin(async (tx) => {
    await tx`set local role authenticated`;
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;
    return userContextStorage.run({ tx, userId }, fn);
  }) as Promise<T>;
}

// Node mode — call once at process boot. Idempotent.
export async function initPgDatabase(input?: { url?: string }): Promise<void> {
  if (nodeScopedDb) return;
  nodeScopedDb = postgres(resolveDatabaseUrl(input?.url), {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

export async function closePgDatabase(): Promise<void> {
  if (!nodeScopedDb) return;
  const handle = nodeScopedDb;
  nodeScopedDb = null;
  await handle.end({ timeout: 5 });
}

// Minimal slice of Cloudflare's ExecutionContext — enough for waitUntil.
// Avoids importing @cloudflare/workers-types globals into modules that
// also need @types/node DOM types.
export interface RequestExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

function buildRequestPgClient(url: string): postgres.Sql {
  return postgres(url, {
    // Hyperdrive owns the upstream pool — one client connection per
    // request is enough. fetch_types: true is required for text[]
    // column decoding (gotcha #2 in editorialroom's port: without it,
    // text[] columns return raw `'{a,b,c}'` strings instead of JS
    // arrays). +1 round-trip per cold isolate, amortized vs LLM calls.
    max: 1,
    fetch_types: true,
    idle_timeout: 5,
    connect_timeout: 10,
    // Use simple query protocol. With the extended protocol (default),
    // postgres errors mid-transaction surface as opaque "write
    // CONNECTION_CLOSED" instead of the real SQLSTATE — Hyperdrive's
    // proxy seems to reset the socket on protocol-level error
    // responses. Simple protocol returns clean ErrorResponse messages
    // with full context (22P02, 23505, etc.). Query throughput cost is
    // negligible relative to the LLM call that dominates every Talk
    // run.
    prepare: false,
  });
}

/**
 * Workers mode — wrap a per-request unit of work. Creates a fresh
 * postgres.js client (bound to this request's I/O context), opens the
 * three sibling ALS scopes (notify queue, out-of-band sql for the G1
 * streaming path, streaming coalescer for G7), runs `fn` inside the
 * full scope chain, and best-effort closes the clients after `fn`
 * resolves. If `ctx` is provided, the close is forwarded via
 * `ctx.waitUntil()`.
 *
 * `env` carries the minimal Worker-binding subset that modules under
 * this scope need (DB_EVENT_HUB_URL for the DO RPC URL, USER_EVENT_HUB
 * for the DO namespace). May be null in node-mode tests.
 */
export async function withRequestScopedDb<T>(
  url: string,
  ctx: RequestExecutionContext | null,
  env: DbScopeEnvBindings | null,
  fn: (sql: Sql) => Promise<T>,
): Promise<T> {
  const sql = buildRequestPgClient(url);
  const outOfBandSql = buildRequestPgClient(url);
  const coalescer = new StreamingCoalescerImpl();
  try {
    return await requestScopedDbStorage.run({ sql, ctx, env }, () =>
      outOfBandDbStorage.run(outOfBandSql, () =>
        streamingCoalesceStorage.run(coalescer, () => fn(sql)),
      ),
    );
  } catch (err) {
    console.error('[withRequestScopedDb] fn threw', describeError(err));
    throw err;
  } finally {
    const closeMain = sql.end({ timeout: 5 }).catch((err) => {
      console.error('[withRequestScopedDb] sql.end failed', describeError(err));
    });
    const closeOob = outOfBandSql.end({ timeout: 5 }).catch((err) => {
      console.error(
        '[withRequestScopedDb] out-of-band sql.end failed',
        describeError(err),
      );
    });
    const flushCoalescer = coalescer.flush(env).catch((err) => {
      console.error(
        '[withRequestScopedDb] streaming coalescer flush failed',
        describeError(err),
      );
    });
    const close = Promise.all([closeMain, closeOob, flushCoalescer]);
    if (ctx) {
      ctx.waitUntil(close);
    } else {
      await close;
    }
  }
}

/**
 * Durable-Object mode — accessors invoked from inside a DO see the
 * caller-supplied `sql` via `getDbPg()`. Used by the UserEventHub DO
 * for outbox SELECTs against `DB_EVENT_HUB_URL` without standing up a
 * full request scope.
 */
export async function withDurableObjectScopedDb<T>(
  sql: postgres.Sql,
  fn: () => Promise<T>,
): Promise<T> {
  return await requestScopedDbStorage.run({ sql, ctx: null, env: null }, fn);
}

/**
 * Open a per-request `NotifyQueue` for the duration of `fn`, then flush
 * it exactly once. Producers inside `fn` reach the queue via
 * `getCurrentNotifyQueue()`. The flush is forwarded to
 * `ctx.waitUntil()` when available so the HTTP response can return
 * before notifies complete; in node mode it's awaited synchronously.
 *
 * G3: the scheduler (`run-worker.processCycle`) wraps its
 * `claimQueuedTalkRuns` call in this scope so cross-user notifies
 * emitted during scheduling are batched + flushed at scope exit
 * instead of orphaning.
 */
export async function withNotifyQueueScope<T>(
  env: DbScopeEnvBindings,
  ctx: RequestExecutionContext | null,
  fn: () => Promise<T>,
): Promise<T> {
  if (notifyQueueStorage.getStore()) {
    // Re-entry: an outer scope already owns the queue. Treat this call
    // as a pass-through so nested wrappers don't double-flush (F7).
    return fn();
  }
  const queue = new NotifyQueueImpl();
  try {
    return await notifyQueueStorage.run(queue, fn);
  } finally {
    const flush = queue.flush(env).catch((err) => {
      console.error(
        '[withNotifyQueueScope] queue.flush failed',
        describeError(err),
      );
    });
    if (ctx) {
      ctx.waitUntil(flush);
    } else {
      await flush;
    }
  }
}

function describeError(err: unknown): Record<string, unknown> {
  if (!err || typeof err !== 'object') {
    return { value: String(err) };
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(err)) {
    const v = (err as Record<string, unknown>)[key];
    out[key] = typeof v === 'string' || typeof v === 'number' ? v : String(v);
  }
  if (err instanceof Error) {
    out.name = err.name;
    out.message = err.message;
    out.stack = err.stack?.split('\n').slice(0, 5).join(' | ');
  }
  return out;
}

export async function isPgDatabaseHealthy(): Promise<boolean> {
  const db =
    userContextStorage.getStore()?.tx ??
    requestScopedDbStorage.getStore()?.sql ??
    nodeScopedDb;
  if (!db) return false;
  try {
    const rows = await db`select 1 as ok`;
    return rows[0]?.ok === 1;
  } catch {
    return false;
  }
}
