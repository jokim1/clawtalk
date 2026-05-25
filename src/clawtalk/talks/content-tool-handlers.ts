// Tool handlers for the Content feature.
//
// `propose_content_append` adds a new block to the Talk's attached
// document; `propose_content_replace` substitutes the contents of an
// existing block. The user accepts or rejects via the ProposalCard UI;
// the accept path applies the patch with CAS + drift detection.

import { createProposal, getContentByTalkId } from '../db/content-accessors.js';

export interface ProposeContentToolInput {
  talkId: string;
  userId: string;
  runId: string | null;
  agentId: string | null;
  messageId?: string | null;
  args: Record<string, unknown>;
}

export type ToolResult = {
  result: string;
  isError?: boolean;
};

export async function executeProposeContentAppend(
  input: ProposeContentToolInput,
): Promise<ToolResult> {
  const rawAnchor = input.args.after_anchor_id;
  const rawMarkdown = input.args.markdown;
  const rawRationale = input.args.rationale;

  if (typeof rawMarkdown !== 'string' || rawMarkdown.trim().length === 0) {
    return {
      result:
        'Error: propose_content_append requires a non-empty `markdown` string.',
      isError: true,
    };
  }
  if (
    rawAnchor !== null &&
    rawAnchor !== undefined &&
    typeof rawAnchor !== 'string'
  ) {
    return {
      result:
        'Error: `after_anchor_id` must be a string anchor ID, or null to prepend at the top.',
      isError: true,
    };
  }
  if (
    rawRationale !== null &&
    rawRationale !== undefined &&
    typeof rawRationale !== 'string'
  ) {
    return {
      result: 'Error: `rationale` must be a string when provided.',
      isError: true,
    };
  }

  const content = await getContentByTalkId(input.talkId);
  if (!content) {
    return {
      result:
        'Error: this Talk has no attached document. Cannot propose an append.',
      isError: true,
    };
  }

  const afterAnchorId =
    typeof rawAnchor === 'string' && rawAnchor.length > 0 ? rawAnchor : null;

  const result = await createProposal({
    contentId: content.id,
    ownerId: content.ownerId,
    kind: 'append',
    afterAnchorId,
    insertedMarkdown: rawMarkdown,
    rationale: typeof rawRationale === 'string' ? rawRationale : null,
    proposedByRunId: input.runId,
    proposedByAgentId: input.agentId ?? null,
    proposedByMessageId: input.messageId ?? null,
  });

  switch (result.kind) {
    case 'content_not_found':
      return {
        result: 'Error: the attached document was not found.',
        isError: true,
      };
    case 'anchor_missing':
      return {
        result: `Error: anchor "${result.anchorId}" is not in the current document. Re-read the outline and propose against a current anchor.`,
        isError: true,
      };
    case 'empty_after_sanitize':
      return {
        result:
          'Error: the proposed markdown is empty after sanitization. Provide real content (no HTML-only payloads).',
        isError: true,
      };
    case 'invalid_kind_anchors':
      return {
        result:
          'Error: append proposals must use `after_anchor_id`, not `target_anchor_id`.',
        isError: true,
      };
    case 'doc_size_limit':
      return {
        result: `Error: the proposed markdown would push the document past the size limit (would be ${result.wouldBeBytes} bytes).`,
        isError: true,
      };
    case 'ok':
      return {
        result: JSON.stringify({
          proposalId: result.proposal.id,
          status: result.proposal.status,
          kind: 'append',
          afterAnchorId: result.proposal.afterAnchorId,
          contentId: content.id,
        }),
      };
  }
}

export async function executeProposeContentBulk(
  input: ProposeContentToolInput,
): Promise<ToolResult> {
  const rawMarkdown = input.args.markdown;
  const rawSummary = input.args.summary;
  const rawRationale = input.args.rationale;

  if (typeof rawMarkdown !== 'string' || rawMarkdown.trim().length === 0) {
    return {
      result:
        'Error: propose_content_bulk requires a non-empty `markdown` string (the entire new document body).',
      isError: true,
    };
  }
  if (typeof rawSummary !== 'string' || rawSummary.trim().length === 0) {
    return {
      result:
        'Error: `summary` is required for propose_content_bulk — give the user one short sentence describing what changed (e.g. "Tighten sections 2-3 and add a closing paragraph"). This is the only preview shown on the card.',
      isError: true,
    };
  }
  if (
    rawRationale !== null &&
    rawRationale !== undefined &&
    typeof rawRationale !== 'string'
  ) {
    return {
      result: 'Error: `rationale` must be a string when provided.',
      isError: true,
    };
  }

  const content = await getContentByTalkId(input.talkId);
  if (!content) {
    return {
      result:
        'Error: this Talk has no attached document. Cannot propose a bulk rewrite.',
      isError: true,
    };
  }

  // The summary is the user-visible card text. If a longer rationale
  // is also provided, append it after the summary in the rationale
  // field so the card can surface both (summary as the headline).
  const combinedRationale = rawRationale
    ? `${rawSummary.trim()}\n\n${rawRationale.trim()}`
    : rawSummary.trim();

  const result = await createProposal({
    contentId: content.id,
    ownerId: content.ownerId,
    kind: 'bulk',
    afterAnchorId: null,
    targetAnchorId: null,
    insertedMarkdown: rawMarkdown,
    rationale: combinedRationale,
    proposedByRunId: input.runId,
    proposedByAgentId: input.agentId ?? null,
    proposedByMessageId: input.messageId ?? null,
  });

  switch (result.kind) {
    case 'content_not_found':
      return {
        result: 'Error: the attached document was not found.',
        isError: true,
      };
    case 'anchor_missing':
      return {
        result:
          'Error: bulk proposals should not reference an anchor — please retry without anchor fields.',
        isError: true,
      };
    case 'empty_after_sanitize':
      return {
        result:
          'Error: the proposed body is empty after sanitization. Provide real content (no HTML-only payloads).',
        isError: true,
      };
    case 'invalid_kind_anchors':
      return {
        result:
          'Error: bulk proposals must not set `after_anchor_id` or `target_anchor_id` — they replace the entire document body.',
        isError: true,
      };
    case 'doc_size_limit':
      return {
        result: `Error: the proposed body exceeds the document size limit (would be ${result.wouldBeBytes} bytes).`,
        isError: true,
      };
    case 'ok':
      return {
        result: JSON.stringify({
          proposalId: result.proposal.id,
          status: result.proposal.status,
          kind: 'bulk',
          contentId: content.id,
        }),
      };
  }
}

export async function executeProposeContentReplace(
  input: ProposeContentToolInput,
): Promise<ToolResult> {
  const rawTarget = input.args.target_anchor_id;
  const rawMarkdown = input.args.markdown;
  const rawRationale = input.args.rationale;

  if (typeof rawMarkdown !== 'string' || rawMarkdown.trim().length === 0) {
    return {
      result:
        'Error: propose_content_replace requires a non-empty `markdown` string.',
      isError: true,
    };
  }
  if (typeof rawTarget !== 'string' || rawTarget.length === 0) {
    return {
      result:
        'Error: `target_anchor_id` must be the anchor ID of the block to replace, copied verbatim from the Doc outline.',
      isError: true,
    };
  }
  if (
    rawRationale !== null &&
    rawRationale !== undefined &&
    typeof rawRationale !== 'string'
  ) {
    return {
      result: 'Error: `rationale` must be a string when provided.',
      isError: true,
    };
  }

  const content = await getContentByTalkId(input.talkId);
  if (!content) {
    return {
      result:
        'Error: this Talk has no attached document. Cannot propose a replace.',
      isError: true,
    };
  }

  const result = await createProposal({
    contentId: content.id,
    ownerId: content.ownerId,
    kind: 'replace',
    afterAnchorId: null,
    targetAnchorId: rawTarget,
    insertedMarkdown: rawMarkdown,
    rationale: typeof rawRationale === 'string' ? rawRationale : null,
    proposedByRunId: input.runId,
    proposedByAgentId: input.agentId ?? null,
    proposedByMessageId: input.messageId ?? null,
  });

  switch (result.kind) {
    case 'content_not_found':
      return {
        result: 'Error: the attached document was not found.',
        isError: true,
      };
    case 'anchor_missing':
      return {
        result: `Error: target anchor "${result.anchorId}" is not in the current document. Re-read the outline and propose against a current anchor.`,
        isError: true,
      };
    case 'empty_after_sanitize':
      return {
        result:
          'Error: the proposed markdown is empty after sanitization. Provide real content (no HTML-only payloads).',
        isError: true,
      };
    case 'invalid_kind_anchors':
      return {
        result:
          'Error: replace proposals must use `target_anchor_id` and must not set `after_anchor_id`.',
        isError: true,
      };
    case 'doc_size_limit':
      return {
        result: `Error: the proposed markdown would push the document past the size limit (would be ${result.wouldBeBytes} bytes).`,
        isError: true,
      };
    case 'ok':
      return {
        result: JSON.stringify({
          proposalId: result.proposal.id,
          status: result.proposal.status,
          kind: 'replace',
          targetAnchorId: result.proposal.targetAnchorId,
          contentId: content.id,
        }),
      };
  }
}
