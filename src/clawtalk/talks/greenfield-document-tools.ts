import { getDbPg, withTrustedDbWrites } from '../../db.js';
import type { LlmToolDefinition } from '../agents/llm-client.js';
import { withDocumentEditMutationLock } from '../documents/edit-locks.js';
import type { EffectiveToolAccess } from '../db/agent-accessors.js';
import {
  getGreenfieldDocumentForTalk,
  type GreenfieldDocumentBlockRecord,
  type GreenfieldDocumentRecord,
} from './greenfield-detail-accessors.js';
import { emitOutboxEvent } from './outbox-emit.js';

type GreenfieldDocumentToolResult = {
  result: string;
  isError?: boolean;
};

type ParsedGreenfieldDocumentBlock = {
  kind: GreenfieldDocumentBlockRecord['kind'];
  text: string;
};

const MAX_DOCUMENT_TOOL_TEXT_BYTES = 1_000_000;
const ENCODER = new TextEncoder();

export const GREENFIELD_DOCUMENT_EDIT_TOOL_FAMILY = 'document_edit';
export const GREENFIELD_DOCUMENT_EDIT_RUNTIME_TOOL = 'apply_content_edit';

export const GREENFIELD_APPLY_CONTENT_EDIT_TOOL: LlmToolDefinition = {
  name: GREENFIELD_DOCUMENT_EDIT_RUNTIME_TOOL,
  description: [
    "Edit the Talk's attached document directly. Your edit applies immediately as a pending change the user can Accept or Reject from the doc pane.",
    '',
    "Pick `kind`: 'append' adds one pending block after `anchor` (omit `anchor` to prepend at top); 'replace' overwrites the block at `anchor`; 'delete' removes the block at `anchor`.",
    '',
    'Anchors are the block ids shown in THE DOC section of the system prompt. When `@doc` appears in the latest user turn and the request changes the document, call this tool instead of describing the edit in chat.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['append', 'replace', 'delete'],
        description:
          "Edit scope. 'append' adds one pending block after anchor. 'replace' updates one block. 'delete' removes one block.",
      },
      anchor: {
        type: 'string',
        description:
          "Target block id from THE DOC. Required for 'replace' and 'delete'. Optional for 'append'.",
      },
      markdown: {
        type: 'string',
        description:
          "Markdown-ish text for the new content. Multi-paragraph input is kept together as one pending block until grouped edit acceptance lands. Required except for 'delete'.",
      },
      rationale: {
        type: 'string',
        description:
          'Optional short note explaining why this edit was made. Stored only in the tool result for now.',
      },
    },
    required: ['kind'],
  },
};

export function withGreenfieldDocumentEditToolAccess(
  effectiveTools: EffectiveToolAccess[],
): EffectiveToolAccess[] {
  const existing = effectiveTools.find(
    (tool) => tool.toolFamily === GREENFIELD_DOCUMENT_EDIT_TOOL_FAMILY,
  );
  if (existing) {
    return effectiveTools.map((tool) =>
      tool.toolFamily === GREENFIELD_DOCUMENT_EDIT_TOOL_FAMILY
        ? {
            ...tool,
            runtimeTools: Array.from(
              new Set([
                ...tool.runtimeTools,
                GREENFIELD_DOCUMENT_EDIT_RUNTIME_TOOL,
              ]),
            ),
            enabled: true,
            requiresApproval: false,
          }
        : tool,
    );
  }
  return [
    ...effectiveTools,
    {
      toolFamily: GREENFIELD_DOCUMENT_EDIT_TOOL_FAMILY,
      runtimeTools: [GREENFIELD_DOCUMENT_EDIT_RUNTIME_TOOL],
      enabled: true,
      requiresApproval: false,
    },
  ];
}

function byteLength(text: string): number {
  return ENCODER.encode(text).byteLength;
}

function normalizeDocumentToolText(value: string): string {
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (byteLength(normalized) > MAX_DOCUMENT_TOOL_TEXT_BYTES) {
    throw new Error(
      `Document edit text exceeds ${MAX_DOCUMENT_TOOL_TEXT_BYTES} bytes.`,
    );
  }
  return normalized;
}

function stripFenceMarkers(text: string): string {
  if (text.startsWith('```') && text.endsWith('```')) {
    return text.slice(3, -3).trim();
  }
  return text;
}

export function parseGreenfieldDocumentMarkdown(
  markdown: string,
): ParsedGreenfieldDocumentBlock[] {
  const normalized = normalizeDocumentToolText(markdown);
  if (!normalized) return [];
  return normalized
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part): ParsedGreenfieldDocumentBlock => {
      if (part.startsWith('# ')) {
        return { kind: 'h1', text: part.slice(2).trim() };
      }
      if (part.startsWith('## ')) {
        return { kind: 'h2', text: part.slice(3).trim() };
      }
      if (part.startsWith('- ')) {
        return { kind: 'li', text: part.slice(2).trim() };
      }
      if (part.startsWith('```')) {
        return { kind: 'code', text: stripFenceMarkers(part) };
      }
      return { kind: 'p', text: part };
    })
    .filter((block) => block.text.trim().length > 0);
}

function blockToMarkdown(block: ParsedGreenfieldDocumentBlock): string {
  if (block.kind === 'h1') return `# ${block.text}`;
  if (block.kind === 'h2') return `## ${block.text}`;
  if (block.kind === 'li') return `- ${block.text}`;
  if (block.kind === 'code') return `\`\`\`\n${block.text}\n\`\`\``;
  return block.text;
}

function collapseDocumentEditBlocks(
  blocks: ParsedGreenfieldDocumentBlock[],
): ParsedGreenfieldDocumentBlock {
  if (blocks.length === 1) return blocks[0]!;
  return {
    kind: 'p',
    text: blocks.map(blockToMarkdown).join('\n\n'),
  };
}

function requireBlock(
  document: GreenfieldDocumentRecord,
  blockId: string | null,
): GreenfieldDocumentBlockRecord | null {
  if (!blockId) return null;
  return document.blocks.find((block) => block.id === blockId) ?? null;
}

function buildGreenfieldDocumentOutline(
  document: GreenfieldDocumentRecord,
  options?: { allowEdits?: boolean },
): string {
  const allowEdits = options?.allowEdits !== false;
  const header = [
    `**The Doc - this Talk's attached document:** "${document.title}" (v${document.list_version}, ${document.format} format)`,
    '',
    'This Talk has exactly one long-form document attached. The block listing below is the canonical current document. When the user says "the doc", "the document", "this doc", or uses `@doc`, they mean THIS document, not a Google Doc binding or an uploaded source.',
  ].join('\n');
  const blocks =
    document.blocks.length > 0
      ? document.blocks
          .map((block) => {
            const body = block.text.trim() || '(empty block)';
            return `<!-- anchor:${block.id} -->\n[${block.kind}] ${body}`;
          })
          .join('\n\n')
      : '(empty document)';
  const footer = allowEdits
    ? [
        'To change this document, call `apply_content_edit({ kind, anchor?, markdown, rationale? })`. Your edit becomes a pending change the user can Accept or Reject from the doc pane.',
        '',
        'For `replace` and `delete`, copy the block id from an `<!-- anchor:<id> -->` line. For `append`, provide an anchor to insert after that block or omit it to prepend.',
        '',
        'When `@doc` appears in the latest user turn and the user is asking to add, rewrite, fix, polish, shorten, delete, or otherwise change the document, you MUST call `apply_content_edit` instead of writing the edit in chat.',
      ].join('\n')
    : 'This scheduled job may read and summarize the document, but scheduled jobs cannot edit the Talk document. If the prompt asks for a document edit, explain that interactive document edits must be made from a normal Talk turn.';
  return [header, blocks, footer].join('\n\n');
}

export async function loadGreenfieldDocumentContext(input: {
  workspaceId: string;
  talkId: string;
  allowEdits?: boolean;
}): Promise<{
  document: GreenfieldDocumentRecord | null;
  promptSection: string | null;
}> {
  const document = await getGreenfieldDocumentForTalk(input);
  if (!document) return { document: null, promptSection: null };
  return {
    document,
    promptSection: buildGreenfieldDocumentOutline(document, {
      allowEdits: input.allowEdits,
    }),
  };
}

async function insertGreenfieldDocumentEdit(input: {
  workspaceId: string;
  document: GreenfieldDocumentRecord;
  op: 'insert' | 'replace' | 'delete';
  blockId?: string | null;
  afterBlockId?: string | null;
  baseBlockVersion?: number | null;
  baseListVersion?: number | null;
  newKind?: GreenfieldDocumentBlockRecord['kind'] | null;
  newText?: string | null;
  agentId?: string | null;
  runId: string;
  source?: 'agent' | 'forge' | 'job';
}): Promise<string> {
  const rows = await withDocumentEditMutationLock(
    { workspaceId: input.workspaceId, documentId: input.document.id },
    (sql) =>
      withTrustedDbWrites(
        () => sql<{ id: string }[]>`
      insert into public.document_edits (
        workspace_id,
        document_id,
        tab_id,
        block_id,
        base_block_version,
        base_list_version,
        after_block_id,
        proposed_by_agent_id,
        proposed_by_run_id,
        op,
        new_kind,
        new_text,
        new_attrs_json,
        source
      )
      values (
        ${input.workspaceId}::uuid,
        ${input.document.id}::uuid,
        ${input.document.tab_id}::uuid,
        ${input.blockId ?? null}::uuid,
        ${input.baseBlockVersion ?? null},
        ${input.baseListVersion ?? null},
        ${input.afterBlockId ?? null}::uuid,
        ${input.agentId ?? null}::uuid,
        ${input.runId}::uuid,
        ${input.op},
        ${input.newKind ?? null},
        ${input.newText ?? null},
        ${sql.json({} as never)},
        ${input.source ?? 'agent'}
      )
      returning id
    `,
      ),
  );
  return rows[0]!.id;
}

export async function executeGreenfieldApplyContentEdit(input: {
  workspaceId: string;
  talkId: string;
  runId: string;
  agentId: string | null;
  agentNickname: string | null;
  messageId?: string | null;
  args: Record<string, unknown>;
}): Promise<GreenfieldDocumentToolResult> {
  const rawKind = input.args.kind;
  const rawAnchor = input.args.anchor;
  const rawMarkdown = input.args.markdown;
  const rawRationale = input.args.rationale;

  if (rawKind !== 'append' && rawKind !== 'replace' && rawKind !== 'delete') {
    return {
      result: "Error: `kind` must be one of 'append', 'replace', or 'delete'.",
      isError: true,
    };
  }
  if (
    rawAnchor !== null &&
    rawAnchor !== undefined &&
    typeof rawAnchor !== 'string'
  ) {
    return {
      result: 'Error: `anchor` must be a block id string or omitted.',
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
  if (rawKind !== 'delete' && typeof rawMarkdown !== 'string') {
    return {
      result:
        'Error: apply_content_edit requires a non-empty `markdown` string for this kind.',
      isError: true,
    };
  }

  const { document } = await loadGreenfieldDocumentContext({
    workspaceId: input.workspaceId,
    talkId: input.talkId,
  });
  if (!document) {
    return {
      result:
        'Error: this Talk has no attached document. Cannot apply an edit.',
      isError: true,
    };
  }

  const targetAnchorId =
    typeof rawAnchor === 'string' && rawAnchor.trim() ? rawAnchor.trim() : null;
  const targetBlock = requireBlock(document, targetAnchorId);
  if ((rawKind === 'replace' || rawKind === 'delete') && !targetBlock) {
    return {
      result: `Error: '${rawKind}' requires a current block \`anchor\` from THE DOC outline.`,
      isError: true,
    };
  }
  if (rawKind === 'append' && targetAnchorId && !targetBlock) {
    return {
      result: `Error: anchor "${targetAnchorId}" is not in the current document. Re-read THE DOC outline and use a current block id.`,
      isError: true,
    };
  }
  let blocks: ParsedGreenfieldDocumentBlock[] = [];
  if (rawKind !== 'delete') {
    try {
      blocks = parseGreenfieldDocumentMarkdown(rawMarkdown as string);
    } catch (error) {
      return {
        result:
          error instanceof Error ? `Error: ${error.message}` : String(error),
        isError: true,
      };
    }
    if (blocks.length === 0) {
      return {
        result:
          'Error: the supplied markdown is empty after parsing. Provide real content.',
        isError: true,
      };
    }
  }

  const editIds: string[] = [];
  if (rawKind === 'delete') {
    editIds.push(
      await insertGreenfieldDocumentEdit({
        workspaceId: input.workspaceId,
        document,
        op: 'delete',
        blockId: targetBlock!.id,
        baseBlockVersion: targetBlock!.version,
        agentId: input.agentId,
        runId: input.runId,
      }),
    );
  } else if (rawKind === 'replace') {
    const replacement = collapseDocumentEditBlocks(blocks);
    editIds.push(
      await insertGreenfieldDocumentEdit({
        workspaceId: input.workspaceId,
        document,
        op: 'replace',
        blockId: targetBlock!.id,
        baseBlockVersion: targetBlock!.version,
        newKind: replacement.kind,
        newText: replacement.text,
        agentId: input.agentId,
        runId: input.runId,
      }),
    );
  } else if (rawKind === 'append') {
    const appendBlock = collapseDocumentEditBlocks(blocks);
    editIds.push(
      await insertGreenfieldDocumentEdit({
        workspaceId: input.workspaceId,
        document,
        op: 'insert',
        afterBlockId: targetBlock?.id ?? null,
        baseListVersion: document.list_version,
        newKind: appendBlock.kind,
        newText: appendBlock.text,
        agentId: input.agentId,
        runId: input.runId,
      }),
    );
  }

  if (document.owner_id) {
    await emitOutboxEvent({
      topic: `talk:${input.talkId}`,
      eventType: 'content_edit_applied',
      payload: {
        contentId: document.id,
        runId: input.runId,
        editIds,
        agentId: input.agentId,
        agentNickname: input.agentNickname,
        messageId: input.messageId ?? null,
      },
      ownerIds: [document.owner_id],
    });
  }

  return {
    result: JSON.stringify({
      ok: true,
      contentId: document.id,
      runId: input.runId,
      editId: editIds[0] ?? null,
      editIds,
      kind: rawKind,
      rationale: typeof rawRationale === 'string' ? rawRationale : null,
    }),
  };
}
