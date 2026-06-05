// clawtalk db core accessors.
//
// These are the live survivors of the retired legacy `accessors.ts` (which
// held the pre-greenfield talk/folder/member/thread/message/run CRUD on
// `owner_id`-keyed tables that the greenfield cutover dropped). Everything in
// the legacy file was dead-to-runtime except these three low-level surfaces,
// all keyed to tables that still exist in the greenfield schema:
//   - `settings_kv`  (system/workspace pointers) — getSettingValue / upsertSettingValue
//   - `event_outbox` (durable event log) — append + read helpers + OutboxEvent
//   - `users.name`   (profile display name) — updateUserDisplayName
//
// Consumers: talks/outbox-emit.ts, talks/user-event-hub.ts,
// agents/execution-planner.ts, agents/agent-registry.ts (settings),
// web/routes/greenfield-api.ts (display name, via the db/index barrel),
// talks/event-filters.ts (OutboxEvent type, via the barrel).

import {
  getDbPg,
  getOutOfBandSql,
  withTrustedDbWrites,
  type Sql,
} from '../../db.js';

// ---------------------------------------------------------------------------
// event_outbox
// ---------------------------------------------------------------------------

export interface OutboxEvent {
  event_id: number;
  topic: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

/**
 * Insert one outbox row on the current `getDbPg()` connection (which
 * may be a withUserContext tx or a node-mode pooled connection).
 *
 * This is a low-level accessor. Most callers should use
 * `emitOutboxEvent` from `talks/outbox-emit.ts`, which also queues
 * the post-commit notify entry for `flushNotifyQueue`. Direct calls
 * to this function skip the W7 notify path entirely.
 */
export async function appendOutboxEvent(input: {
  topic: string;
  eventType: string;
  payload: Record<string, unknown>;
}): Promise<number> {
  const db = getDbPg();
  // event_id is bigserial → postgres.js serializes as string by default
  // (to avoid JS number-precision loss on >2^53 values). Cast to int so
  // we get a JS number back. ClawTalk's outbox throughput is nowhere
  // close to int range; revisit if that changes.
  const insert = async (sql: Sql): Promise<number> => {
    await sql`
      insert into public.event_outbox (topic, event_type, payload)
      values (${input.topic}, ${input.eventType},
              ${sql.json(input.payload as never)})
    `;
    const rows = await sql<{ event_id: number }[]>`
      select currval('public.event_outbox_event_id_seq')::int as event_id
    `;
    return rows[0]!.event_id;
  };
  const maybeTransaction = db as Sql & {
    begin?: <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>;
    savepoint?: unknown;
  };
  return withTrustedDbWrites(async () => {
    if (
      typeof maybeTransaction.savepoint === 'function' ||
      typeof maybeTransaction.begin !== 'function'
    ) {
      return insert(db);
    }
    return maybeTransaction.begin(insert);
  });
}

/**
 * Insert one outbox row on the request scope's out-of-band sql (fresh
 * auto-commit connection sibling to any surrounding tx). Used by the
 * G1 streaming-emit path so streaming events become visible to the
 * UserEventHub DO immediately, not when the run's surrounding tx
 * resolves. In Node mode, `getOutOfBandSql()` returns the module-
 * scoped client (no surrounding tx to escape there).
 */
export async function appendOutboxEventOutsideTx(input: {
  topic: string;
  eventType: string;
  payload: Record<string, unknown>;
}): Promise<number> {
  const db = getOutOfBandSql();
  const rows = await db<{ event_id: number }[]>`
    insert into public.event_outbox (topic, event_type, payload)
    values (${input.topic}, ${input.eventType},
            ${db.json(input.payload as never)})
    returning event_id::int as event_id
  `;
  return rows[0].event_id;
}

export async function getOutboxEventsForTopics(
  topics: string[],
  afterEventId: number,
  limit = 100,
): Promise<OutboxEvent[]> {
  if (topics.length === 0) return [];
  const db = getDbPg();
  return await db<OutboxEvent[]>`
    select event_id::int as event_id, topic, event_type, payload, created_at
    from public.event_outbox
    where topic in ${db(topics)} and event_id > ${afterEventId}
    order by event_id asc
    limit ${limit}
  `;
}

export async function getOutboxMinEventIdForTopics(
  topics: string[],
): Promise<number | null> {
  if (topics.length === 0) return null;
  const db = getDbPg();
  const rows = await db<{ min_event_id: number | null }[]>`
    select min(event_id)::int as min_event_id
    from public.event_outbox
    where topic in ${db(topics)}
  `;
  return rows[0]?.min_event_id ?? null;
}

export async function getOutboxMaxEventIdForTopics(
  topics: string[],
): Promise<number | null> {
  if (topics.length === 0) return null;
  const db = getDbPg();
  const rows = await db<{ max_event_id: number | null }[]>`
    select max(event_id)::int as max_event_id
    from public.event_outbox
    where topic in ${db(topics)}
  `;
  return rows[0]?.max_event_id ?? null;
}

// ---------------------------------------------------------------------------
// settings_kv
// ---------------------------------------------------------------------------

export async function getSettingValue(key: string): Promise<string | null> {
  const db = getDbPg();
  const rows = await db<{ value: string | null }[]>`
    select value from public.settings_kv where key = ${key} limit 1
  `;
  return rows[0]?.value ?? null;
}

export async function upsertSettingValue(input: {
  key: string;
  value: string | null;
  updatedBy?: string | null;
}): Promise<void> {
  await withTrustedDbWrites(async () => {
    const db = getDbPg();
    await db`
      insert into public.settings_kv (key, value, updated_by)
      values (${input.key}, ${input.value},
              ${input.updatedBy ?? null}::uuid)
      on conflict (key) do update set
        value = excluded.value,
        updated_at = now(),
        updated_by = excluded.updated_by
    `;
  });
}

// ---------------------------------------------------------------------------
// Users (public.users; auto-mirrored from auth.users via
// handle_new_auth_user trigger). RLS-gated by users_self_select policy so
// callers inside withUserContext only see their own row.
// ---------------------------------------------------------------------------

export async function updateUserDisplayName(input: {
  userId: string;
  displayName: string;
}): Promise<void> {
  const db = getDbPg();
  await db`
    update public.users
    set name = ${input.displayName}
    where id = ${input.userId}::uuid
  `;
}
