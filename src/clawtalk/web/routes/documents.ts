import type { Context, Hono, MiddlewareHandler } from 'hono';

import { getDbPg, withUserContext } from '../../../db.js';
import {
  acceptAllNativeDocumentEdits,
  acceptNativeDocumentEdit,
  acceptNativeDocumentEditRun,
  createNativeDocumentForTalk,
  getNativeDocument,
  listNativeDocumentEdits,
  listNativeDocuments,
  rejectAllNativeDocumentEdits,
  rejectNativeDocumentEdit,
  rejectNativeDocumentEditRun,
  type NativeDocumentBlockRecord,
  type NativeDocumentEditRecord,
  type NativeDocumentEditStatus,
  type NativeDocumentFormat,
  type NativeDocumentRecord,
  type NativeDocumentSummaryRecord,
  type NativeDocumentTabRecord,
} from '../../documents/accessors.js';
import {
  resolveWorkspaceForUser,
  type WorkspaceSummaryRecord,
} from '../../workspaces/accessors.js';
import { validateCsrfTokenPg } from '../middleware/csrf.js';
import {
  checkRateLimit,
  type RateLimitResult,
} from '../middleware/rate-limit.js';
import type { ApiEnvelope, AuthContext } from '../types.js';

type RouteResult<T> = {
  statusCode: number;
  body: ApiEnvelope<T>;
};

type DocumentsApp = Hono<{ Variables: { auth: AuthContext } }>;
type DocumentsAuthMiddleware = MiddlewareHandler<{
  Variables: { auth: AuthContext };
}>;

type DocumentsWorkspaceContext = {
  workspace: WorkspaceSummaryRecord;
};

type DocumentsWorkspaceScope = {
  documentId?: string | null;
  talkId?: string | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EDIT_STATUSES: ReadonlySet<NativeDocumentEditStatus | 'all'> = new Set([
  'pending',
  'accepted',
  'rejected',
  'superseded',
  'all',
]);

function ok<T>(data: T, statusCode = 200): RouteResult<T> {
  return { statusCode, body: { ok: true, data } };
}

function error(
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
): RouteResult<never> {
  return {
    statusCode,
    body: { ok: false, error: { code, message, details } },
  };
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function requireWorkspaceWriter(
  workspace: WorkspaceSummaryRecord,
): RouteResult<never> | null {
  if (workspace.role !== 'guest') return null;
  return error(
    403,
    'workspace_writer_required',
    'Workspace write access is required.',
  );
}

async function withDocumentsWorkspace<T>(
  auth: AuthContext,
  requestedWorkspaceId: string | null | undefined,
  scope: DocumentsWorkspaceScope | null,
  fn: (ctx: DocumentsWorkspaceContext) => Promise<RouteResult<T>>,
): Promise<RouteResult<T>> {
  if (requestedWorkspaceId && !isUuid(requestedWorkspaceId)) {
    return error(400, 'invalid_workspace_id', 'Workspace id must be a UUID.');
  }
  if (scope?.documentId && !isUuid(scope.documentId)) {
    return error(400, 'invalid_document_id', 'Document id must be a UUID.');
  }
  if (scope?.talkId && !isUuid(scope.talkId)) {
    return error(400, 'invalid_talk_id', 'Talk id must be a UUID.');
  }

  return withUserContext(auth.userId, async () => {
    const scopedWorkspaceId =
      requestedWorkspaceId ??
      (scope?.documentId
        ? await findVisibleWorkspaceIdForDocument({
            userId: auth.userId,
            documentId: scope.documentId,
          })
        : scope?.talkId
          ? await findVisibleWorkspaceIdForTalk({
              userId: auth.userId,
              talkId: scope.talkId,
            })
          : undefined);
    const workspace = await resolveWorkspaceForUser({
      userId: auth.userId,
      requestedWorkspaceId: scopedWorkspaceId,
    });
    if (!workspace) {
      return error(
        scopedWorkspaceId ? 403 : 404,
        scopedWorkspaceId ? 'workspace_forbidden' : 'workspace_not_found',
        scopedWorkspaceId
          ? 'Workspace is not available to this user.'
          : 'No workspace exists for this user.',
      );
    }
    return fn({ workspace });
  });
}

async function findVisibleWorkspaceIdForDocument(input: {
  userId: string;
  documentId: string;
}): Promise<string | undefined> {
  const db = getDbPg();
  const rows = await db<Array<{ workspace_id: string }>>`
    select d.workspace_id
    from public.documents d
    join public.workspace_members wm
      on wm.workspace_id = d.workspace_id
     and wm.user_id = ${input.userId}::uuid
    where d.id = ${input.documentId}::uuid
    limit 1
  `;
  return rows[0]?.workspace_id;
}

async function findVisibleWorkspaceIdForTalk(input: {
  userId: string;
  talkId: string;
}): Promise<string | undefined> {
  const db = getDbPg();
  const rows = await db<Array<{ workspace_id: string }>>`
    select t.workspace_id
    from public.talks t
    join public.workspace_members wm
      on wm.workspace_id = t.workspace_id
     and wm.user_id = ${input.userId}::uuid
    where t.id = ${input.talkId}::uuid
    limit 1
  `;
  return rows[0]?.workspace_id;
}

async function talkExistsInWorkspace(input: {
  workspaceId: string;
  talkId: string;
}): Promise<boolean> {
  const db = getDbPg();
  const rows = await db<Array<{ id: string }>>`
    select id
    from public.talks
    where workspace_id = ${input.workspaceId}::uuid
      and id = ${input.talkId}::uuid
    limit 1
  `;
  return rows.length > 0;
}

function parseBoolean(value: unknown, defaultValue = false): boolean {
  if (value === undefined || value === null || value === '')
    return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return defaultValue;
  return value === 'true' || value === '1';
}

function parseLimit(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseCreateDocumentFormat(
  value: unknown,
): NativeDocumentFormat | RouteResult<never> {
  if (value === undefined || value === null || value === '') return 'markdown';
  if (value === 'markdown' || value === 'html') return value;
  return error(
    400,
    'invalid_format',
    'Document format must be markdown or html.',
  );
}

function parseCreateDocumentTalkId(input: {
  talkId?: unknown;
  threadId?: unknown;
}): string | RouteResult<never> {
  const talkId =
    input.talkId === undefined || input.talkId === null
      ? undefined
      : input.talkId;
  const threadId =
    input.threadId === undefined || input.threadId === null
      ? undefined
      : input.threadId;
  if (talkId !== undefined && typeof talkId !== 'string') {
    return error(400, 'invalid_talk_id', 'Talk id must be a UUID.');
  }
  if (threadId !== undefined && typeof threadId !== 'string') {
    return error(400, 'invalid_thread_id', 'Thread id must be a UUID.');
  }
  const resolved = threadId ?? talkId;
  if (!resolved) {
    return error(
      400,
      'talk_id_required',
      'Creating a document requires a talkId or threadId.',
    );
  }
  if (talkId !== undefined && !isUuid(talkId)) {
    return error(400, 'invalid_talk_id', 'Talk id must be a UUID.');
  }
  if (threadId !== undefined && !isUuid(threadId)) {
    return error(400, 'invalid_thread_id', 'Thread id must be a UUID.');
  }
  if (talkId && threadId && talkId.toLowerCase() !== threadId.toLowerCase()) {
    return error(
      400,
      'thread_talk_mismatch',
      'Thread id must match the talk id for native document creation.',
    );
  }
  return resolved;
}

function parseOptionalExpectedContentVersion(
  value: unknown,
): number | RouteResult<never> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return error(
      400,
      'invalid_expected_version',
      'expectedContentVersion must be a number.',
    );
  }
  return value;
}

// Bulk accept/reject carry the exact edit-id set the reviewer saw on screen, so
// the accessor can abort if the server's pending set has drifted (a pending edit
// created after page load). Required for every bulk route — an array of edit-id
// UUIDs (empty is valid: it gates against "no pending edits").
function parseReviewedEditIds(value: unknown): string[] | RouteResult<never> {
  if (!Array.isArray(value)) {
    return error(
      400,
      'invalid_reviewed_edit_ids',
      'reviewedEditIds must be an array of edit ids.',
    );
  }
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !isUuid(entry)) {
      return error(
        400,
        'invalid_reviewed_edit_ids',
        'reviewedEditIds must contain only edit id UUIDs.',
      );
    }
    ids.push(entry);
  }
  return ids;
}

function toDocumentSummaryApi(document: NativeDocumentSummaryRecord): {
  id: string;
  workspaceId: string;
  primaryTalkId: string | null;
  folderId: string | null;
  title: string;
  format: 'markdown' | 'html';
  wordCount: number;
  lastEditAt: string | null;
  createdAt: string;
  updatedAt: string;
  tabCount: number;
  blockCount: number;
  pendingEditCount: number;
} {
  return {
    id: document.id,
    workspaceId: document.workspace_id,
    primaryTalkId: document.primary_talk_id,
    folderId: document.folder_id,
    title: document.title,
    format: document.format,
    wordCount: document.word_count,
    lastEditAt: document.last_edit_at,
    createdAt: document.created_at,
    updatedAt: document.updated_at,
    tabCount: document.tab_count,
    blockCount: document.block_count,
    pendingEditCount: document.pending_edit_count,
  };
}

function toDocumentBlockApi(block: NativeDocumentBlockRecord): {
  id: string;
  documentId: string;
  tabId: string;
  sortOrder: number;
  version: number;
  kind: NativeDocumentBlockRecord['kind'];
  text: string;
  attrs: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: block.id,
    documentId: block.document_id,
    tabId: block.tab_id,
    sortOrder: block.sort_order,
    version: block.version,
    kind: block.kind,
    text: block.text,
    attrs: block.attrs_json,
    createdAt: block.created_at,
    updatedAt: block.updated_at,
  };
}

function toDocumentTabApi(tab: NativeDocumentTabRecord): {
  id: string;
  documentId: string;
  title: string;
  sortOrder: number;
  listVersion: number;
  createdAt: string;
  updatedAt: string;
  blocks: ReturnType<typeof toDocumentBlockApi>[];
} {
  return {
    id: tab.id,
    documentId: tab.document_id,
    title: tab.title,
    sortOrder: tab.sort_order,
    listVersion: tab.list_version,
    createdAt: tab.created_at,
    updatedAt: tab.updated_at,
    blocks: tab.blocks.map(toDocumentBlockApi),
  };
}

function toDocumentEditApi(edit: NativeDocumentEditRecord): {
  id: string;
  documentId: string;
  tabId: string;
  blockId: string | null;
  baseBlockVersion: number | null;
  baseListVersion: number | null;
  afterBlockId: string | null;
  proposedByAgentId: string | null;
  proposedByAgentName: string | null;
  proposedByRunId: string | null;
  op: NativeDocumentEditRecord['op'];
  newKind: NativeDocumentEditRecord['new_kind'];
  newText: string | null;
  newAttrs: Record<string, unknown> | null;
  status: NativeDocumentEditRecord['status'];
  source: NativeDocumentEditRecord['source'];
  createdAt: string;
  resolvedAt: string | null;
} {
  return {
    id: edit.id,
    documentId: edit.document_id,
    tabId: edit.tab_id,
    blockId: edit.block_id,
    baseBlockVersion: edit.base_block_version,
    baseListVersion: edit.base_list_version,
    afterBlockId: edit.after_block_id,
    proposedByAgentId: edit.proposed_by_agent_id,
    proposedByAgentName: edit.proposed_by_agent_name,
    proposedByRunId: edit.proposed_by_run_id,
    op: edit.op,
    newKind: edit.new_kind,
    newText: edit.new_text,
    newAttrs: edit.new_attrs_json,
    status: edit.status,
    source: edit.source,
    createdAt: edit.created_at,
    resolvedAt: edit.resolved_at,
  };
}

function toDocumentApi(document: NativeDocumentRecord): ReturnType<
  typeof toDocumentSummaryApi
> & {
  tabs: ReturnType<typeof toDocumentTabApi>[];
  pendingEdits: ReturnType<typeof toDocumentEditApi>[];
} {
  return {
    ...toDocumentSummaryApi(document),
    tabs: document.tabs.map(toDocumentTabApi),
    pendingEdits: document.pending_edits.map(toDocumentEditApi),
  };
}

function versionConflict(currentVersion: number): RouteResult<never> {
  return error(
    409,
    'version_conflict',
    'This document changed since you started. Reload and retry.',
    { currentVersion },
  );
}

function anchorMissing(anchorId: string): RouteResult<never> {
  return error(
    409,
    'anchor_missing',
    'The target anchor no longer exists in the document.',
    { anchorId },
  );
}

function editSetMismatch(pendingEditIds: string[]): RouteResult<never> {
  return error(
    409,
    'edit_set_mismatch',
    'New pending edits appeared since you reviewed these. Reload and re-check before applying in bulk.',
    { pendingEditIds },
  );
}

function resolveDocumentMutationFailure(
  result:
    | { kind: 'not_found' }
    | { kind: 'version_conflict'; currentVersion: number }
    | { kind: 'anchor_missing'; anchorId: string }
    | { kind: 'invalid_edit'; message: string }
    | { kind: 'edit_set_mismatch'; pendingEditIds: string[] },
): RouteResult<never> {
  switch (result.kind) {
    case 'not_found':
      return error(404, 'pending_edit_not_found', 'Pending edit not found.');
    case 'version_conflict':
      return versionConflict(result.currentVersion);
    case 'anchor_missing':
      return anchorMissing(result.anchorId);
    case 'invalid_edit':
      return error(409, 'invalid_pending_edit', result.message);
    case 'edit_set_mismatch':
      return editSetMismatch(result.pendingEditIds);
  }
}

export async function listDocumentsRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  includeUnlinked?: unknown;
  limit?: unknown;
}): Promise<
  RouteResult<{ documents: ReturnType<typeof toDocumentSummaryApi>[] }>
> {
  return withDocumentsWorkspace(
    input.auth,
    input.workspaceId,
    null,
    async (ctx) => {
      const documents = await listNativeDocuments({
        workspaceId: ctx.workspace.id,
        includeUnlinked: parseBoolean(input.includeUnlinked),
        limit: parseLimit(input.limit),
      });
      return ok({ documents: documents.map(toDocumentSummaryApi) });
    },
  );
}

export async function createDocumentRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId?: unknown;
  threadId?: unknown;
  title?: unknown;
  format?: unknown;
}): Promise<RouteResult<{ document: ReturnType<typeof toDocumentApi> }>> {
  const talkId = parseCreateDocumentTalkId({
    talkId: input.talkId,
    threadId: input.threadId,
  });
  if (typeof talkId === 'object') return talkId;
  const title =
    typeof input.title === 'string' ? input.title.trim() : undefined;
  if (!title) {
    return error(400, 'title_required', 'Document title is required.');
  }
  const format = parseCreateDocumentFormat(input.format);
  if (typeof format === 'object') return format;
  return withDocumentsWorkspace(
    input.auth,
    input.workspaceId,
    { talkId },
    async (ctx) => {
      const writerError = requireWorkspaceWriter(ctx.workspace);
      if (writerError) return writerError;
      const exists = await talkExistsInWorkspace({
        workspaceId: ctx.workspace.id,
        talkId,
      });
      if (!exists) {
        return error(404, 'talk_not_found', 'Talk not found.');
      }
      const document = await createNativeDocumentForTalk({
        workspaceId: ctx.workspace.id,
        talkId,
        title,
        format,
      });
      return ok({ document: toDocumentApi(document) }, 201);
    },
  );
}

export async function getDocumentRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  documentId: string;
}): Promise<RouteResult<{ document: ReturnType<typeof toDocumentApi> }>> {
  return withDocumentsWorkspace(
    input.auth,
    input.workspaceId,
    { documentId: input.documentId },
    async (ctx) => {
      const document = await getNativeDocument({
        workspaceId: ctx.workspace.id,
        documentId: input.documentId,
      });
      if (!document) {
        return error(404, 'document_not_found', 'Document not found.');
      }
      return ok({ document: toDocumentApi(document) });
    },
  );
}

export async function listDocumentEditsRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  documentId: string;
  status?: unknown;
}): Promise<RouteResult<{ edits: ReturnType<typeof toDocumentEditApi>[] }>> {
  const status =
    typeof input.status === 'string' && EDIT_STATUSES.has(input.status as never)
      ? (input.status as NativeDocumentEditStatus | 'all')
      : 'pending';
  if (
    input.status !== undefined &&
    input.status !== null &&
    status === 'pending' &&
    input.status !== 'pending'
  ) {
    return error(400, 'invalid_status', 'Document edit status is invalid.');
  }
  return withDocumentsWorkspace(
    input.auth,
    input.workspaceId,
    { documentId: input.documentId },
    async (ctx) => {
      const document = await getNativeDocument({
        workspaceId: ctx.workspace.id,
        documentId: input.documentId,
      });
      if (!document) {
        return error(404, 'document_not_found', 'Document not found.');
      }
      const edits = await listNativeDocumentEdits({
        workspaceId: ctx.workspace.id,
        documentId: input.documentId,
        status,
      });
      return ok({ edits: edits.map(toDocumentEditApi) });
    },
  );
}

export async function acceptDocumentEditRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  documentId: string;
  editId: string;
  expectedContentVersion?: unknown;
}): Promise<
  RouteResult<{
    document: ReturnType<typeof toDocumentApi>;
    editId: string;
    runId: string;
  }>
> {
  if (!isUuid(input.editId)) {
    return error(400, 'invalid_edit_id', 'Edit id must be a UUID.');
  }
  const expected = parseOptionalExpectedContentVersion(
    input.expectedContentVersion,
  );
  if (typeof expected === 'object') return expected;
  return withDocumentsWorkspace(
    input.auth,
    input.workspaceId,
    { documentId: input.documentId },
    async (ctx) => {
      const writerError = requireWorkspaceWriter(ctx.workspace);
      if (writerError) return writerError;
      const result = await acceptNativeDocumentEdit({
        workspaceId: ctx.workspace.id,
        documentId: input.documentId,
        editId: input.editId,
        expectedContentVersion: expected,
      });
      if (result.kind !== 'ok') return resolveDocumentMutationFailure(result);
      return ok({
        document: toDocumentApi(result.document),
        editId: result.editIds[0] ?? input.editId,
        runId: result.runId ?? '',
      });
    },
  );
}

export async function rejectDocumentEditRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  documentId: string;
  editId: string;
}): Promise<
  RouteResult<{
    document: ReturnType<typeof toDocumentApi>;
    editId: string;
    runId: string;
  }>
> {
  if (!isUuid(input.editId)) {
    return error(400, 'invalid_edit_id', 'Edit id must be a UUID.');
  }
  return withDocumentsWorkspace(
    input.auth,
    input.workspaceId,
    { documentId: input.documentId },
    async (ctx) => {
      const writerError = requireWorkspaceWriter(ctx.workspace);
      if (writerError) return writerError;
      const result = await rejectNativeDocumentEdit({
        workspaceId: ctx.workspace.id,
        documentId: input.documentId,
        editId: input.editId,
      });
      if (result.kind === 'not_found') {
        return error(404, 'pending_edit_not_found', 'Pending edit not found.');
      }
      return ok({
        document: toDocumentApi(result.document),
        editId: result.editId,
        runId: result.runId ?? '',
      });
    },
  );
}

export async function acceptDocumentEditRunRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  documentId: string;
  runId: string;
  reviewedEditIds?: unknown;
  expectedContentVersion?: unknown;
}): Promise<
  RouteResult<{
    document: ReturnType<typeof toDocumentApi>;
    runId: string;
    editIds: string[];
  }>
> {
  if (!isUuid(input.runId)) {
    return error(400, 'invalid_run_id', 'Run id must be a UUID.');
  }
  const expected = parseOptionalExpectedContentVersion(
    input.expectedContentVersion,
  );
  if (typeof expected === 'object') return expected;
  const reviewedEditIds = parseReviewedEditIds(input.reviewedEditIds);
  if (!Array.isArray(reviewedEditIds)) return reviewedEditIds;
  return withDocumentsWorkspace(
    input.auth,
    input.workspaceId,
    { documentId: input.documentId },
    async (ctx) => {
      const writerError = requireWorkspaceWriter(ctx.workspace);
      if (writerError) return writerError;
      const result = await acceptNativeDocumentEditRun({
        workspaceId: ctx.workspace.id,
        documentId: input.documentId,
        runId: input.runId,
        reviewedEditIds,
        expectedContentVersion: expected,
      });
      if (result.kind !== 'ok') return resolveDocumentMutationFailure(result);
      return ok({
        document: toDocumentApi(result.document),
        runId: result.runId ?? input.runId,
        editIds: result.editIds,
      });
    },
  );
}

export async function rejectDocumentEditRunRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  documentId: string;
  runId: string;
  reviewedEditIds?: unknown;
}): Promise<
  RouteResult<{
    document: ReturnType<typeof toDocumentApi>;
    runId: string;
    editIds: string[];
  }>
> {
  if (!isUuid(input.runId)) {
    return error(400, 'invalid_run_id', 'Run id must be a UUID.');
  }
  const reviewedEditIds = parseReviewedEditIds(input.reviewedEditIds);
  if (!Array.isArray(reviewedEditIds)) return reviewedEditIds;
  return withDocumentsWorkspace(
    input.auth,
    input.workspaceId,
    { documentId: input.documentId },
    async (ctx) => {
      const writerError = requireWorkspaceWriter(ctx.workspace);
      if (writerError) return writerError;
      const result = await rejectNativeDocumentEditRun({
        workspaceId: ctx.workspace.id,
        documentId: input.documentId,
        runId: input.runId,
        reviewedEditIds,
      });
      if (result.kind === 'edit_set_mismatch') {
        return editSetMismatch(result.pendingEditIds);
      }
      if (result.kind === 'not_found') {
        return error(
          404,
          'pending_edit_not_found',
          'Pending edit run not found.',
        );
      }
      return ok({
        document: toDocumentApi(result.document),
        runId: result.runId,
        editIds: result.editIds,
      });
    },
  );
}

export async function acceptAllDocumentEditsRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  documentId: string;
  reviewedEditIds?: unknown;
  expectedContentVersion?: unknown;
}): Promise<
  RouteResult<{
    document: ReturnType<typeof toDocumentApi>;
    editIds: string[];
    runId: string;
  }>
> {
  const expected = parseOptionalExpectedContentVersion(
    input.expectedContentVersion,
  );
  if (typeof expected === 'object') return expected;
  const reviewedEditIds = parseReviewedEditIds(input.reviewedEditIds);
  if (!Array.isArray(reviewedEditIds)) return reviewedEditIds;
  return withDocumentsWorkspace(
    input.auth,
    input.workspaceId,
    { documentId: input.documentId },
    async (ctx) => {
      const writerError = requireWorkspaceWriter(ctx.workspace);
      if (writerError) return writerError;
      const result = await acceptAllNativeDocumentEdits({
        workspaceId: ctx.workspace.id,
        documentId: input.documentId,
        reviewedEditIds,
        expectedContentVersion: expected,
      });
      if (result.kind !== 'ok') return resolveDocumentMutationFailure(result);
      return ok({
        document: toDocumentApi(result.document),
        editIds: result.editIds,
        runId: result.runId ?? '',
      });
    },
  );
}

export async function rejectAllDocumentEditsRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  documentId: string;
  reviewedEditIds?: unknown;
}): Promise<
  RouteResult<{ document: ReturnType<typeof toDocumentApi>; editIds: string[] }>
> {
  const reviewedEditIds = parseReviewedEditIds(input.reviewedEditIds);
  if (!Array.isArray(reviewedEditIds)) return reviewedEditIds;
  return withDocumentsWorkspace(
    input.auth,
    input.workspaceId,
    { documentId: input.documentId },
    async (ctx) => {
      const writerError = requireWorkspaceWriter(ctx.workspace);
      if (writerError) return writerError;
      const result = await rejectAllNativeDocumentEdits({
        workspaceId: ctx.workspace.id,
        documentId: input.documentId,
        reviewedEditIds,
      });
      if (result.kind === 'edit_set_mismatch') {
        return editSetMismatch(result.pendingEditIds);
      }
      if (result.kind === 'not_found') {
        return error(404, 'document_not_found', 'Document not found.');
      }
      return ok({
        document: toDocumentApi(result.document),
        editIds: result.editIds,
      });
    },
  );
}

export function mountDocumentRoutes(
  app: DocumentsApp,
  requireAuthMiddleware: DocumentsAuthMiddleware,
): void {
  app.use('/api/v1/documents', requireAuthMiddleware);
  app.use('/api/v1/documents/*', requireAuthMiddleware);

  app.get('/api/v1/documents', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await listDocumentsRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      includeUnlinked:
        c.req.query('include_unlinked') ?? c.req.query('includeUnlinked'),
      limit: c.req.query('limit'),
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/documents', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readOptionalJsonBody<{
      talkId?: unknown;
      threadId?: unknown;
      title?: unknown;
      format?: unknown;
    }>(c);
    if (!payload.ok) return invalidJsonResponse(payload.error);
    const result = await createDocumentRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      talkId: payload.data.talkId,
      threadId: payload.data.threadId,
      title: payload.data.title,
      format: payload.data.format,
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/documents/:documentId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await getDocumentRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      documentId: c.req.param('documentId'),
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/documents/:documentId/edits', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await listDocumentEditsRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      documentId: c.req.param('documentId'),
      status: c.req.query('status'),
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/documents/:documentId/edits/:editId/accept', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readOptionalJsonBody<{
      expectedContentVersion?: unknown;
    }>(c);
    if (!payload.ok) return invalidJsonResponse(payload.error);
    const result = await acceptDocumentEditRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      documentId: c.req.param('documentId'),
      editId: c.req.param('editId'),
      expectedContentVersion: payload.data.expectedContentVersion,
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/documents/:documentId/edits/:editId/reject', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readOptionalJsonBody<Record<string, unknown>>(c);
    if (!payload.ok) return invalidJsonResponse(payload.error);
    const result = await rejectDocumentEditRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      documentId: c.req.param('documentId'),
      editId: c.req.param('editId'),
    });
    return jsonResponse(result);
  });

  app.post(
    '/api/v1/documents/:documentId/edit-runs/:runId/accept',
    async (c) => {
      const auth = c.get('auth');
      const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
      if (!rl.allowed) return rateLimitedResponse(c, rl);
      const csrfFail = checkCsrf(c, auth);
      if (csrfFail) return csrfFail;
      const payload = await readOptionalJsonBody<{
        reviewedEditIds?: unknown;
        expectedContentVersion?: unknown;
      }>(c);
      if (!payload.ok) return invalidJsonResponse(payload.error);
      const result = await acceptDocumentEditRunRoute({
        auth,
        workspaceId: requestedWorkspaceId(c),
        documentId: c.req.param('documentId'),
        runId: c.req.param('runId'),
        reviewedEditIds: payload.data.reviewedEditIds,
        expectedContentVersion: payload.data.expectedContentVersion,
      });
      return jsonResponse(result);
    },
  );

  app.post(
    '/api/v1/documents/:documentId/edit-runs/:runId/reject',
    async (c) => {
      const auth = c.get('auth');
      const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
      if (!rl.allowed) return rateLimitedResponse(c, rl);
      const csrfFail = checkCsrf(c, auth);
      if (csrfFail) return csrfFail;
      const payload = await readOptionalJsonBody<{
        reviewedEditIds?: unknown;
      }>(c);
      if (!payload.ok) return invalidJsonResponse(payload.error);
      const result = await rejectDocumentEditRunRoute({
        auth,
        workspaceId: requestedWorkspaceId(c),
        documentId: c.req.param('documentId'),
        runId: c.req.param('runId'),
        reviewedEditIds: payload.data.reviewedEditIds,
      });
      return jsonResponse(result);
    },
  );

  app.post('/api/v1/documents/:documentId/accept-all', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readOptionalJsonBody<{
      reviewedEditIds?: unknown;
      expectedContentVersion?: unknown;
    }>(c);
    if (!payload.ok) return invalidJsonResponse(payload.error);
    const result = await acceptAllDocumentEditsRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      documentId: c.req.param('documentId'),
      reviewedEditIds: payload.data.reviewedEditIds,
      expectedContentVersion: payload.data.expectedContentVersion,
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/documents/:documentId/reject-all', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readOptionalJsonBody<{
      reviewedEditIds?: unknown;
    }>(c);
    if (!payload.ok) return invalidJsonResponse(payload.error);
    const result = await rejectAllDocumentEditsRoute({
      auth,
      workspaceId: requestedWorkspaceId(c),
      documentId: c.req.param('documentId'),
      reviewedEditIds: payload.data.reviewedEditIds,
    });
    return jsonResponse(result);
  });
}

function jsonResponse(result: { statusCode: number; body: unknown }): Response {
  return new Response(JSON.stringify(result.body), {
    status: result.statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function requestedWorkspaceId(c: Context): string | null {
  return (
    c.req.header('x-workspace-id') ??
    c.req.header('x-clawtalk-workspace-id') ??
    c.req.query('workspaceId') ??
    null
  );
}

function checkCsrf(c: Context, auth: AuthContext): Response | null {
  const csrf = validateCsrfTokenPg({
    method: c.req.method,
    authType: auth.authType,
    cookieHeader: c.req.header('cookie'),
    csrfHeader: c.req.header('x-csrf-token'),
  });
  if (csrf.ok) return null;
  return new Response(
    JSON.stringify({
      ok: false,
      error: { code: 'csrf_failed', message: csrf.reason },
    }),
    {
      status: 403,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    },
  );
}

function rateLimitedResponse(c: Context, rl: RateLimitResult): Response {
  return c.json(
    {
      ok: false,
      error: {
        code: 'rate_limited',
        message: 'Too many requests. Please retry shortly.',
        details: {
          limit: rl.limit,
          retryAfterSec: rl.retryAfterSec,
        },
      },
    },
    429,
    { 'retry-after': String(rl.retryAfterSec) },
  );
}

async function readOptionalJsonBody<T>(
  c: Context,
): Promise<{ ok: true; data: Partial<T> } | { ok: false; error: string }> {
  const raw = await c.req.text();
  if (!raw.trim()) return { ok: true, data: {} };
  try {
    const parsed = JSON.parse(raw) as Partial<T>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'JSON body must be an object.' };
    }
    return { ok: true, data: parsed };
  } catch {
    return { ok: false, error: 'Request body must be valid JSON.' };
  }
}

function invalidJsonResponse(message: string): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: { code: 'invalid_json', message },
    }),
    {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    },
  );
}
