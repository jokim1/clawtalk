import { getDbPg, withUserContext } from '../../../db.js';
import {
  archiveGreenfieldJob,
  createGreenfieldJob,
  createGreenfieldJobRunNow,
  getGreenfieldJob,
  listGreenfieldJobRuns,
  listGreenfieldJobs,
  patchGreenfieldJob,
  pauseGreenfieldJob,
  resumeGreenfieldJob,
  type GreenfieldJob,
  type GreenfieldJobRunSummary,
} from '../../talks/greenfield-job-accessors.js';
import { getGreenfieldTalk } from '../../talks/greenfield-accessors.js';
import {
  resolveWorkspaceForUser,
  type WorkspaceSummaryRecord,
} from '../../workspaces/accessors.js';
import { ensureWorkspaceBootstrapForUser } from '../../workspaces/bootstrap.js';
import type { GreenfieldTalkRecord } from '../../talks/greenfield-accessors.js';
import type { ApiEnvelope, AuthContext } from '../types.js';

type RouteResult<T> = {
  statusCode: number;
  body: ApiEnvelope<T>;
  scope?: {
    workspaceId: string;
    talkId: string;
  };
};

type WorkspaceContext = {
  workspace: WorkspaceSummaryRecord;
};

type TalkContext = WorkspaceContext & {
  talkId: string;
  talk: GreenfieldTalkRecord;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ok<T>(
  data: T,
  statusCode = 200,
  scope?: RouteResult<T>['scope'],
): RouteResult<T> {
  return { statusCode, body: { ok: true, data }, ...(scope ? { scope } : {}) };
}

function error(
  statusCode: number,
  code: string,
  message: string,
): RouteResult<never> {
  return { statusCode, body: { ok: false, error: { code, message } } };
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function badJob(errorValue: unknown): RouteResult<never> {
  return error(
    400,
    'invalid_job',
    errorValue instanceof Error ? errorValue.message : 'Invalid job.',
  );
}

function canEditTalkJobs(ctx: TalkContext, userId: string): boolean {
  return (
    ctx.workspace.role !== 'guest' &&
    (ctx.workspace.role === 'owner' ||
      ctx.workspace.role === 'admin' ||
      ctx.talk.created_by === userId)
  );
}

function requireJobEditAccess(
  ctx: TalkContext,
  userId: string,
): RouteResult<never> | null {
  if (canEditTalkJobs(ctx, userId)) return null;
  return error(
    403,
    'forbidden',
    'You do not have permission to edit jobs for this talk.',
  );
}

function requireJobOwnerAccess(
  job: GreenfieldJob,
  userId: string,
): RouteResult<never> | null {
  if (job.createdBy === userId) return null;
  return error(
    403,
    'forbidden',
    'Only the job creator can modify or run this job.',
  );
}

async function resolveVisibleTalkWorkspaceIdForCurrentUser(
  talkId: string,
): Promise<string | null> {
  const db = getDbPg();
  const rows = await db<{ workspace_id: string }[]>`
    select workspace_id
    from public.talks
    where id = ${talkId}::uuid
    order by created_at asc, id asc
    limit 1
  `;
  return rows[0]?.workspace_id ?? null;
}

async function withTalk<T>(
  input: {
    auth: AuthContext;
    workspaceId?: string | null;
    talkId: string;
  },
  fn: (ctx: TalkContext) => Promise<RouteResult<T>>,
): Promise<RouteResult<T>> {
  if (!isUuid(input.talkId)) {
    return error(400, 'invalid_talk_id', 'Talk id must be a UUID.');
  }
  if (input.workspaceId && !isUuid(input.workspaceId)) {
    return error(400, 'invalid_workspace_id', 'Workspace id must be a UUID.');
  }

  try {
    await ensureWorkspaceBootstrapForUser(input.auth.userId);
  } catch {
    return error(401, 'unauthorized', 'Session is not active.');
  }

  return await withUserContext(input.auth.userId, async () => {
    // Omitted workspace IDs resolve only through the caller's RLS-visible talks.
    const resolvedWorkspaceId =
      input.workspaceId ??
      (await resolveVisibleTalkWorkspaceIdForCurrentUser(input.talkId));
    const workspace = await resolveWorkspaceForUser({
      userId: input.auth.userId,
      requestedWorkspaceId: resolvedWorkspaceId,
    });
    if (!workspace) {
      return error(
        resolvedWorkspaceId ? 403 : 404,
        resolvedWorkspaceId ? 'workspace_forbidden' : 'workspace_not_found',
        resolvedWorkspaceId
          ? 'Workspace is not available to this user.'
          : 'No workspace exists for this user.',
      );
    }

    const talk = await getGreenfieldTalk({
      workspaceId: workspace.id,
      talkId: input.talkId,
    });
    if (!talk) return error(404, 'not_found', 'Talk not found.');

    const result = await fn({ workspace, talkId: input.talkId, talk });
    if (result.body.ok) {
      return {
        ...result,
        scope: { workspaceId: workspace.id, talkId: input.talkId },
      };
    }
    return result;
  });
}

export async function listGreenfieldTalkJobsRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
}): Promise<RouteResult<{ jobs: GreenfieldJob[] }>> {
  return withTalk(input, async (ctx) =>
    ok({
      jobs: await listGreenfieldJobs({
        workspaceId: ctx.workspace.id,
        talkId: ctx.talkId,
      }),
    }),
  );
}

export async function getGreenfieldTalkJobRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  jobId: string;
}): Promise<RouteResult<{ job: GreenfieldJob }>> {
  if (!isUuid(input.jobId)) {
    return error(400, 'invalid_job_id', 'Job id must be a UUID.');
  }
  return withTalk(input, async (ctx) => {
    const job = await getGreenfieldJob({
      workspaceId: ctx.workspace.id,
      talkId: ctx.talkId,
      jobId: input.jobId,
    });
    if (!job) return error(404, 'not_found', 'Job not found.');
    return ok({ job });
  });
}

export async function createGreenfieldTalkJobRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  title: string;
  prompt: string;
  agentId?: string;
  targetAgentId?: string;
  schedule?: unknown;
  scheduleJson?: unknown;
  timezone: string;
  sourceScope?: unknown;
  sourceScopeJson?: unknown;
  emitTalkMessage?: boolean;
  emitDocumentAppend?: boolean;
  catchUp?: unknown;
}): Promise<RouteResult<{ job: GreenfieldJob }>> {
  const agentId = input.agentId ?? input.targetAgentId ?? '';
  return withTalk(input, async (ctx) => {
    const denied = requireJobEditAccess(ctx, input.auth.userId);
    if (denied) return denied;
    try {
      const job = await createGreenfieldJob({
        workspaceId: ctx.workspace.id,
        talkId: ctx.talkId,
        title: input.title,
        prompt: input.prompt,
        agentId,
        schedule: input.scheduleJson ?? input.schedule,
        timezone: input.timezone,
        sourceScope: input.sourceScopeJson ?? input.sourceScope,
        emitTalkMessage: input.emitTalkMessage,
        emitDocumentAppend: input.emitDocumentAppend,
        catchUp: input.catchUp,
        createdBy: input.auth.userId,
      });
      return ok({ job }, 201);
    } catch (err) {
      return badJob(err);
    }
  });
}

export async function patchGreenfieldTalkJobRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  jobId: string;
  title?: string;
  prompt?: string;
  agentId?: string;
  targetAgentId?: string;
  schedule?: unknown;
  scheduleJson?: unknown;
  timezone?: string;
  sourceScope?: unknown;
  sourceScopeJson?: unknown;
  emitTalkMessage?: boolean;
  emitDocumentAppend?: boolean;
  catchUp?: unknown;
}): Promise<RouteResult<{ job: GreenfieldJob }>> {
  if (!isUuid(input.jobId)) {
    return error(400, 'invalid_job_id', 'Job id must be a UUID.');
  }
  return withTalk(input, async (ctx) => {
    const denied = requireJobEditAccess(ctx, input.auth.userId);
    if (denied) return denied;
    const current = await getGreenfieldJob({
      workspaceId: ctx.workspace.id,
      talkId: ctx.talkId,
      jobId: input.jobId,
    });
    if (!current) return error(404, 'not_found', 'Job not found.');
    const ownerDenied = requireJobOwnerAccess(current, input.auth.userId);
    if (ownerDenied) return ownerDenied;
    try {
      const job = await patchGreenfieldJob({
        workspaceId: ctx.workspace.id,
        talkId: ctx.talkId,
        jobId: input.jobId,
        title: input.title,
        prompt: input.prompt,
        agentId: input.agentId ?? input.targetAgentId,
        schedule: input.scheduleJson ?? input.schedule,
        timezone: input.timezone,
        sourceScope: input.sourceScopeJson ?? input.sourceScope,
        emitTalkMessage: input.emitTalkMessage,
        emitDocumentAppend: input.emitDocumentAppend,
        catchUp: input.catchUp,
      });
      if (!job) return error(404, 'not_found', 'Job not found.');
      return ok({ job });
    } catch (err) {
      return badJob(err);
    }
  });
}

export async function deleteGreenfieldTalkJobRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  jobId: string;
}): Promise<RouteResult<{ deleted: true }>> {
  if (!isUuid(input.jobId)) {
    return error(400, 'invalid_job_id', 'Job id must be a UUID.');
  }
  return withTalk(input, async (ctx) => {
    const denied = requireJobEditAccess(ctx, input.auth.userId);
    if (denied) return denied;
    const current = await getGreenfieldJob({
      workspaceId: ctx.workspace.id,
      talkId: ctx.talkId,
      jobId: input.jobId,
    });
    if (!current) return error(404, 'not_found', 'Job not found.');
    const ownerDenied = requireJobOwnerAccess(current, input.auth.userId);
    if (ownerDenied) return ownerDenied;
    const deleted = await archiveGreenfieldJob({
      workspaceId: ctx.workspace.id,
      talkId: ctx.talkId,
      jobId: input.jobId,
    });
    if (!deleted) return error(404, 'not_found', 'Job not found.');
    return ok({ deleted: true });
  });
}

export async function pauseGreenfieldTalkJobRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  jobId: string;
}): Promise<RouteResult<{ job: GreenfieldJob }>> {
  if (!isUuid(input.jobId)) {
    return error(400, 'invalid_job_id', 'Job id must be a UUID.');
  }
  return withTalk(input, async (ctx) => {
    const denied = requireJobEditAccess(ctx, input.auth.userId);
    if (denied) return denied;
    const current = await getGreenfieldJob({
      workspaceId: ctx.workspace.id,
      talkId: ctx.talkId,
      jobId: input.jobId,
    });
    if (!current) return error(404, 'not_found', 'Job not found.');
    const ownerDenied = requireJobOwnerAccess(current, input.auth.userId);
    if (ownerDenied) return ownerDenied;
    const job = await pauseGreenfieldJob({
      workspaceId: ctx.workspace.id,
      talkId: ctx.talkId,
      jobId: input.jobId,
    });
    if (!job) return error(404, 'not_found', 'Job not found.');
    return ok({ job });
  });
}

export async function resumeGreenfieldTalkJobRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  jobId: string;
}): Promise<RouteResult<{ job: GreenfieldJob }>> {
  if (!isUuid(input.jobId)) {
    return error(400, 'invalid_job_id', 'Job id must be a UUID.');
  }
  return withTalk(input, async (ctx) => {
    const denied = requireJobEditAccess(ctx, input.auth.userId);
    if (denied) return denied;
    const current = await getGreenfieldJob({
      workspaceId: ctx.workspace.id,
      talkId: ctx.talkId,
      jobId: input.jobId,
    });
    if (!current) return error(404, 'not_found', 'Job not found.');
    const ownerDenied = requireJobOwnerAccess(current, input.auth.userId);
    if (ownerDenied) return ownerDenied;
    const result = await resumeGreenfieldJob({
      workspaceId: ctx.workspace.id,
      talkId: ctx.talkId,
      jobId: input.jobId,
    });
    if (!result) return error(404, 'not_found', 'Job not found.');
    if ('blocked' in result) {
      return error(
        409,
        'job_blocked',
        'Blocked jobs must be edited before they can be resumed.',
      );
    }
    return ok({ job: result });
  });
}

export async function runGreenfieldTalkJobNowRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  jobId: string;
}): Promise<
  RouteResult<{
    job: GreenfieldJob;
    runId: string;
    triggerMessageId: null;
  }>
> {
  if (!isUuid(input.jobId)) {
    return error(400, 'invalid_job_id', 'Job id must be a UUID.');
  }
  return withTalk(input, async (ctx) => {
    const current = await getGreenfieldJob({
      workspaceId: ctx.workspace.id,
      talkId: ctx.talkId,
      jobId: input.jobId,
    });
    if (!current) return error(404, 'not_found', 'Job not found.');
    if (ctx.workspace.role === 'guest') {
      return error(
        403,
        'forbidden',
        'You do not have permission to run jobs for this talk.',
      );
    }
    const ownerDenied = requireJobOwnerAccess(current, input.auth.userId);
    if (ownerDenied) return ownerDenied;
    const result = await createGreenfieldJobRunNow({
      workspaceId: ctx.workspace.id,
      talkId: ctx.talkId,
      jobId: input.jobId,
      requestedBy: input.auth.userId,
    });
    switch (result.status) {
      case 'forbidden':
        return error(
          403,
          'forbidden',
          'Only the job creator can modify or run this job.',
        );
      case 'not_found':
        return error(404, 'not_found', 'Job not found.');
      case 'archived':
        return error(404, 'not_found', 'Job not found.');
      case 'blocked':
        return error(409, 'job_blocked', result.issue.message);
      case 'job_busy':
        return error(
          409,
          'job_busy',
          'This job already has an active queued or running run.',
        );
      case 'talk_busy':
        return error(
          409,
          'thread_busy',
          'A round is already in progress on this talk. Wait for it to finish or cancel before running the job.',
        );
      case 'enqueued':
        return ok(
          { job: result.job, runId: result.runId, triggerMessageId: null },
          202,
        );
    }
  });
}

export async function listGreenfieldTalkJobRunsRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  jobId: string;
  limit?: number;
}): Promise<RouteResult<{ runs: GreenfieldJobRunSummary[] }>> {
  if (!isUuid(input.jobId)) {
    return error(400, 'invalid_job_id', 'Job id must be a UUID.');
  }
  return withTalk(input, async (ctx) => {
    const job = await getGreenfieldJob({
      workspaceId: ctx.workspace.id,
      talkId: ctx.talkId,
      jobId: input.jobId,
      includeArchived: true,
    });
    if (!job) return error(404, 'not_found', 'Job not found.');
    return ok({
      runs: await listGreenfieldJobRuns({
        workspaceId: ctx.workspace.id,
        talkId: ctx.talkId,
        jobId: input.jobId,
        limit: input.limit,
      }),
    });
  });
}
