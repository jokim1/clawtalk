// Content feature — typed accessors for the `contents` and
// `content_proposals` tables.
//
// Caller contract: every function below must run inside a
// `withUserContext(userId, ...)` block. RLS on both tables gates by
// `owner_id = auth.uid()`; the surrounding `withRequestScopedDb`
// scope opens the notify queue so outbox emits get flushed
// post-commit.
//
// The accept/update paths route the body through the shared
// `src/shared/rich-text/` module: markdown → Tiptap JSON → AST
// mutation → markdown. The anchor map is recomputed from the
// resulting JSON; the body and the map always ship together.

import { getDbPg } from '../../db.js';
import {
  ANCHOR_ATTR_KEY,
  type AnchorMap,
  type RichTextDocument,
  type RichTextNode,
  computeAnchorMap,
  ensureAnchorIds,
  findBlockIndexByAnchor,
  getAnchorId,
  insertAfterAnchor,
  markdownToTiptapJson,
  plainTextOf,
  replaceBlockByAnchor,
  sanitizeMarkdown,
  sanitizeRichTextDocument,
  stripAnchorCommentsFromMarkdown,
  structuralFingerprint,
  tiptapJsonToMarkdown,
} from '../../shared/rich-text/index.js';
import { emitOutboxEvent } from '../talks/outbox-emit.js';

export const CONTENT_BODY_BYTE_LIMIT = 512_000;
export type ProposalKind = 'append' | 'replace' | 'bulk';
export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'stale';

export interface ContentRecord {
  id: string;
  owner_id: string;
  talk_id: string;
  title: string;
  content_kind: string;
  content_format: string;
  body_markdown: string;
  body_version: number;
  anchor_map_json: AnchorMap;
  created_at: string;
  updated_at: string;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  updated_by_run_id: string | null;
}

export interface Content {
  id: string;
  ownerId: string;
  talkId: string;
  title: string;
  contentKind: string;
  contentFormat: string;
  bodyMarkdown: string;
  bodyVersion: number;
  anchorMap: AnchorMap;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  updatedByRunId: string | null;
}

export interface ContentProposalRecord {
  id: string;
  content_id: string;
  owner_id: string;
  proposed_by_run_id: string | null;
  proposed_by_agent_id: string | null;
  proposed_by_message_id: string | null;
  kind: ProposalKind;
  after_anchor_id: string | null;
  target_anchor_id: string | null;
  inserted_markdown: string;
  rationale: string | null;
  status: ProposalStatus;
  status_reason: string | null;
  base_content_version: number;
  base_anchor_content_hash: string | null;
  target_anchor_baseline_json: RichTextNode | null;
  applied_anchor_ids: string[];
  drift_detected: boolean;
  created_at: string;
  resolved_at: string | null;
  resolved_by_user_id: string | null;
}

export interface ContentProposal {
  id: string;
  contentId: string;
  proposedByRunId: string | null;
  proposedByAgentId: string | null;
  proposedByMessageId: string | null;
  kind: ProposalKind;
  afterAnchorId: string | null;
  targetAnchorId: string | null;
  insertedMarkdown: string;
  rationale: string | null;
  status: ProposalStatus;
  statusReason: string | null;
  baseContentVersion: number;
  baseAnchorContentHash: string | null;
  targetAnchorBaselineJson: RichTextNode | null;
  appliedAnchorIds: string[];
  driftDetected: boolean;
  createdAt: string;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
}

const PROPOSAL_COLUMNS = `
  id, content_id, owner_id, proposed_by_run_id,
  proposed_by_agent_id, proposed_by_message_id,
  kind, after_anchor_id, target_anchor_id,
  inserted_markdown, rationale,
  status, status_reason, base_content_version,
  base_anchor_content_hash, target_anchor_baseline_json,
  applied_anchor_ids, drift_detected,
  created_at, resolved_at, resolved_by_user_id
`;

function toContent(row: ContentRecord): Content {
  return {
    id: row.id,
    ownerId: row.owner_id,
    talkId: row.talk_id,
    title: row.title,
    contentKind: row.content_kind,
    contentFormat: row.content_format,
    bodyMarkdown: row.body_markdown,
    bodyVersion: row.body_version,
    anchorMap: row.anchor_map_json ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    updatedByRunId: row.updated_by_run_id,
  };
}

function toProposal(row: ContentProposalRecord): ContentProposal {
  return {
    id: row.id,
    contentId: row.content_id,
    proposedByRunId: row.proposed_by_run_id,
    proposedByAgentId: row.proposed_by_agent_id,
    proposedByMessageId: row.proposed_by_message_id,
    kind: row.kind,
    afterAnchorId: row.after_anchor_id,
    targetAnchorId: row.target_anchor_id,
    insertedMarkdown: row.inserted_markdown,
    rationale: row.rationale,
    status: row.status,
    statusReason: row.status_reason,
    baseContentVersion: row.base_content_version,
    baseAnchorContentHash: row.base_anchor_content_hash,
    targetAnchorBaselineJson: row.target_anchor_baseline_json,
    appliedAnchorIds: row.applied_anchor_ids ?? [],
    driftDetected: row.drift_detected ?? false,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedByUserId: row.resolved_by_user_id,
  };
}

function normalizeTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) throw new Error('Content title is required');
  return trimmed;
}

function byteLengthOf(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function nodeIsEmpty(node: RichTextNode | undefined): boolean {
  if (!node) return true;
  const text = plainTextOf(node).trim();
  if (text.length > 0) return false;
  // hr / empty paragraph after sanitize still counts as a real block if
  // structurally distinct, but for our "no-op proposal" guard we treat
  // a doc whose blocks all produce no plain text as empty.
  return true;
}

function documentIsEmpty(doc: RichTextDocument): boolean {
  const blocks = doc.content ?? [];
  if (blocks.length === 0) return true;
  return blocks.every(nodeIsEmpty);
}

// ── content CRUD ─────────────────────────────────────────────────

export async function createContent(input: {
  ownerId: string;
  talkId: string;
  title: string;
  createdByUserId?: string | null;
}): Promise<Content> {
  const title = normalizeTitle(input.title);
  const db = getDbPg();
  const rows = await db<ContentRecord[]>`
    insert into public.contents
      (owner_id, talk_id, title, content_kind, content_format,
       body_markdown, body_version, anchor_map_json,
       created_by_user_id, updated_by_user_id, updated_by_run_id)
    values
      (${input.ownerId}::uuid, ${input.talkId}::uuid, ${title},
       'document', 'markdown',
       '', 1, '{}'::jsonb,
       ${input.createdByUserId ?? null}::uuid,
       ${input.createdByUserId ?? null}::uuid,
       null)
    returning id, owner_id, talk_id, title, content_kind, content_format,
              body_markdown, body_version, anchor_map_json,
              created_at, updated_at,
              created_by_user_id, updated_by_user_id, updated_by_run_id
  `;
  return toContent(rows[0]);
}

export interface ContentSidebarRecord {
  id: string;
  talk_id: string;
  title: string;
  updated_at: string;
}

export async function listContentsForSidebar(): Promise<
  ContentSidebarRecord[]
> {
  const db = getDbPg();
  const rows = await db<ContentSidebarRecord[]>`
    select id, talk_id, title, updated_at
    from public.contents
    order by updated_at desc, id
  `;
  return rows;
}

export async function getContentByTalkId(
  talkId: string,
): Promise<Content | null> {
  const db = getDbPg();
  const rows = await db<ContentRecord[]>`
    select id, owner_id, talk_id, title, content_kind, content_format,
           body_markdown, body_version, anchor_map_json,
           created_at, updated_at,
           created_by_user_id, updated_by_user_id, updated_by_run_id
    from public.contents
    where talk_id = ${talkId}::uuid
    limit 1
  `;
  return rows[0] ? toContent(rows[0]) : null;
}

export async function getContentById(
  contentId: string,
): Promise<Content | null> {
  const db = getDbPg();
  const rows = await db<ContentRecord[]>`
    select id, owner_id, talk_id, title, content_kind, content_format,
           body_markdown, body_version, anchor_map_json,
           created_at, updated_at,
           created_by_user_id, updated_by_user_id, updated_by_run_id
    from public.contents
    where id = ${contentId}::uuid
    limit 1
  `;
  return rows[0] ? toContent(rows[0]) : null;
}

export type UpdateContentResult =
  | {
      kind: 'ok';
      content: Content;
      staledProposalIds: string[];
    }
  | { kind: 'conflict'; current: Content }
  | { kind: 'not_found' }
  | { kind: 'doc_size_limit'; wouldBeBytes: number };

export async function updateContentBody(input: {
  contentId: string;
  ownerId: string;
  expectedVersion: number;
  bodyMarkdown: string;
  title?: string;
  updatedByUserId?: string | null;
  updatedByRunId?: string | null;
}): Promise<UpdateContentResult> {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new Error('expectedVersion must be a positive integer');
  }

  const sanitized = sanitizeMarkdown(input.bodyMarkdown);
  if (byteLengthOf(sanitized) > CONTENT_BODY_BYTE_LIMIT) {
    return {
      kind: 'doc_size_limit',
      wouldBeBytes: byteLengthOf(sanitized),
    };
  }

  // Parse → re-stamp anchors → re-serialize so the markdown reflects
  // the canonical anchored shape regardless of what the client sent.
  const parsed = sanitizeRichTextDocument(markdownToTiptapJson(sanitized));
  const stamped = ensureAnchorIds(parsed);
  const canonicalMarkdown = tiptapJsonToMarkdown(stamped);
  if (byteLengthOf(canonicalMarkdown) > CONTENT_BODY_BYTE_LIMIT) {
    return {
      kind: 'doc_size_limit',
      wouldBeBytes: byteLengthOf(canonicalMarkdown),
    };
  }
  const anchorMap = await computeAnchorMap(stamped);

  const db = getDbPg();
  const existingRows = await db<ContentRecord[]>`
    select id, owner_id, talk_id, title, content_kind, content_format,
           body_markdown, body_version, anchor_map_json,
           created_at, updated_at,
           created_by_user_id, updated_by_user_id, updated_by_run_id
    from public.contents
    where id = ${input.contentId}::uuid
    limit 1
  `;
  const existing = existingRows[0];
  if (!existing) return { kind: 'not_found' };
  if (existing.body_version !== input.expectedVersion) {
    return { kind: 'conflict', current: toContent(existing) };
  }

  const nextTitle =
    input.title !== undefined ? normalizeTitle(input.title) : existing.title;

  const updatedRows = await db<ContentRecord[]>`
    update public.contents
    set body_markdown = ${canonicalMarkdown},
        body_version = body_version + 1,
        anchor_map_json = ${db.json(anchorMap as never)},
        title = ${nextTitle},
        updated_at = now(),
        updated_by_user_id = ${input.updatedByUserId ?? null}::uuid,
        updated_by_run_id = ${input.updatedByRunId ?? null}::uuid
    where id = ${input.contentId}::uuid
      and body_version = ${input.expectedVersion}
    returning id, owner_id, talk_id, title, content_kind, content_format,
              body_markdown, body_version, anchor_map_json,
              created_at, updated_at,
              created_by_user_id, updated_by_user_id, updated_by_run_id
  `;
  const updated = updatedRows[0];
  if (!updated) {
    // CAS lost. Refetch for the caller.
    const refetch = await db<ContentRecord[]>`
      select id, owner_id, talk_id, title, content_kind, content_format,
             body_markdown, body_version, anchor_map_json,
             created_at, updated_at,
             created_by_user_id, updated_by_user_id, updated_by_run_id
      from public.contents
      where id = ${input.contentId}::uuid
      limit 1
    `;
    if (!refetch[0]) return { kind: 'not_found' };
    return { kind: 'conflict', current: toContent(refetch[0]) };
  }

  // In the same transaction, mark stale:
  // - append/replace proposals whose anchor (after_anchor_id or
  //   target_anchor_id) no longer exists in the new anchor map. The `?`
  //   operator tests jsonb key existence at the top level —
  //   anchor_map_json is shaped `{ anchorId: { ... } }`, so this checks
  //   whether the anchor key is present.
  // - ALL pending bulk proposals on this content, because bulk proposes
  //   a whole-doc replacement against `base_content_version`; any user
  //   edit moves the base out from under the proposal and the user's
  //   approval would otherwise silently overwrite their fresh edits.
  const anchorMapJson = db.json(anchorMap as never);
  const staleRows = await db<{ id: string; reason: string }[]>`
    update public.content_proposals
    set status = 'stale',
        status_reason = case
          when kind = 'bulk' then 'doc_changed_since_bulk_proposal'
          else 'anchor_removed'
        end,
        resolved_at = now()
    where content_id = ${input.contentId}::uuid
      and status = 'pending'
      and (
        (after_anchor_id is not null
         and not (${anchorMapJson}::jsonb ? after_anchor_id))
        or (target_anchor_id is not null
            and not (${anchorMapJson}::jsonb ? target_anchor_id))
        or kind = 'bulk'
      )
    returning id, status_reason as reason
  `;
  const staledProposalIds = staleRows.map((r) => r.id);

  for (const row of staleRows) {
    await emitOutboxEvent({
      topic: `talk:${updated.talk_id}`,
      eventType: 'content_proposal_stale',
      payload: {
        contentId: updated.id,
        proposalId: row.id,
        reason: row.reason,
      },
      ownerIds: [updated.owner_id],
    });
  }

  await emitOutboxEvent({
    topic: `talk:${updated.talk_id}`,
    eventType: 'content_updated',
    payload: {
      contentId: updated.id,
      version: updated.body_version,
      appliedAnchorIds: [],
    },
    ownerIds: [updated.owner_id],
  });

  return {
    kind: 'ok',
    content: toContent(updated),
    staledProposalIds,
  };
}

// ── proposals ────────────────────────────────────────────────────

export async function getProposalById(
  proposalId: string,
): Promise<ContentProposal | null> {
  const db = getDbPg();
  const rows = await db<ContentProposalRecord[]>`
    select ${db.unsafe(PROPOSAL_COLUMNS)}
    from public.content_proposals
    where id = ${proposalId}::uuid
    limit 1
  `;
  return rows[0] ? toProposal(rows[0]) : null;
}

export async function listPendingProposalsByContentId(
  contentId: string,
): Promise<ContentProposal[]> {
  const db = getDbPg();
  const rows = await db<ContentProposalRecord[]>`
    select ${db.unsafe(PROPOSAL_COLUMNS)}
    from public.content_proposals
    where content_id = ${contentId}::uuid
      and status = 'pending'
    order by created_at asc, id asc
  `;
  return rows.map(toProposal);
}

export interface CreateProposalInput {
  contentId: string;
  ownerId: string;
  kind: ProposalKind;
  afterAnchorId: string | null;
  targetAnchorId?: string | null;
  insertedMarkdown: string;
  rationale?: string | null;
  proposedByRunId?: string | null;
  proposedByAgentId?: string | null;
  proposedByMessageId?: string | null;
}

export type CreateProposalResult =
  | { kind: 'ok'; proposal: ContentProposal }
  | { kind: 'content_not_found' }
  | { kind: 'anchor_missing'; anchorId: string }
  | { kind: 'empty_after_sanitize' }
  | { kind: 'invalid_kind_anchors' }
  | { kind: 'doc_size_limit'; wouldBeBytes: number };

export async function createProposal(
  input: CreateProposalInput,
): Promise<CreateProposalResult> {
  // Kind/anchor pairing — match the DB constraint client-side so we
  // surface a useful error code rather than a generic SQL violation.
  const targetAnchorId = input.targetAnchorId ?? null;
  if (input.kind === 'append' && targetAnchorId !== null) {
    return { kind: 'invalid_kind_anchors' };
  }
  if (input.kind === 'replace') {
    if (targetAnchorId === null) return { kind: 'invalid_kind_anchors' };
    if (input.afterAnchorId !== null) return { kind: 'invalid_kind_anchors' };
  }
  if (input.kind === 'bulk') {
    // Bulk replaces the whole body — no anchors involved.
    if (targetAnchorId !== null) return { kind: 'invalid_kind_anchors' };
    if (input.afterAnchorId !== null) return { kind: 'invalid_kind_anchors' };
  }

  if (byteLengthOf(input.insertedMarkdown) > CONTENT_BODY_BYTE_LIMIT) {
    return {
      kind: 'doc_size_limit',
      wouldBeBytes: byteLengthOf(input.insertedMarkdown),
    };
  }

  const db = getDbPg();
  const contentRows = await db<ContentRecord[]>`
    select id, owner_id, talk_id, title, content_kind, content_format,
           body_markdown, body_version, anchor_map_json,
           created_at, updated_at,
           created_by_user_id, updated_by_user_id, updated_by_run_id
    from public.contents
    where id = ${input.contentId}::uuid
    limit 1
  `;
  const content = contentRows[0];
  if (!content) return { kind: 'content_not_found' };

  // Strip agent-supplied anchor comments BEFORE sanitize so the agent
  // can't smuggle an anchor ID of its choosing through markdown comment
  // syntax; sanitizeMarkdown preserves anchor comments for the trusted
  // user-edit path, so it must not see them in agent input.
  const stripped = stripAnchorCommentsFromMarkdown(input.insertedMarkdown);
  const sanitizedInsert = sanitizeMarkdown(stripped);

  // Post-sanitize empty check: catches inputs like `<script></script>`
  // whose raw form trims non-empty but is empty once HTML is stripped
  // and parsed.
  const parsedInsert = sanitizeRichTextDocument(
    markdownToTiptapJson(sanitizedInsert),
  );
  if (documentIsEmpty(parsedInsert)) {
    return { kind: 'empty_after_sanitize' };
  }

  // Derive base_anchor_content_hash + target_anchor_baseline_json from
  // the content's current anchor block so the accept path can detect
  // both plain-text and structural drift.
  const anchorMap = content.anchor_map_json ?? {};
  let baseAnchorContentHash: string | null = null;
  let targetAnchorBaselineJson: RichTextNode | null = null;
  const anchorOfInterest =
    input.kind === 'append' ? input.afterAnchorId : targetAnchorId;

  if (anchorOfInterest !== null) {
    const entry = anchorMap[anchorOfInterest];
    if (!entry) {
      return { kind: 'anchor_missing', anchorId: anchorOfInterest };
    }
    baseAnchorContentHash = entry.content_hash ?? null;

    // Snapshot the target block's full Tiptap JSON so the accept path
    // can compare structural fingerprints, not just plain-text hashes.
    // Replace requires a baseline; append only stores it when an
    // anchor is present (for symmetric drift reporting downstream).
    const parsedCurrent = sanitizeRichTextDocument(
      markdownToTiptapJson(content.body_markdown),
    );
    const stampedCurrent = ensureAnchorIds(parsedCurrent);
    const idx = findBlockIndexByAnchor(stampedCurrent, anchorOfInterest);
    if (idx !== -1) {
      targetAnchorBaselineJson = stampedCurrent.content[idx] ?? null;
    }
  }

  const baselineJsonArg =
    targetAnchorBaselineJson === null
      ? null
      : db.json(targetAnchorBaselineJson as never);

  const rows = await db<ContentProposalRecord[]>`
    insert into public.content_proposals
      (content_id, owner_id, proposed_by_run_id, proposed_by_agent_id,
       proposed_by_message_id, kind, after_anchor_id, target_anchor_id,
       inserted_markdown, rationale, status, base_content_version,
       base_anchor_content_hash, target_anchor_baseline_json)
    values
      (${input.contentId}::uuid, ${input.ownerId}::uuid,
       ${input.proposedByRunId ?? null}::uuid,
       ${input.proposedByAgentId ?? null}::uuid,
       ${input.proposedByMessageId ?? null}::uuid,
       ${input.kind}, ${input.afterAnchorId}, ${targetAnchorId},
       ${sanitizedInsert}, ${input.rationale ?? null},
       'pending', ${content.body_version},
       ${baseAnchorContentHash}, ${baselineJsonArg})
    returning ${db.unsafe(PROPOSAL_COLUMNS)}
  `;
  const proposal = toProposal(rows[0]);

  await emitOutboxEvent({
    topic: `talk:${content.talk_id}`,
    eventType: 'content_proposal_created',
    payload: {
      contentId: content.id,
      proposalId: proposal.id,
      messageId: proposal.proposedByMessageId,
      kind: proposal.kind,
      afterAnchorId: proposal.afterAnchorId,
      targetAnchorId: proposal.targetAnchorId,
      agentId: proposal.proposedByAgentId,
    },
    ownerIds: [content.owner_id],
  });

  return { kind: 'ok', proposal };
}

export type AcceptProposalResult =
  | {
      kind: 'ok';
      content: Content;
      proposal: ContentProposal;
      driftDetected: boolean;
      staledSiblingProposalIds: string[];
    }
  | { kind: 'not_found' }
  | { kind: 'proposal_already_resolved'; status: ProposalStatus }
  | { kind: 'proposal_stale' }
  | { kind: 'anchor_missing'; anchorId: string }
  | { kind: 'version_conflict'; currentVersion: number }
  | { kind: 'doc_size_limit'; wouldBeBytes: number };

export async function acceptProposal(input: {
  contentId: string;
  proposalId: string;
  userId: string;
  expectedContentVersion?: number;
}): Promise<AcceptProposalResult> {
  const db = getDbPg();

  const proposalRows = await db<ContentProposalRecord[]>`
    select ${db.unsafe(PROPOSAL_COLUMNS)}
    from public.content_proposals
    where id = ${input.proposalId}::uuid
      and content_id = ${input.contentId}::uuid
    limit 1
  `;
  const proposal = proposalRows[0];
  if (!proposal) return { kind: 'not_found' };
  if (proposal.status !== 'pending') {
    return { kind: 'proposal_already_resolved', status: proposal.status };
  }

  const contentRows = await db<ContentRecord[]>`
    select id, owner_id, talk_id, title, content_kind, content_format,
           body_markdown, body_version, anchor_map_json,
           created_at, updated_at,
           created_by_user_id, updated_by_user_id, updated_by_run_id
    from public.contents
    where id = ${input.contentId}::uuid
    limit 1
  `;
  const content = contentRows[0];
  if (!content) return { kind: 'not_found' };

  // Enforce CAS up-front when the client supplied a version. Lets the
  // UI detect "your view is stale, refetch" before we do parse + insert
  // work that we'd have to throw away on conflict.
  if (
    input.expectedContentVersion !== undefined &&
    content.body_version !== input.expectedContentVersion
  ) {
    return {
      kind: 'version_conflict',
      currentVersion: content.body_version,
    };
  }

  // Parse the canonical body so we can locate the anchor block and
  // splice / replace.
  const parsedCurrent = sanitizeRichTextDocument(
    markdownToTiptapJson(content.body_markdown),
  );
  const parsedStamped = ensureAnchorIds(parsedCurrent);

  const interestedAnchorId =
    proposal.kind === 'append'
      ? proposal.after_anchor_id
      : proposal.kind === 'replace'
        ? proposal.target_anchor_id
        : null;

  // Bulk proposes a whole-doc replacement against base_content_version.
  // If the doc has moved since the proposal was made, accepting would
  // silently overwrite user (or other agent) edits made in the meantime.
  // updateContentBody auto-stales bulks on user edits, but other accept
  // paths don't, so the explicit check guards the agent-accept-then-
  // agent-accept race. Force the user to refresh and re-evaluate.
  if (
    proposal.kind === 'bulk' &&
    proposal.base_content_version !== content.body_version
  ) {
    await db`
      update public.content_proposals
      set status = 'stale',
          status_reason = 'doc_changed_since_bulk_proposal',
          resolved_at = now()
      where id = ${proposal.id}::uuid
    `;
    await emitOutboxEvent({
      topic: `talk:${content.talk_id}`,
      eventType: 'content_proposal_stale',
      payload: {
        contentId: content.id,
        proposalId: proposal.id,
        reason: 'doc_changed_since_bulk_proposal',
      },
      ownerIds: [content.owner_id],
    });
    return { kind: 'proposal_stale' };
  }

  if (interestedAnchorId !== null) {
    const idx = findBlockIndexByAnchor(parsedStamped, interestedAnchorId);
    if (idx === -1) {
      const staleReason =
        proposal.kind === 'replace'
          ? 'target_anchor_missing'
          : 'anchor_missing';
      await db`
        update public.content_proposals
        set status = 'stale',
            status_reason = ${staleReason},
            resolved_at = now()
        where id = ${proposal.id}::uuid
      `;
      await emitOutboxEvent({
        topic: `talk:${content.talk_id}`,
        eventType: 'content_proposal_stale',
        payload: {
          contentId: content.id,
          proposalId: proposal.id,
          reason: staleReason,
        },
        ownerIds: [content.owner_id],
      });
      return { kind: 'proposal_stale' };
    }
  }

  // Drift detection. Plain-text content_hash catches text edits; the
  // structural fingerprint compare catches heading-level / list-marker
  // / mark-structure changes the hash misses.
  let driftDetected = false;
  if (interestedAnchorId !== null) {
    if (proposal.base_anchor_content_hash) {
      const currentEntry = (content.anchor_map_json ?? {})[interestedAnchorId];
      if (
        currentEntry?.content_hash &&
        currentEntry.content_hash !== proposal.base_anchor_content_hash
      ) {
        driftDetected = true;
      }
    }
    if (!driftDetected && proposal.target_anchor_baseline_json) {
      const idx = findBlockIndexByAnchor(parsedStamped, interestedAnchorId);
      if (idx !== -1) {
        const currentFingerprint = structuralFingerprint(
          parsedStamped.content[idx],
        );
        const baselineFingerprint = structuralFingerprint(
          proposal.target_anchor_baseline_json,
        );
        if (currentFingerprint !== baselineFingerprint) {
          driftDetected = true;
        }
      }
    }
  }

  // Apply the patch. Inserted markdown was already sanitized at
  // createProposal time, but we re-strip anchor comments + re-sanitize
  // here so a hypothetical row inserted by some other path can't
  // smuggle anchors past the parse step.
  const cleanedInserted = stripAnchorCommentsFromMarkdown(
    proposal.inserted_markdown,
  );
  const insertedDocSanitized = sanitizeRichTextDocument(
    markdownToTiptapJson(sanitizeMarkdown(cleanedInserted)),
  );
  const insertedNodes: RichTextNode[] = insertedDocSanitized.content ?? [];

  let nextDoc: RichTextDocument;
  let appliedAnchorIds: string[];

  if (proposal.kind === 'append') {
    const insertResult = insertAfterAnchor({
      doc: parsedStamped,
      afterAnchorId: proposal.after_anchor_id,
      insertedNodes,
    });
    if ('kind' in insertResult && insertResult.kind === 'anchor_missing') {
      return {
        kind: 'anchor_missing',
        anchorId: proposal.after_anchor_id ?? '',
      };
    }
    nextDoc = (insertResult as { doc: RichTextDocument }).doc;
    appliedAnchorIds = (insertResult as { appliedAnchorIds: string[] })
      .appliedAnchorIds;
  } else if (proposal.kind === 'replace') {
    const replaceResult = replaceBlockByAnchor({
      doc: parsedStamped,
      targetAnchorId: proposal.target_anchor_id!,
      replacementNodes: insertedNodes,
    });
    if ('kind' in replaceResult && replaceResult.kind === 'anchor_missing') {
      return {
        kind: 'anchor_missing',
        anchorId: proposal.target_anchor_id ?? '',
      };
    }
    nextDoc = (replaceResult as { doc: RichTextDocument }).doc;
    appliedAnchorIds = (replaceResult as { appliedAnchorIds: string[] })
      .appliedAnchorIds;
  } else {
    // bulk: insertedNodes IS the entire new body. Clear any anchor
    // attrs leaking from the markdown parser, then let ensureAnchorIds
    // stamp fresh unique IDs across every block.
    const cleaned = insertedNodes.map((node) => {
      const attrs = { ...(node.attrs ?? {}) };
      delete attrs[ANCHOR_ATTR_KEY];
      return { ...node, attrs };
    });
    nextDoc = ensureAnchorIds({ ...parsedStamped, content: cleaned });
    appliedAnchorIds = (nextDoc.content ?? [])
      .map((node) => getAnchorId(node))
      .filter((id): id is string => id !== null);
  }

  const nextMarkdown = tiptapJsonToMarkdown(nextDoc);
  if (byteLengthOf(nextMarkdown) > CONTENT_BODY_BYTE_LIMIT) {
    return {
      kind: 'doc_size_limit',
      wouldBeBytes: byteLengthOf(nextMarkdown),
    };
  }
  const nextAnchorMap = await computeAnchorMap(nextDoc);

  const updatedRows = await db<ContentRecord[]>`
    update public.contents
    set body_markdown = ${nextMarkdown},
        body_version = body_version + 1,
        anchor_map_json = ${db.json(nextAnchorMap as never)},
        updated_at = now(),
        updated_by_user_id = ${input.userId}::uuid,
        updated_by_run_id = null
    where id = ${input.contentId}::uuid
      and body_version = ${content.body_version}
    returning id, owner_id, talk_id, title, content_kind, content_format,
              body_markdown, body_version, anchor_map_json,
              created_at, updated_at,
              created_by_user_id, updated_by_user_id, updated_by_run_id
  `;
  const updated = updatedRows[0];
  if (!updated) {
    // Another writer slipped in between our SELECT and UPDATE.
    const refetch = await db<ContentRecord[]>`
      select body_version from public.contents where id = ${input.contentId}::uuid
    `;
    return {
      kind: 'version_conflict',
      currentVersion: refetch[0]?.body_version ?? content.body_version,
    };
  }

  const resolvedRows = await db<ContentProposalRecord[]>`
    update public.content_proposals
    set status = 'accepted',
        resolved_at = now(),
        resolved_by_user_id = ${input.userId}::uuid,
        applied_anchor_ids = ${appliedAnchorIds},
        drift_detected = ${driftDetected}
    where id = ${proposal.id}::uuid
    returning ${db.unsafe(PROPOSAL_COLUMNS)}
  `;

  // Sibling-stale: when a replace lands, any other pending proposal
  // targeting the same anchor (replace) or anchored after it (append)
  // is now operating on stale terrain. The anchor_map check in
  // updateContentBody catches removed anchors, but a replace doesn't
  // necessarily remove the anchor (single-node replace inherits the
  // target's anchor ID). Mark same-anchor siblings explicitly.
  //
  // For append-on-anchor, the sibling's hash drifted but the anchor
  // is still present — we leave those pending so the user can
  // explicitly review them. Only same-target-anchor proposals get
  // auto-staled.
  let staledSiblingProposalIds: string[] = [];
  if (proposal.kind === 'replace' && proposal.target_anchor_id) {
    const siblingRows = await db<{ id: string }[]>`
      update public.content_proposals
      set status = 'stale',
          status_reason = 'target_replaced',
          resolved_at = now()
      where content_id = ${input.contentId}::uuid
        and status = 'pending'
        and id <> ${proposal.id}::uuid
        and target_anchor_id = ${proposal.target_anchor_id}
      returning id
    `;
    staledSiblingProposalIds = siblingRows.map((r) => r.id);
    for (const id of staledSiblingProposalIds) {
      await emitOutboxEvent({
        topic: `talk:${updated.talk_id}`,
        eventType: 'content_proposal_stale',
        payload: {
          contentId: updated.id,
          proposalId: id,
          reason: 'target_replaced',
        },
        ownerIds: [updated.owner_id],
      });
    }
  } else if (proposal.kind === 'bulk') {
    // A bulk replaces the whole document. Every other pending
    // proposal (append, replace, bulk) was authored against the old
    // body — they can no longer apply meaningfully. Stale them all.
    const siblingRows = await db<{ id: string }[]>`
      update public.content_proposals
      set status = 'stale',
          status_reason = 'superseded_by_bulk',
          resolved_at = now()
      where content_id = ${input.contentId}::uuid
        and status = 'pending'
        and id <> ${proposal.id}::uuid
      returning id
    `;
    staledSiblingProposalIds = siblingRows.map((r) => r.id);
    for (const id of staledSiblingProposalIds) {
      await emitOutboxEvent({
        topic: `talk:${updated.talk_id}`,
        eventType: 'content_proposal_stale',
        payload: {
          contentId: updated.id,
          proposalId: id,
          reason: 'superseded_by_bulk',
        },
        ownerIds: [updated.owner_id],
      });
    }
  }

  await emitOutboxEvent({
    topic: `talk:${updated.talk_id}`,
    eventType: 'content_updated',
    payload: {
      contentId: updated.id,
      version: updated.body_version,
      appliedAnchorIds,
    },
    ownerIds: [updated.owner_id],
  });

  return {
    kind: 'ok',
    content: toContent(updated),
    proposal: toProposal(resolvedRows[0]),
    driftDetected,
    staledSiblingProposalIds,
  };
}

export type RejectProposalResult =
  | { kind: 'ok'; proposal: ContentProposal }
  | { kind: 'not_found' }
  | { kind: 'proposal_already_resolved'; status: ProposalStatus };

export async function rejectProposal(input: {
  proposalId: string;
  userId: string;
}): Promise<RejectProposalResult> {
  const db = getDbPg();
  const existing = await db<ContentProposalRecord[]>`
    select ${db.unsafe(PROPOSAL_COLUMNS)}
    from public.content_proposals
    where id = ${input.proposalId}::uuid
    limit 1
  `;
  if (!existing[0]) return { kind: 'not_found' };
  if (existing[0].status !== 'pending') {
    return {
      kind: 'proposal_already_resolved',
      status: existing[0].status,
    };
  }
  const rows = await db<ContentProposalRecord[]>`
    update public.content_proposals
    set status = 'rejected',
        resolved_at = now(),
        resolved_by_user_id = ${input.userId}::uuid
    where id = ${input.proposalId}::uuid
      and status = 'pending'
    returning ${db.unsafe(PROPOSAL_COLUMNS)}
  `;
  if (!rows[0]) {
    // Concurrent resolution — refetch and report.
    const refetch = await getProposalById(input.proposalId);
    return refetch
      ? { kind: 'proposal_already_resolved', status: refetch.status }
      : { kind: 'not_found' };
  }
  return { kind: 'ok', proposal: toProposal(rows[0]) };
}
