import { getDbPg, withDurableObjectScopedDb, type Sql } from '../../db.js';

export function documentEditMutationLockKey(input: {
  workspaceId: string;
  documentId: string;
}): string {
  return `document-edit-mutations:${input.workspaceId}:${input.documentId}`;
}

export async function lockDocumentEditMutationsOnSql(
  sql: Sql,
  input: {
    workspaceId: string;
    documentId: string;
  },
): Promise<void> {
  await sql`
    select pg_advisory_xact_lock(
      hashtextextended(${documentEditMutationLockKey(input)}, 0)
    )
  `;
}

export async function withDocumentEditMutationLock<T>(
  input: {
    workspaceId: string;
    documentId: string;
  },
  fn: (sql: Sql) => Promise<T>,
): Promise<T> {
  const db = getDbPg();
  const maybeTransaction = db as Sql & {
    begin?: <R>(fn: (sql: Sql) => Promise<R>) => Promise<R>;
    savepoint?: unknown;
  };
  const runLocked = async (sql: Sql): Promise<T> => {
    await lockDocumentEditMutationsOnSql(sql, input);
    return fn(sql);
  };

  if (
    typeof maybeTransaction.savepoint === 'function' ||
    typeof maybeTransaction.begin !== 'function'
  ) {
    return runLocked(db);
  }

  return (await maybeTransaction.begin(async (tx) => {
    const txSql = tx as unknown as Sql;
    return withDurableObjectScopedDb(txSql, () => runLocked(txSql));
  })) as T;
}
