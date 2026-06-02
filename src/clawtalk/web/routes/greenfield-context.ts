import { randomUUID } from 'node:crypto';

import { getDbPg, withUserContext } from '../../../db.js';
import {
  MAX_RASTER_IMAGE_BYTES,
  MAX_RASTER_PAGES,
} from '../../../shared/attachment-caps.js';
import { logger } from '../../../logger.js';
import { detectMime } from '../../r2/content-images.js';
import {
  extractAttachmentText,
  inferSupportedAttachmentMimeType,
  isImageAttachmentMimeType,
  MAX_ATTACHMENT_SIZE,
  MAX_IMAGE_ATTACHMENT_SIZE,
} from '../../talks/attachment-extraction.js';
import {
  deleteAttachmentFile,
  deletePageImages,
  loadAttachmentFile,
  saveAttachmentFile,
  savePageImage,
} from '../../talks/attachment-storage.js';
import {
  countGreenfieldSourcePageImages,
  createGreenfieldContextRule,
  createGreenfieldContextSource,
  deleteGreenfieldContextRule,
  deleteGreenfieldContextSource,
  getGreenfieldContextSourceById,
  getGreenfieldTalkContext,
  insertGreenfieldSourcePageImage,
  listGreenfieldContextRules,
  listGreenfieldSourcePageIndices,
  markGreenfieldContextSourcePending,
  patchGreenfieldContextRule,
  patchGreenfieldContextSource,
  setGreenfieldContextGoal,
  setGreenfieldSourceExpectedPageCount,
  type GreenfieldContextRuleSnapshot,
  type GreenfieldContextSourceSnapshot,
  type GreenfieldTalkContextSnapshot,
} from '../../talks/greenfield-context-accessors.js';
import { getGreenfieldTalk } from '../../talks/greenfield-accessors.js';
import {
  resolveWorkspaceForUser,
  type WorkspaceSummaryRecord,
} from '../../workspaces/accessors.js';
import { ensureWorkspaceBootstrapForUser } from '../../workspaces/bootstrap.js';
import type { ApiEnvelope, AuthContext } from '../types.js';

type RouteResult<T> = {
  statusCode: number;
  body: ApiEnvelope<T>;
  scope?: WorkspaceRouteContext & { talkId: string };
};

type WorkspaceRouteContext = {
  workspaceId: string;
  role: WorkspaceSummaryRecord['role'];
};

type SourceContentResult =
  | RouteResult<never>
  | {
      statusCode: number;
      body: Buffer | string;
      headers: Record<string, string>;
    };

type TalkStateEntrySnapshot = {
  id: string;
  key: string;
  value: unknown;
  version: number;
  updatedAt: string;
  updatedByUserId: string | null;
  updatedByRunId: string | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_STATE_KEY_LENGTH = 80;
const STATE_KEY_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_.:-]*$/;

function ok<T>(data: T, statusCode = 200): RouteResult<T> {
  return { statusCode, body: { ok: true, data } };
}

function error(
  statusCode: number,
  code: string,
  message: string,
): RouteResult<never> {
  return { statusCode, body: { ok: false, error: { code, message } } };
}

async function cleanupGreenfieldContextSourceStorage(input: {
  talkId: string;
  sourceId: string;
  storageKey: string | null;
  pageIndices: number[];
}): Promise<void> {
  const cleanup: Promise<void>[] = [];
  if (input.storageKey) {
    cleanup.push(
      deleteAttachmentFile(input.storageKey).catch((err) => {
        logger.warn(
          { err, sourceId: input.sourceId, storageKey: input.storageKey },
          'greenfield context source file cleanup failed',
        );
      }),
    );
  }
  if (input.pageIndices.length > 0) {
    cleanup.push(
      deletePageImages(input.talkId, input.sourceId, input.pageIndices).catch(
        (err) => {
          logger.warn(
            {
              err,
              sourceId: input.sourceId,
              pageCount: input.pageIndices.length,
            },
            'greenfield context source page image cleanup failed',
          );
        },
      ),
    );
  }
  await Promise.all(cleanup);
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function validateStateKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) throw new Error('State key is required');
  if (trimmed.length > MAX_STATE_KEY_LENGTH) {
    throw new Error(
      `State key exceeds ${MAX_STATE_KEY_LENGTH}-character limit`,
    );
  }
  if (!STATE_KEY_PATTERN.test(trimmed)) {
    throw new Error(
      'State key must contain only letters, digits, underscores, dots, colons, or hyphens, and must start with a letter, digit, or underscore.',
    );
  }
  return trimmed;
}

async function findVisibleTalkWorkspaceId(
  talkId: string,
): Promise<string | undefined> {
  const db = getDbPg();
  const rows = await db<{ workspace_id: string }[]>`
    select workspace_id
    from public.talks
    where id = ${talkId}::uuid
    limit 1
  `;
  return rows[0]?.workspace_id;
}

async function resolveTalkWorkspaceContext(input: {
  userId: string;
  requestedWorkspaceId?: string | null;
  talkId: string;
}): Promise<WorkspaceRouteContext | RouteResult<never>> {
  if (input.requestedWorkspaceId) {
    const workspace = await resolveWorkspaceForUser({
      userId: input.userId,
      requestedWorkspaceId: input.requestedWorkspaceId,
    });
    if (!workspace) {
      return error(
        403,
        'workspace_forbidden',
        'Workspace is not available to this user.',
      );
    }
    const talk = await getGreenfieldTalk({
      workspaceId: workspace.id,
      talkId: input.talkId,
    });
    if (!talk) return error(404, 'not_found', 'Talk not found.');
    return { workspaceId: workspace.id, role: workspace.role };
  }

  const workspaceId = await findVisibleTalkWorkspaceId(input.talkId);
  if (!workspaceId) return error(404, 'not_found', 'Talk not found.');
  const workspace = await resolveWorkspaceForUser({
    userId: input.userId,
    requestedWorkspaceId: workspaceId,
  });
  if (!workspace) {
    return error(403, 'workspace_forbidden', 'Workspace is not available.');
  }
  return { workspaceId: workspace.id, role: workspace.role };
}

function isRouteResult(
  value: WorkspaceRouteContext | RouteResult<never>,
): value is RouteResult<never> {
  return 'statusCode' in value;
}

async function withTalk<T>(
  input: {
    auth: AuthContext;
    workspaceId?: string | null;
    talkId: string;
  },
  fn: (ctx: WorkspaceRouteContext) => Promise<RouteResult<T>>,
): Promise<RouteResult<T>> {
  if (!isUuid(input.talkId)) {
    return error(400, 'invalid_talk_id', 'Talk id must be a UUID.');
  }
  try {
    await ensureWorkspaceBootstrapForUser(input.auth.userId);
  } catch {
    return error(401, 'unauthorized', 'Session is not active.');
  }

  return withUserContext(input.auth.userId, async () => {
    const ctx = await resolveTalkWorkspaceContext({
      userId: input.auth.userId,
      requestedWorkspaceId: input.workspaceId,
      talkId: input.talkId,
    });
    if (isRouteResult(ctx)) return ctx;
    const result = await fn(ctx);
    return result.body.ok
      ? {
          ...result,
          scope: {
            workspaceId: ctx.workspaceId,
            role: ctx.role,
            talkId: input.talkId,
          },
        }
      : result;
  });
}

function requireWorkspaceWriter(
  ctx: WorkspaceRouteContext,
): RouteResult<never> | null {
  if (ctx.role !== 'guest') return null;
  return error(
    403,
    'workspace_writer_required',
    'Workspace write access is required.',
  );
}

async function withWritableTalk<T>(
  input: {
    auth: AuthContext;
    workspaceId?: string | null;
    talkId: string;
  },
  fn: (ctx: WorkspaceRouteContext) => Promise<RouteResult<T>>,
): Promise<RouteResult<T>> {
  return withTalk(input, async (ctx) => {
    const writerError = requireWorkspaceWriter(ctx);
    if (writerError) return writerError;
    return fn(ctx);
  });
}

async function withTalkContent(
  input: {
    auth: AuthContext;
    workspaceId?: string | null;
    talkId: string;
  },
  fn: (ctx: WorkspaceRouteContext) => Promise<SourceContentResult>,
): Promise<SourceContentResult> {
  if (!isUuid(input.talkId)) {
    return error(400, 'invalid_talk_id', 'Talk id must be a UUID.');
  }
  try {
    await ensureWorkspaceBootstrapForUser(input.auth.userId);
  } catch {
    return error(401, 'unauthorized', 'Session is not active.');
  }

  return withUserContext(input.auth.userId, async () => {
    const ctx = await resolveTalkWorkspaceContext({
      userId: input.auth.userId,
      requestedWorkspaceId: input.workspaceId,
      talkId: input.talkId,
    });
    if (isRouteResult(ctx)) return ctx;
    return fn(ctx);
  });
}

export async function getGreenfieldTalkContextRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
}): Promise<RouteResult<GreenfieldTalkContextSnapshot>> {
  return withTalk(input, async (ctx) =>
    ok(
      await getGreenfieldTalkContext({
        workspaceId: ctx.workspaceId,
        talkId: input.talkId,
      }),
    ),
  );
}

export async function setGreenfieldTalkGoalRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  goalText: string;
}): Promise<RouteResult<{ goal: GreenfieldTalkContextSnapshot['goal'] }>> {
  const text = input.goalText.replace(/\r\n/g, '\n').trim();
  if (text.length > 1000) {
    return error(
      400,
      'goal_too_long',
      'Goal must be 1000 characters or fewer.',
    );
  }
  return withWritableTalk(input, async (ctx) => {
    const goal = await setGreenfieldContextGoal({
      workspaceId: ctx.workspaceId,
      talkId: input.talkId,
      goalText: text,
      updatedBy: input.auth.userId,
    });
    return ok({ goal });
  });
}

export async function listGreenfieldTalkContextRulesRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
}): Promise<RouteResult<{ rules: GreenfieldContextRuleSnapshot[] }>> {
  return withTalk(input, async (ctx) =>
    ok({
      rules: await listGreenfieldContextRules({
        workspaceId: ctx.workspaceId,
        talkId: input.talkId,
      }),
    }),
  );
}

export async function createGreenfieldTalkContextRuleRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  ruleText: string;
}): Promise<RouteResult<{ rule: GreenfieldContextRuleSnapshot }>> {
  const text = input.ruleText.trim();
  if (!text) return error(400, 'rule_text_required', 'Rule text is required.');
  if (text.length > 800) {
    return error(400, 'rule_too_long', 'Rule must be 800 characters or fewer.');
  }
  return withWritableTalk(input, async (ctx) => {
    try {
      const rule = await createGreenfieldContextRule({
        workspaceId: ctx.workspaceId,
        talkId: input.talkId,
        ruleText: text,
        createdBy: input.auth.userId,
      });
      return ok({ rule }, 201);
    } catch (err) {
      if (err instanceof Error && err.message.includes('Maximum 8')) {
        return error(400, 'active_rule_limit', err.message);
      }
      throw err;
    }
  });
}

export async function patchGreenfieldTalkContextRuleRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  ruleId: string;
  ruleText?: string;
  isActive?: boolean;
  sortOrder?: number;
}): Promise<RouteResult<{ rule: GreenfieldContextRuleSnapshot }>> {
  if (!isUuid(input.ruleId)) {
    return error(400, 'invalid_rule_id', 'Rule id must be a UUID.');
  }
  if (input.ruleText !== undefined) {
    const text = input.ruleText.trim();
    if (!text)
      return error(400, 'rule_text_required', 'Rule text is required.');
    if (text.length > 800) {
      return error(
        400,
        'rule_too_long',
        'Rule must be 800 characters or fewer.',
      );
    }
  }

  return withWritableTalk(input, async (ctx) => {
    try {
      const rule = await patchGreenfieldContextRule({
        workspaceId: ctx.workspaceId,
        talkId: input.talkId,
        ruleId: input.ruleId,
        ruleText: input.ruleText?.trim(),
        isActive: input.isActive,
        sortOrder: input.sortOrder,
      });
      if (!rule) return error(404, 'not_found', 'Rule not found.');
      return ok({ rule });
    } catch (err) {
      if (err instanceof Error && err.message.includes('Maximum 8')) {
        return error(400, 'active_rule_limit', err.message);
      }
      throw err;
    }
  });
}

export async function deleteGreenfieldTalkContextRuleRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  ruleId: string;
}): Promise<RouteResult<{ deleted: true }>> {
  if (!isUuid(input.ruleId)) {
    return error(400, 'invalid_rule_id', 'Rule id must be a UUID.');
  }
  return withWritableTalk(input, async (ctx) => {
    const deleted = await deleteGreenfieldContextRule({
      workspaceId: ctx.workspaceId,
      talkId: input.talkId,
      ruleId: input.ruleId,
    });
    if (!deleted) return error(404, 'not_found', 'Rule not found.');
    return ok({ deleted: true });
  });
}

export async function getGreenfieldTalkStateRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
}): Promise<RouteResult<{ entries: TalkStateEntrySnapshot[] }>> {
  return withTalk(input, async () => ok({ entries: [] }));
}

export async function deleteGreenfieldTalkStateEntryRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  key: string;
}): Promise<RouteResult<{ deleted: true }>> {
  try {
    validateStateKey(input.key);
  } catch (err) {
    return error(
      400,
      'invalid_key',
      err instanceof Error ? err.message : 'Invalid key.',
    );
  }
  return withWritableTalk(input, async () =>
    error(404, 'not_found', 'State entry not found.'),
  );
}

export async function createGreenfieldTalkContextSourceRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  sourceType: string;
  title: string;
  note?: string | null;
  sourceUrl?: string | null;
  extractedText?: string | null;
}): Promise<RouteResult<{ source: GreenfieldContextSourceSnapshot }>> {
  const sourceType = input.sourceType;
  if (sourceType !== 'url' && sourceType !== 'text') {
    return error(
      400,
      'invalid_source_type',
      'Source type must be url or text. Use the upload endpoint for files.',
    );
  }

  const title = input.title.trim();
  if (!title) return error(400, 'title_required', 'Source title is required.');
  if (sourceType === 'url' && !input.sourceUrl?.trim()) {
    return error(400, 'url_required', 'A URL is required for URL sources.');
  }
  if (sourceType === 'text' && !input.extractedText?.trim()) {
    return error(
      400,
      'text_required',
      'Text content is required for text sources.',
    );
  }

  return withWritableTalk(input, async (ctx) => {
    try {
      const source = await createGreenfieldContextSource({
        workspaceId: ctx.workspaceId,
        talkId: input.talkId,
        sourceType,
        title,
        note: input.note,
        sourceUrl: sourceType === 'url' ? input.sourceUrl?.trim() : null,
        extractedText:
          sourceType === 'text' ? (input.extractedText?.trim() ?? null) : null,
        createdBy: input.auth.userId,
      });
      return ok({ source }, 201);
    } catch (err) {
      if (err instanceof Error && err.message.includes('Maximum 50')) {
        return error(400, 'source_limit', err.message);
      }
      throw err;
    }
  });
}

export async function patchGreenfieldTalkContextSourceRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  sourceId: string;
  title?: string;
  note?: string | null;
  sortOrder?: number;
  extractedText?: string | null;
}): Promise<RouteResult<{ source: GreenfieldContextSourceSnapshot }>> {
  if (!isUuid(input.sourceId)) {
    return error(400, 'invalid_source_id', 'Source id must be a UUID.');
  }
  if (input.title !== undefined && !input.title.trim()) {
    return error(400, 'title_required', 'Source title is required.');
  }
  return withWritableTalk(input, async (ctx) => {
    let source: GreenfieldContextSourceSnapshot | undefined;
    try {
      source = await patchGreenfieldContextSource({
        workspaceId: ctx.workspaceId,
        talkId: input.talkId,
        sourceId: input.sourceId,
        title: input.title,
        note: input.note,
        sortOrder: input.sortOrder,
        extractedText: input.extractedText,
      });
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes('Only text sources can update extracted text')
      ) {
        return error(400, 'source_content_not_editable', err.message);
      }
      throw err;
    }
    if (!source) return error(404, 'not_found', 'Source not found.');
    return ok({ source });
  });
}

export async function deleteGreenfieldTalkContextSourceRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  sourceId: string;
}): Promise<RouteResult<{ deleted: true }>> {
  if (!isUuid(input.sourceId)) {
    return error(400, 'invalid_source_id', 'Source id must be a UUID.');
  }
  return withWritableTalk(input, async (ctx) => {
    const source = await getGreenfieldContextSourceById({
      workspaceId: ctx.workspaceId,
      talkId: input.talkId,
      sourceId: input.sourceId,
    });
    if (!source) return error(404, 'not_found', 'Source not found.');

    const pageIndices = await listGreenfieldSourcePageIndices({
      workspaceId: ctx.workspaceId,
      sourceId: input.sourceId,
    });
    const deleted = await deleteGreenfieldContextSource({
      workspaceId: ctx.workspaceId,
      talkId: input.talkId,
      sourceId: input.sourceId,
    });
    if (!deleted) return error(404, 'not_found', 'Source not found.');

    await cleanupGreenfieldContextSourceStorage({
      talkId: input.talkId,
      sourceId: input.sourceId,
      storageKey: source.storageKey,
      pageIndices,
    });
    return ok({ deleted: true });
  });
}

export async function retryGreenfieldTalkContextSourceRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  sourceId: string;
}): Promise<RouteResult<{ source: GreenfieldContextSourceSnapshot }>> {
  if (!isUuid(input.sourceId)) {
    return error(400, 'invalid_source_id', 'Source id must be a UUID.');
  }
  return withWritableTalk(input, async (ctx) => {
    const existing = await getGreenfieldContextSourceById({
      workspaceId: ctx.workspaceId,
      talkId: input.talkId,
      sourceId: input.sourceId,
    });
    if (!existing) return error(404, 'not_found', 'Source not found.');
    if (existing.sourceType !== 'url' || !existing.sourceUrl) {
      return error(
        400,
        'source_not_retryable',
        'Only URL sources can be retried.',
      );
    }
    const source = await markGreenfieldContextSourcePending({
      workspaceId: ctx.workspaceId,
      talkId: input.talkId,
      sourceId: input.sourceId,
    });
    if (!source) return error(404, 'not_found', 'Source not found.');
    return ok({ source });
  });
}

export async function uploadGreenfieldTalkContextSourceRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  file: {
    name: string;
    data: Buffer;
    type: string;
  };
  title?: string;
}): Promise<RouteResult<{ source: GreenfieldContextSourceSnapshot }>> {
  return withWritableTalk(input, async (ctx) => {
    const mimeType = inferSupportedAttachmentMimeType(
      input.file.name,
      input.file.type,
    );
    if (!mimeType) {
      return error(
        400,
        'unsupported_file_type',
        `File type "${input.file.type || 'unknown'}" is not supported for context sources.`,
      );
    }

    const isImage = isImageAttachmentMimeType(mimeType);
    const sizeCap = isImage ? MAX_IMAGE_ATTACHMENT_SIZE : MAX_ATTACHMENT_SIZE;
    if (input.file.data.length > sizeCap) {
      return error(
        400,
        'file_too_large',
        `File exceeds maximum size of ${sizeCap / (1024 * 1024)} MB.`,
      );
    }

    const sourceId = randomUUID();
    const storageKey = await saveAttachmentFile(
      sourceId,
      input.talkId,
      input.file.data,
      input.file.name,
      mimeType,
    );

    let extractedText: string | null = null;
    let extractionError: string | null = null;
    if (!isImage) {
      try {
        extractedText = await extractAttachmentText(
          input.file.data,
          mimeType,
          input.file.name,
        );
      } catch (err) {
        extractionError =
          err instanceof Error ? err.message : 'Unknown extraction error';
      }
    }

    try {
      const source = await createGreenfieldContextSource({
        id: sourceId,
        workspaceId: ctx.workspaceId,
        talkId: input.talkId,
        sourceType: 'file',
        title: input.title?.trim() || input.file.name,
        fileName: input.file.name,
        fileSize: input.file.data.length,
        mimeType,
        storageKey,
        extractedText,
        extractionError,
        createdBy: input.auth.userId,
      });
      return ok({ source }, 201);
    } catch (err) {
      await deleteAttachmentFile(storageKey);
      if (err instanceof Error && err.message.includes('Maximum 50')) {
        return error(400, 'source_limit', err.message);
      }
      throw err;
    }
  });
}

export async function uploadGreenfieldTalkContextSourcePageImageRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  sourceId: string;
  index: string;
  total: string | undefined;
  data: Buffer;
}): Promise<
  RouteResult<{ uploaded: number; expected: number; complete: boolean }>
> {
  if (!isUuid(input.sourceId)) {
    return error(400, 'invalid_source_id', 'Source id must be a UUID.');
  }
  const pageIndex = Number(input.index);
  const total = Number(input.total);
  if (
    !Number.isInteger(pageIndex) ||
    pageIndex < 0 ||
    pageIndex >= MAX_RASTER_PAGES
  ) {
    return error(
      400,
      'invalid_page_index',
      `Page index must be an integer in [0, ${MAX_RASTER_PAGES}).`,
    );
  }
  if (!Number.isInteger(total) || total < 1 || total > MAX_RASTER_PAGES) {
    return error(
      400,
      'invalid_total',
      `total must be an integer in [1, ${MAX_RASTER_PAGES}].`,
    );
  }
  if (pageIndex >= total) {
    return error(
      400,
      'page_index_out_of_range',
      `Page index ${pageIndex} must be less than total ${total}.`,
    );
  }
  if (input.data.length === 0) {
    return error(400, 'empty_page', 'Page image body is empty.');
  }
  if (input.data.length > MAX_RASTER_IMAGE_BYTES) {
    return error(
      400,
      'page_too_large',
      `Page image exceeds the maximum size of ${
        MAX_RASTER_IMAGE_BYTES / (1024 * 1024)
      } MB.`,
    );
  }
  if (detectMime(input.data) !== 'image/jpeg') {
    return error(400, 'invalid_page_format', 'Page image must be a JPEG.');
  }

  return withWritableTalk(input, async (ctx) => {
    const source = await getGreenfieldContextSourceById({
      workspaceId: ctx.workspaceId,
      talkId: input.talkId,
      sourceId: input.sourceId,
    });
    if (!source) return error(404, 'not_found', 'Source not found.');
    if (source.mimeType !== 'application/pdf') {
      return error(
        400,
        'source_not_pdf',
        'Page images can only be attached to PDF sources.',
      );
    }
    if (
      source.expectedPageCount !== null &&
      source.expectedPageCount !== total
    ) {
      return error(
        409,
        'page_total_mismatch',
        `Expected page count is already ${source.expectedPageCount}.`,
      );
    }

    const expectedPageCountSet = await setGreenfieldSourceExpectedPageCount({
      workspaceId: ctx.workspaceId,
      talkId: input.talkId,
      sourceId: input.sourceId,
      expectedPageCount: total,
    });
    if (!expectedPageCountSet) {
      return error(
        409,
        'page_total_mismatch',
        'Expected page count changed while uploading page image.',
      );
    }
    const pageAlreadyRecorded = (
      await listGreenfieldSourcePageIndices({
        workspaceId: ctx.workspaceId,
        sourceId: input.sourceId,
      })
    ).includes(pageIndex);
    if (pageAlreadyRecorded) {
      const uploaded = await countGreenfieldSourcePageImages({
        workspaceId: ctx.workspaceId,
        sourceId: input.sourceId,
      });
      return ok(
        { uploaded, expected: total, complete: uploaded === total },
        201,
      );
    }

    const storageKey = await savePageImage(
      input.talkId,
      input.sourceId,
      pageIndex,
      input.data,
    );
    try {
      await insertGreenfieldSourcePageImage({
        workspaceId: ctx.workspaceId,
        sourceId: input.sourceId,
        pageIndex,
        byteSize: input.data.length,
        payloadRef: storageKey,
      });
    } catch (err) {
      try {
        await deletePageImages(input.talkId, input.sourceId, [pageIndex]);
      } catch (cleanupErr) {
        logger.warn(
          { err: cleanupErr, sourceId: input.sourceId, storageKey },
          'greenfield context page image cleanup failed after metadata insert error',
        );
      }
      throw err;
    }
    const uploaded = await countGreenfieldSourcePageImages({
      workspaceId: ctx.workspaceId,
      sourceId: input.sourceId,
    });
    return ok({ uploaded, expected: total, complete: uploaded === total }, 201);
  });
}

export async function getGreenfieldTalkContextSourceContentRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  sourceId: string;
}): Promise<SourceContentResult> {
  if (!isUuid(input.sourceId)) {
    return error(400, 'invalid_source_id', 'Source id must be a UUID.');
  }
  return withTalkContent(input, async (ctx): Promise<SourceContentResult> => {
    const source = await getGreenfieldContextSourceById({
      workspaceId: ctx.workspaceId,
      talkId: input.talkId,
      sourceId: input.sourceId,
    });
    if (!source) return error(404, 'not_found', 'Source not found.');

    if (source.sourceType === 'file' && source.storageKey) {
      try {
        const content = await loadAttachmentFile(source.storageKey);
        return {
          statusCode: 200,
          body: content,
          headers: {
            'content-type': source.mimeType || 'application/octet-stream',
            'content-length': String(content.byteLength),
            'cache-control': 'private, max-age=31536000, immutable',
            'content-disposition': `inline; filename="${(source.fileName || 'file').replaceAll('"', '')}"`,
          },
        };
      } catch {
        return error(404, 'not_found', 'Source file not found on disk.');
      }
    }

    if (!source.extractedText) {
      return error(404, 'not_found', 'No content available for this source.');
    }
    return {
      statusCode: 200,
      body: source.extractedText,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': String(
          Buffer.byteLength(source.extractedText, 'utf-8'),
        ),
        'cache-control': 'private, no-cache',
      },
    };
  });
}
