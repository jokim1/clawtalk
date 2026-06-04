// Talk-level Google Drive resource bindings.
//
// Lane C of the PR2 plan (snazzy-crunching-quill.md). Restores the
// chassis-era "Bound Drive Resources" surface that the webapp Talk Tools
// sub-tab drives via webapp/src/lib/api.ts.
//
// API shape (frozen by the existing webapp client):
//   GET    /talks/:talkId/resources           → { talkId, bindings: [...] }
//   POST   /talks/:talkId/resources           → { binding: {...} }
//   DELETE /talks/:talkId/resources/:resourceId → { deleted: true }
//
// The DB accessor returns `TalkResourceBindingRecord` (bindingKind, talkId,
// ownerId), but the webapp `TalkResourceBinding` type only carries the
// {id, kind, externalId, displayName, metadata, createdAt, createdBy} subset
// using `kind` instead of `bindingKind`. `toApiBinding` projects the
// record into the API shape. Resource rows are Talk-shared: multiple editors
// can bind the same target, and the API exposes createdBy so the client can
// distinguish those rows when needed.
//
// C3 — edit-permission gate (security boundary):
//   POST and DELETE both call `canEditTalk(talkId)` before touching the
//   final connector tables. Connector writes are intentionally admin-only
//   under RLS, so the accessor performs trusted writes only after this route
//   has verified membership and Talk edit rights.

import { getDbPg, withUserContext } from '../../../db.js';
import {
  createTalkResourceBinding,
  deleteTalkResourceBinding,
  listTalkResourceBindings,
  type TalkResourceBindingKind,
  type TalkResourceBindingRecord,
} from '../../db/index.js';
import { ApiEnvelope, AuthContext } from '../types.js';

type JsonMap = Record<string, unknown>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ApiTalkResourceBinding {
  id: string;
  kind: TalkResourceBindingKind;
  externalId: string;
  displayName: string;
  metadata: JsonMap | null;
  createdAt: string;
  createdBy: string | null;
}

function toApiBinding(row: TalkResourceBindingRecord): ApiTalkResourceBinding {
  return {
    id: row.id,
    kind: row.bindingKind,
    externalId: row.externalId,
    displayName: row.displayName,
    metadata: row.metadata,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  };
}

function notFoundResponse(message: string): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 404,
    body: { ok: false, error: { code: 'not_found', message } },
  };
}

function forbiddenResponse(message: string): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 403,
    body: { ok: false, error: { code: 'forbidden', message } },
  };
}

function badRequest(
  code: string,
  message: string,
): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 400,
    body: { ok: false, error: { code, message } },
  };
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

const VALID_KINDS: ReadonlySet<TalkResourceBindingKind> = new Set([
  'google_drive_folder',
  'google_drive_file',
]);

async function getTalkAccess(input: {
  userId: string;
  talkId: string;
}): Promise<{
  workspaceId: string;
  createdBy: string;
  role: 'owner' | 'admin' | 'member' | 'guest';
} | null> {
  const db = getDbPg();
  const rows = await db<
    Array<{
      workspace_id: string;
      created_by: string;
      role: 'owner' | 'admin' | 'member' | 'guest';
    }>
  >`
    select t.workspace_id, t.created_by, wm.role
    from public.talks t
    join public.workspace_members wm
      on wm.workspace_id = t.workspace_id
     and wm.user_id = ${input.userId}::uuid
    where t.id = ${input.talkId}::uuid
    limit 1
  `;
  const row = rows[0];
  return row
    ? {
        workspaceId: row.workspace_id,
        createdBy: row.created_by,
        role: row.role,
      }
    : null;
}

function canEditTalkAccess(
  access: NonNullable<Awaited<ReturnType<typeof getTalkAccess>>>,
  userId: string,
): boolean {
  return (
    access.role !== 'guest' &&
    (access.role === 'owner' ||
      access.role === 'admin' ||
      access.createdBy === userId)
  );
}

// ---------------------------------------------------------------------------
// GET /api/v1/talks/:talkId/resources
// ---------------------------------------------------------------------------

export async function listTalkResourcesRoute(input: {
  auth: AuthContext;
  talkId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    bindings: ApiTalkResourceBinding[];
  }>;
}> {
  if (!isUuid(input.talkId)) {
    return badRequest('invalid_talk_id', 'talkId must be a valid UUID.');
  }
  return await withUserContext(input.auth.userId, async () => {
    const access = await getTalkAccess({
      userId: input.auth.userId,
      talkId: input.talkId,
    });
    if (!access) return notFoundResponse('Talk not found.');

    const rows = await listTalkResourceBindings(input.talkId);
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          talkId: input.talkId,
          bindings: rows.map(toApiBinding),
        },
      },
    };
  });
}

// ---------------------------------------------------------------------------
// POST /api/v1/talks/:talkId/resources
// ---------------------------------------------------------------------------

export async function createTalkGoogleDriveResourceRoute(input: {
  auth: AuthContext;
  talkId: string;
  body: {
    kind?: unknown;
    externalId?: unknown;
    displayName?: unknown;
    metadata?: unknown;
  };
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ binding: ApiTalkResourceBinding }>;
}> {
  if (!isUuid(input.talkId)) {
    return badRequest('invalid_talk_id', 'talkId must be a valid UUID.');
  }
  return await withUserContext(input.auth.userId, async () => {
    const access = await getTalkAccess({
      userId: input.auth.userId,
      talkId: input.talkId,
    });
    if (!access) return notFoundResponse('Talk not found.');
    // C3: connector writes are trusted server-side writes, so route-level
    // membership and Talk edit checks must pass before any insert.
    if (!canEditTalkAccess(access, input.auth.userId)) {
      return forbiddenResponse('You do not have permission to edit this talk.');
    }

    const rawKind =
      typeof input.body.kind === 'string' ? input.body.kind.trim() : '';
    if (!VALID_KINDS.has(rawKind as TalkResourceBindingKind)) {
      return badRequest(
        'invalid_binding_kind',
        'kind must be google_drive_folder or google_drive_file.',
      );
    }
    const bindingKind = rawKind as TalkResourceBindingKind;

    const externalId =
      typeof input.body.externalId === 'string'
        ? input.body.externalId.trim()
        : '';
    if (!externalId) {
      return badRequest('external_id_required', 'externalId is required.');
    }
    if (externalId.length > 512) {
      return badRequest(
        'external_id_too_long',
        'externalId must be 512 characters or fewer.',
      );
    }

    const displayName =
      typeof input.body.displayName === 'string'
        ? input.body.displayName.trim()
        : '';
    if (!displayName) {
      return badRequest('display_name_required', 'displayName is required.');
    }
    if (displayName.length > 512) {
      return badRequest(
        'display_name_too_long',
        'displayName must be 512 characters or fewer.',
      );
    }

    let metadata: JsonMap | null = null;
    if (input.body.metadata !== null && input.body.metadata !== undefined) {
      if (
        typeof input.body.metadata !== 'object' ||
        Array.isArray(input.body.metadata)
      ) {
        return badRequest(
          'invalid_metadata',
          'metadata must be a JSON object.',
        );
      }
      metadata = input.body.metadata as JsonMap;
    }

    const record = await createTalkResourceBinding({
      ownerId: input.auth.userId,
      talkId: input.talkId,
      bindingKind,
      externalId,
      displayName,
      metadata,
      createdBy: input.auth.userId,
    });

    return {
      statusCode: 201,
      body: { ok: true, data: { binding: toApiBinding(record) } },
    };
  });
}

// ---------------------------------------------------------------------------
// DELETE /api/v1/talks/:talkId/resources/:resourceId
// ---------------------------------------------------------------------------

export async function deleteTalkResourceRoute(input: {
  auth: AuthContext;
  talkId: string;
  resourceId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ deleted: true }>;
}> {
  if (!isUuid(input.talkId)) {
    return badRequest('invalid_talk_id', 'talkId must be a valid UUID.');
  }
  if (!isUuid(input.resourceId)) {
    return badRequest(
      'invalid_resource_id',
      'resourceId must be a valid UUID.',
    );
  }
  return await withUserContext(input.auth.userId, async () => {
    const access = await getTalkAccess({
      userId: input.auth.userId,
      talkId: input.talkId,
    });
    if (!access) return notFoundResponse('Talk not found.');
    if (!canEditTalkAccess(access, input.auth.userId)) {
      return forbiddenResponse('You do not have permission to edit this talk.');
    }

    const deleted = await deleteTalkResourceBinding(
      input.talkId,
      input.resourceId,
    );
    if (!deleted) {
      return notFoundResponse('Resource binding not found.');
    }

    return {
      statusCode: 200,
      body: { ok: true, data: { deleted: true } },
    };
  });
}
