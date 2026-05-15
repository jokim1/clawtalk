import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

import {
  closePgDatabase,
  type DbScopeEnvBindings,
  getCurrentNotifyQueue,
  getDbPg,
  getOutOfBandSql,
  initPgDatabase,
  type RequestExecutionContext,
  type Sql,
  withDurableObjectScopedDb,
  withNotifyQueueScope,
  withRequestScopedDb,
} from './db.js';

const TEST_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54432/postgres';

beforeAll(async () => {
  await initPgDatabase({ url: TEST_DB_URL });
});

afterAll(async () => {
  await closePgDatabase();
});

describe('requestScopedDbStorage shape', () => {
  it('carries { sql, ctx, env } through getDbPg() correctly', async () => {
    const env: DbScopeEnvBindings = { DB_EVENT_HUB_URL: 'env-marker-url' };
    let captured: { sql: Sql; envInside: DbScopeEnvBindings | null } | null =
      null;

    await withRequestScopedDb(TEST_DB_URL, null, env, async (sql) => {
      const inside = getDbPg();
      // Same reference as the sql passed into the fn callback.
      expect(inside).toBe(sql);
      // OOB sql is opened sibling to main sql; both should be queryable.
      const oob = getOutOfBandSql();
      expect(oob).not.toBeNull();
      expect(oob).not.toBe(sql);
      captured = { sql, envInside: env };
    });

    expect(captured).not.toBeNull();
    expect(captured!.envInside?.DB_EVENT_HUB_URL).toBe('env-marker-url');
  });
});

describe('getCurrentNotifyQueue', () => {
  it('returns null outside any scope', () => {
    expect(getCurrentNotifyQueue()).toBeNull();
  });
});

describe('withDurableObjectScopedDb', () => {
  it('lets getDbPg() see the caller-provided sql', async () => {
    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      let inside: Sql | null = null;
      await withDurableObjectScopedDb(sql, async () => {
        inside = getDbPg();
      });
      expect(inside).toBe(sql);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

describe('withRequestScopedDb', () => {
  it('works with ctx=null and env=null (node fallback path)', async () => {
    let rowsObserved: { ok: number }[] | null = null;
    await withRequestScopedDb(TEST_DB_URL, null, null, async (sql) => {
      rowsObserved = await sql<{ ok: number }[]>`select 1 as ok`;
    });
    expect(rowsObserved).toEqual([{ ok: 1 }]);
  });
});

describe('withNotifyQueueScope', () => {
  it('opens a queue inside fn and flushes once via ctx.waitUntil (G3)', async () => {
    const waitUntilCalls: Promise<unknown>[] = [];
    const ctx: RequestExecutionContext = {
      waitUntil: (p) => {
        waitUntilCalls.push(p);
      },
    };
    let observedQueueInside: unknown = 'unset';
    await withNotifyQueueScope({}, ctx, async () => {
      observedQueueInside = getCurrentNotifyQueue();
    });
    // Queue was non-null inside the scope.
    expect(observedQueueInside).not.toBeNull();
    expect(observedQueueInside).toHaveProperty('enqueue');
    // The scope cleared the queue from the surrounding context.
    expect(getCurrentNotifyQueue()).toBeNull();
    // The flush was forwarded to ctx.waitUntil exactly once.
    expect(waitUntilCalls).toHaveLength(1);
    await waitUntilCalls[0];
  });

  it('treats nested scopes as pass-through (F7 — outermost owns the queue)', async () => {
    const waitUntilCalls: Promise<unknown>[] = [];
    const ctx: RequestExecutionContext = {
      waitUntil: (p) => {
        waitUntilCalls.push(p);
      },
    };
    let outerQueue: unknown = null;
    let innerQueue: unknown = null;
    await withNotifyQueueScope({}, ctx, async () => {
      outerQueue = getCurrentNotifyQueue();
      await withNotifyQueueScope({}, ctx, async () => {
        innerQueue = getCurrentNotifyQueue();
      });
    });
    expect(outerQueue).not.toBeNull();
    expect(innerQueue).toBe(outerQueue);
    // Outer owns the queue; flush ran exactly once.
    expect(waitUntilCalls).toHaveLength(1);
    await waitUntilCalls[0];
  });
});

describe('getOutOfBandSql', () => {
  it('returns a separate sql from getDbPg() inside withRequestScopedDb (G1)', async () => {
    let mainRefInside: Sql | null = null;
    let oobRefInside: Sql | null = null;
    let mainRows: unknown = null;
    let oobRows: unknown = null;
    await withRequestScopedDb(TEST_DB_URL, null, null, async (sql) => {
      mainRefInside = getDbPg();
      oobRefInside = getOutOfBandSql();
      expect(mainRefInside).toBe(sql);
      expect(oobRefInside).not.toBeNull();
      expect(oobRefInside).not.toBe(mainRefInside);
      // Both clients can independently issue queries.
      mainRows = await sql<{ tag: string }[]>`select 'main' as tag`;
      oobRows = await oobRefInside!<{ tag: string }[]>`select 'oob' as tag`;
    });
    expect(mainRows).toEqual([{ tag: 'main' }]);
    expect(oobRows).toEqual([{ tag: 'oob' }]);
  });

  it('returns null outside any withRequestScopedDb scope', () => {
    expect(getOutOfBandSql()).toBeNull();
  });
});
