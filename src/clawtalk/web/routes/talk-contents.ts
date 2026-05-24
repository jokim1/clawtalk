import { withUserContext } from '../../../db.js';
import {
  CONTENT_BODY_BYTE_LIMIT,
  acceptProposal,
  createContent,
  getContentById,
  getContentByTalkId,
  getProposalById,
  getTalkForUser,
  listPendingProposalsByContentId,
  rejectProposal,
  updateContentBody,
  type Content,
  type ContentProposal,
} from '../../db/index.js';
import { canEditTalk } from '../middleware/acl.js';
import { ApiEnvelope, AuthContext } from '../types.js';

interface RouteResult<T> {
  statusCode: number;
  body: ApiEnvelope<T>;
}

function notFound(message: string): RouteResult<never> {
  return {
    statusCode: 404,
    body: { ok: false, error: { code: 'not_found', message } },
  };
}

function forbidden(message: string): RouteResult<never> {
  return {
    statusCode: 403,
    body: { ok: false, error: { code: 'forbidden', message } },
  };
}

function badRequest(code: string, message: string): RouteResult<never> {
  return {
    statusCode: 400,
    body: { ok: false, error: { code, message } },
  };
}

function versionConflict(currentVersion: number): RouteResult<never> {
  return {
    statusCode: 409,
    body: {
      ok: false,
      error: {
        code: 'version_conflict',
        message: 'This content changed since you started. Reload and retry.',
        details: { currentVersion },
      },
    },
  };
}

function anchorMissing(anchorId: string): RouteResult<never> {
  return {
    statusCode: 409,
    body: {
      ok: false,
      error: {
        code: 'anchor_missing',
        message: 'The target anchor no longer exists in the document.',
        details: { anchorId },
      },
    },
  };
}

function proposalStale(proposalId: string): RouteResult<never> {
  return {
    statusCode: 410,
    body: {
      ok: false,
      error: {
        code: 'proposal_stale',
        message:
          'The target block was removed before this proposal could be applied.',
        details: { proposalId, status: 'stale' },
      },
    },
  };
}

function proposalAlreadyResolved(
  proposalId: string,
  status: string,
): RouteResult<never> {
  return {
    statusCode: 410,
    body: {
      ok: false,
      error: {
        code: 'proposal_already_resolved',
        message: `Proposal is already ${status}.`,
        details: { proposalId, status },
      },
    },
  };
}

function docSizeLimit(wouldBeBytes: number): RouteResult<never> {
  return {
    statusCode: 413,
    body: {
      ok: false,
      error: {
        code: 'doc_size_limit',
        message: 'Document body exceeds the size limit.',
        details: {
          limitBytes: CONTENT_BODY_BYTE_LIMIT,
          wouldBeBytes,
        },
      },
    },
  };
}

export async function getTalkContentRoute(input: {
  auth: AuthContext;
  talkId: string;
}): Promise<
  RouteResult<{ content: Content | null; pendingProposals: ContentProposal[] }>
> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
    if (!talk) return notFound('Talk not found.');

    const content = await getContentByTalkId(input.talkId);
    if (!content) {
      return {
        statusCode: 200,
        body: { ok: true, data: { content: null, pendingProposals: [] } },
      };
    }
    const pendingProposals = await listPendingProposalsByContentId(content.id);
    return {
      statusCode: 200,
      body: { ok: true, data: { content, pendingProposals } },
    };
  });
}

export async function createTalkContentRoute(input: {
  auth: AuthContext;
  talkId: string;
  title?: unknown;
}): Promise<RouteResult<{ content: Content }>> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
    if (!talk) return notFound('Talk not found.');
    if (!(await canEditTalk(input.talkId))) {
      return forbidden('You do not have permission to edit this talk.');
    }

    if (typeof input.title !== 'string' || !input.title.trim()) {
      return badRequest('title_required', 'Content title is required.');
    }

    const existing = await getContentByTalkId(input.talkId);
    if (existing) {
      return {
        statusCode: 409,
        body: {
          ok: false,
          error: {
            code: 'content_already_exists',
            message: 'This talk already has a content document.',
            details: { contentId: existing.id },
          },
        },
      };
    }

    try {
      const content = await createContent({
        ownerId: input.auth.userId,
        talkId: input.talkId,
        title: input.title,
        createdByUserId: input.auth.userId,
      });
      return {
        statusCode: 201,
        body: { ok: true, data: { content } },
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to create content.';
      return badRequest('invalid_content', message);
    }
  });
}

export async function patchContentRoute(input: {
  auth: AuthContext;
  contentId: string;
  expectedVersion?: unknown;
  bodyMarkdown?: unknown;
  title?: unknown;
}): Promise<RouteResult<{ content: Content; staledProposalIds: string[] }>> {
  return await withUserContext(input.auth.userId, async () => {
    if (
      typeof input.expectedVersion !== 'number' ||
      !Number.isInteger(input.expectedVersion) ||
      input.expectedVersion < 1
    ) {
      return badRequest(
        'expected_version_required',
        'PATCH requires a positive integer expectedVersion.',
      );
    }
    if (
      typeof input.bodyMarkdown !== 'string' &&
      typeof input.title !== 'string'
    ) {
      return badRequest(
        'empty_patch',
        'PATCH must include bodyMarkdown and/or title.',
      );
    }

    const existing = await getContentById(input.contentId);
    if (!existing) return notFound('Content not found.');
    if (!(await canEditTalk(existing.talkId))) {
      return forbidden('You do not have permission to edit this talk.');
    }

    try {
      const result = await updateContentBody({
        contentId: input.contentId,
        ownerId: input.auth.userId,
        expectedVersion: input.expectedVersion,
        bodyMarkdown:
          typeof input.bodyMarkdown === 'string'
            ? input.bodyMarkdown
            : existing.bodyMarkdown,
        title: typeof input.title === 'string' ? input.title : undefined,
        updatedByUserId: input.auth.userId,
      });
      if (result.kind === 'not_found') return notFound('Content not found.');
      if (result.kind === 'conflict') {
        return versionConflict(result.current.bodyVersion);
      }
      if (result.kind === 'doc_size_limit') {
        return docSizeLimit(result.wouldBeBytes);
      }
      return {
        statusCode: 200,
        body: {
          ok: true,
          data: {
            content: result.content,
            staledProposalIds: result.staledProposalIds,
          },
        },
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to update content.';
      return badRequest('invalid_content', message);
    }
  });
}

export async function getContentProposalRoute(input: {
  auth: AuthContext;
  contentId: string;
  proposalId: string;
}): Promise<RouteResult<{ proposal: ContentProposal }>> {
  return await withUserContext(input.auth.userId, async () => {
    const content = await getContentById(input.contentId);
    if (!content) return notFound('Content not found.');
    const proposal = await getProposalById(input.proposalId);
    if (!proposal || proposal.contentId !== input.contentId) {
      return notFound('Proposal not found.');
    }
    return {
      statusCode: 200,
      body: { ok: true, data: { proposal } },
    };
  });
}

export async function acceptContentProposalRoute(input: {
  auth: AuthContext;
  contentId: string;
  proposalId: string;
  expectedContentVersion?: unknown;
}): Promise<
  RouteResult<{
    content: Content;
    proposal: ContentProposal;
    driftDetected: boolean;
  }>
> {
  return await withUserContext(input.auth.userId, async () => {
    const content = await getContentById(input.contentId);
    if (!content) return notFound('Content not found.');
    if (!(await canEditTalk(content.talkId))) {
      return forbidden('You do not have permission to edit this talk.');
    }

    const expected =
      typeof input.expectedContentVersion === 'number'
        ? input.expectedContentVersion
        : undefined;

    const result = await acceptProposal({
      contentId: input.contentId,
      proposalId: input.proposalId,
      userId: input.auth.userId,
      expectedContentVersion: expected,
    });

    switch (result.kind) {
      case 'not_found':
        return notFound('Proposal not found.');
      case 'proposal_already_resolved':
        return proposalAlreadyResolved(input.proposalId, result.status);
      case 'proposal_stale':
        return proposalStale(input.proposalId);
      case 'anchor_missing':
        return anchorMissing(result.anchorId);
      case 'version_conflict':
        return versionConflict(result.currentVersion);
      case 'doc_size_limit':
        return docSizeLimit(result.wouldBeBytes);
      case 'ok':
        return {
          statusCode: 200,
          body: {
            ok: true,
            data: {
              content: result.content,
              proposal: result.proposal,
              driftDetected: result.driftDetected,
            },
          },
        };
    }
  });
}

export async function rejectContentProposalRoute(input: {
  auth: AuthContext;
  contentId: string;
  proposalId: string;
}): Promise<RouteResult<{ proposal: ContentProposal }>> {
  return await withUserContext(input.auth.userId, async () => {
    const content = await getContentById(input.contentId);
    if (!content) return notFound('Content not found.');
    if (!(await canEditTalk(content.talkId))) {
      return forbidden('You do not have permission to edit this talk.');
    }

    const result = await rejectProposal({
      proposalId: input.proposalId,
      userId: input.auth.userId,
    });
    switch (result.kind) {
      case 'not_found':
        return notFound('Proposal not found.');
      case 'proposal_already_resolved':
        return proposalAlreadyResolved(input.proposalId, result.status);
      case 'ok':
        return {
          statusCode: 200,
          body: { ok: true, data: { proposal: result.proposal } },
        };
    }
  });
}
