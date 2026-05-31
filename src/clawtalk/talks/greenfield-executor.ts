import { getDbPg } from '../../db.js';
import { logger } from '../../logger.js';
import {
  executeWithResolvedAgent,
  type ExecutionContext,
  type ExecutionEvent,
} from '../agents/agent-router.js';
import type { LlmContentBlock, LlmMessage } from '../agents/llm-client.js';
import {
  buildEffectiveToolsFromTalkToolRows,
  listUserToolPermissionsForUser,
  type EffectiveToolAccess,
  type RegisteredAgentRecord,
} from '../db/agent-accessors.js';
import { resolveModelCapabilities } from '../llm/capabilities.js';
import {
  encodedSizeBytes,
  MAX_RASTER_PAGES,
  MAX_TOTAL_RASTER_PAYLOAD_BYTES,
} from '../../shared/attachment-caps.js';
import { loadPageImage } from './attachment-storage.js';
import {
  TalkExecutorError,
  type TalkExecutionEvent,
  type TalkExecutor,
  type TalkExecutorInput,
  type TalkExecutorOutput,
} from './executor.js';

type GreenfieldExecutorRunRow = {
  id: string;
  workspace_id: string;
  talk_id: string;
  talk_title: string;
  talk_mode: 'ordered' | 'parallel';
  round: number;
  status: string;
  model_id: string;
  provider_id: string;
  context_window_tokens: number;
  requested_by: string;
  response_group_id: string;
  sequence_index: number;
  agent_snapshot_id: string;
  source_agent_id: string | null;
  role_key: string;
  agent_name: string | null;
  handle: string | null;
  persona: string | null;
  focus: string | null;
  method: string[] | null;
  tool_manifest_json: unknown | null;
};

type GreenfieldHistoryMessageRow = {
  id: string;
  author_kind: 'user' | 'agent';
  body: string | null;
  agent_name: string | null;
};

type GreenfieldContextSourceRow = {
  id: string;
  kind: string;
  name: string;
  extracted_text: string | null;
  summary: string | null;
  mime_type: string | null;
  expected_page_count: number | null;
  page_image_count: number;
  page_indices: number[];
  page_byte_sizes: number[];
  sort_order: number | null;
  source_ref: string | null;
  compat_kind: string | null;
};

type GreenfieldContextSourceView = GreenfieldContextSourceRow & {
  displayRef: string | null;
  displayLabel: string;
};

type GreenfieldPdfPageSource = {
  sourceId: string;
  sourceRef: string;
  title: string;
  totalPages: number;
  pageIndices: number[];
  truncatedReason: 'image-limit' | 'payload-budget' | null;
};

type PriorOrderedOutput = {
  sequenceIndex: number;
  agentId: string | null;
  agentNickname: string | null;
  content: string;
};

type PriorOrderedGap = {
  sequenceIndex: number;
  agentId: string | null;
  agentNickname: string | null;
  status: string;
};

const CHARS_TO_TOKENS = 0.25;
const MAX_HISTORY_MESSAGES = 24;
const MAX_SOURCE_CHARS = 12_000;
const MAX_ORDERED_PRIOR_OUTPUT_CHARS = 24_000;
const ESTIMATED_IMAGE_BLOCK_TOKENS = 3_000;
const ESTIMATED_DOCUMENT_BLOCK_TOKENS = 8_000;
const OMITTED_CONTEXT_MARKER = '[omitted due to context window]';
const TRUNCATED_CONTEXT_SUFFIX = '\n\n[truncated for context window]';

function estimateTokens(text: string): number {
  return Math.ceil(text.length * CHARS_TO_TOKENS);
}

function truncateText(text: string, maxChars: number): string {
  if (maxChars <= 0) return OMITTED_CONTEXT_MARKER;
  if (text.length <= maxChars) return text;
  if (maxChars <= TRUNCATED_CONTEXT_SUFFIX.length) {
    return TRUNCATED_CONTEXT_SUFFIX.slice(0, maxChars);
  }
  return `${text.slice(0, maxChars - TRUNCATED_CONTEXT_SUFFIX.length).trimEnd()}${TRUNCATED_CONTEXT_SUFFIX}`;
}

function buildSnapshotSystemPrompt(run: GreenfieldExecutorRunRow): string {
  const name = run.agent_name?.trim() || 'Agent';
  const sections = [`You are ${name} in ClawTalk.`, `Role: ${run.role_key}.`];

  if (run.persona?.trim()) sections.push(`Persona:\n${run.persona.trim()}`);
  if (run.focus?.trim()) sections.push(`Focus:\n${run.focus.trim()}`);
  if (run.method && run.method.length > 0) {
    sections.push(
      `Method:\n${run.method.map((item) => `- ${item}`).join('\n')}`,
    );
  }

  sections.push(
    [
      'Use the conversation and saved context as source material.',
      'Answer directly and avoid claiming access to tools that are not present in this run.',
    ].join(' '),
  );

  return sections.join('\n\n');
}

function toRegisteredAgentRecord(
  run: GreenfieldExecutorRunRow,
): RegisteredAgentRecord {
  return {
    id: run.source_agent_id ?? run.agent_snapshot_id,
    owner_id: run.requested_by,
    name: run.agent_name?.trim() || 'Agent',
    provider_id: run.provider_id,
    model_id: run.model_id,
    persona_role: run.role_key,
    system_prompt: buildSnapshotSystemPrompt(run),
    description: run.focus,
    enabled: true,
    credential_mode: null,
    model_auto_upgraded_from: null,
    model_auto_upgraded_at: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  };
}

async function getGreenfieldExecutorRun(
  runId: string,
): Promise<GreenfieldExecutorRunRow | null> {
  const db = getDbPg();
  const rows = await db<GreenfieldExecutorRunRow[]>`
    select
      r.id,
      r.workspace_id,
      r.talk_id,
      t.title as talk_title,
      t.mode as talk_mode,
      r.round,
      r.status,
      r.model_id,
      lpm.provider_id,
      lpm.context_window_tokens,
      r.requested_by,
      r.response_group_id,
      r.sequence_index,
      r.agent_snapshot_id,
      tas.source_agent_id,
      tas.role_key,
      tas.name as agent_name,
      tas.handle,
      tas.persona,
      tas.focus,
      tas.method,
      rps.tool_manifest_json
    from public.runs r
    join public.talks t
      on t.workspace_id = r.workspace_id
     and t.id = r.talk_id
    join public.talk_agent_snapshots tas
      on tas.workspace_id = r.workspace_id
     and tas.talk_id = r.talk_id
     and tas.id = r.agent_snapshot_id
    join public.llm_provider_models lpm
      on lpm.model_id = r.model_id
    left join public.run_prompt_snapshots rps
      on rps.workspace_id = r.workspace_id
     and rps.id = r.prompt_snapshot_id
    where r.id = ${runId}::uuid
    limit 1
  `;
  return rows[0] ?? null;
}

function parseToolManifestEffectiveTools(
  value: unknown,
): EffectiveToolAccess[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const effectiveTools = (value as Record<string, unknown>).effectiveTools;
  if (!Array.isArray(effectiveTools)) return null;

  const parsed: EffectiveToolAccess[] = [];
  for (const entry of effectiveTools) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return null;
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.toolFamily !== 'string' ||
      !Array.isArray(record.runtimeTools) ||
      record.runtimeTools.some((tool) => typeof tool !== 'string') ||
      typeof record.enabled !== 'boolean' ||
      typeof record.requiresApproval !== 'boolean'
    ) {
      return null;
    }
    parsed.push({
      toolFamily: record.toolFamily,
      runtimeTools: record.runtimeTools,
      enabled: record.enabled,
      requiresApproval: record.requiresApproval,
    });
  }
  return parsed;
}

async function loadGreenfieldEffectiveTools(
  run: GreenfieldExecutorRunRow,
): Promise<EffectiveToolAccess[]> {
  const frozenEffectiveTools = parseToolManifestEffectiveTools(
    run.tool_manifest_json,
  );
  if (frozenEffectiveTools) return frozenEffectiveTools;

  const userPermissions = await listUserToolPermissionsForUser(
    run.requested_by,
  );
  const db = getDbPg();
  const rows = await db<{ tool_id: string; enabled: boolean }[]>`
    select tool_id, enabled
    from public.talk_tools
    where workspace_id = ${run.workspace_id}::uuid
      and talk_id = ${run.talk_id}::uuid
  `;
  return buildEffectiveToolsFromTalkToolRows(rows, userPermissions);
}

async function loadGreenfieldHistory(
  run: GreenfieldExecutorRunRow,
): Promise<LlmMessage[]> {
  const db = getDbPg();
  const rows = await db<GreenfieldHistoryMessageRow[]>`
    select
      m.id,
      m.author_kind,
      m.body,
      tas.name as agent_name
    from public.messages m
    left join public.talk_agent_snapshots tas
      on tas.workspace_id = m.workspace_id
     and tas.talk_id = m.talk_id
     and tas.id = m.agent_snapshot_id
    where m.workspace_id = ${run.workspace_id}::uuid
      and m.talk_id = ${run.talk_id}::uuid
      and m.round < ${run.round}
    order by m.round desc, m.created_at desc, m.id desc
    limit ${MAX_HISTORY_MESSAGES}
  `;

  return rows.reverse().map((row) => {
    if (row.author_kind === 'user') {
      return { role: 'user', content: row.body ?? '' };
    }
    const label = row.agent_name?.trim();
    return {
      role: 'assistant',
      content: label ? `[${label}]\n${row.body ?? ''}` : (row.body ?? ''),
    };
  });
}

function annotateGreenfieldContextSources(
  rows: GreenfieldContextSourceRow[],
): GreenfieldContextSourceView[] {
  let sourceIndex = 0;
  return rows.map((source) => {
    const sourceOnlyIndex = source.kind === 'rule' ? null : sourceIndex++;
    const fallbackSourceRef =
      source.kind === 'rule' ? null : `S${(sourceOnlyIndex ?? 0) + 1}`;
    const displayRef = source.source_ref || fallbackSourceRef;
    const displayLabel =
      source.kind === 'rule'
        ? source.compat_kind === 'goal'
          ? 'Goal'
          : `Rule: ${source.name}`
        : `Source ${displayRef}: ${source.name} (${source.kind})`;
    return { ...source, displayRef, displayLabel };
  });
}

async function loadGreenfieldContextSources(
  run: GreenfieldExecutorRunRow,
): Promise<GreenfieldContextSourceView[]> {
  const db = getDbPg();
  const rows = await db<GreenfieldContextSourceRow[]>`
    select
      s.id,
      s.kind,
      s.name,
      s.extracted_text,
      s.summary,
      s.meta_json->>'mimeType' as mime_type,
      s.expected_page_count,
      coalesce(p.page_count, 0) as page_image_count,
      coalesce(p.page_indices, '{}'::int[]) as page_indices,
      coalesce(p.page_byte_sizes, '{}'::int[]) as page_byte_sizes,
      s.sort_order,
      s.meta_json->>'sourceRef' as source_ref,
      s.meta_json->>'compatKind' as compat_kind
    from public.context_sources s
    left join (
      select source_id,
             count(*)::int as page_count,
             array_agg(page_index order by page_index) as page_indices,
             array_agg(byte_size order by page_index) as page_byte_sizes
      from public.context_source_pages
      where workspace_id = ${run.workspace_id}::uuid
      group by source_id
    ) p on p.source_id = s.id
    where s.workspace_id = ${run.workspace_id}::uuid
      and s.talk_id = ${run.talk_id}::uuid
      and s.include_in_prompt = true
    order by s.sort_order asc nulls last, s.created_at asc, s.id asc
    limit 20
  `;
  return annotateGreenfieldContextSources(rows);
}

function buildGreenfieldSourceSection(
  rows: GreenfieldContextSourceView[],
): string | null {
  if (rows.length === 0) return null;

  const perSourceBudget = Math.max(
    500,
    Math.floor(MAX_SOURCE_CHARS / rows.length),
  );
  const entries = rows.map((source) => {
    const body = source.summary?.trim() || source.extracted_text?.trim() || '';
    return [
      source.displayLabel,
      truncateText(body || 'No extracted text is available.', perSourceBudget),
    ].join('\n');
  });
  return ['Saved context sources:', ...entries].join('\n\n');
}

function selectGreenfieldPdfPageSources(input: {
  run: GreenfieldExecutorRunRow;
  sources: GreenfieldContextSourceView[];
}): GreenfieldPdfPageSource[] {
  const capabilities = resolveModelCapabilities({
    providerId: input.run.provider_id,
    modelId: input.run.model_id,
  });
  if (!capabilities.supports_vision) return [];
  if (
    capabilities.accepted_image_formats &&
    !capabilities.accepted_image_formats.includes('image/jpeg')
  ) {
    return [];
  }

  let remainingImages = Math.max(
    0,
    Math.min(capabilities.max_images ?? MAX_RASTER_PAGES, MAX_RASTER_PAGES),
  );
  let remainingPayloadBytes = MAX_TOTAL_RASTER_PAYLOAD_BYTES;
  if (remainingImages === 0) return [];

  const selected: GreenfieldPdfPageSource[] = [];
  for (const source of input.sources) {
    if (remainingImages === 0) break;
    const expectedPageCount = source.expected_page_count ?? null;
    if (
      source.kind !== 'file' ||
      source.mime_type !== 'application/pdf' ||
      expectedPageCount === null ||
      expectedPageCount <= 0 ||
      source.page_image_count !== expectedPageCount ||
      source.page_indices.length === 0 ||
      !source.displayRef
    ) {
      continue;
    }

    const pageIndices: number[] = [];
    let truncationReason: 'image-limit' | 'payload-budget' | null = null;
    for (let i = 0; i < source.page_indices.length; i += 1) {
      if (pageIndices.length >= remainingImages) {
        truncationReason = 'image-limit';
        break;
      }
      const encodedBytes = encodedSizeBytes(source.page_byte_sizes[i] ?? 0);
      if (encodedBytes > remainingPayloadBytes) {
        truncationReason = 'payload-budget';
        break;
      }
      pageIndices.push(source.page_indices[i]!);
      remainingPayloadBytes -= encodedBytes;
    }
    if (pageIndices.length === 0) continue;
    remainingImages -= pageIndices.length;
    selected.push({
      sourceId: source.id,
      sourceRef: source.displayRef,
      title: source.name,
      totalPages: expectedPageCount,
      pageIndices,
      truncatedReason:
        pageIndices.length < expectedPageCount
          ? (truncationReason ?? 'image-limit')
          : null,
    });
  }

  return selected;
}

async function prependGreenfieldPdfPageImages(input: {
  talkId: string;
  userMessageText: string;
  pageSources: GreenfieldPdfPageSource[];
}): Promise<string | LlmContentBlock[]> {
  if (input.pageSources.length === 0) return input.userMessageText;

  const pageBlocks: LlmContentBlock[] = [
    {
      type: 'text',
      text: 'Talk-level Context PDF page images (rasterized pages of saved PDFs; read these alongside the extracted text in the system prompt):',
    },
  ];
  let attachedImages = 0;

  for (const source of input.pageSources) {
    if (source.truncatedReason) {
      const reason =
        source.truncatedReason === 'payload-budget'
          ? 'the raster payload budget'
          : 'the model image limit';
      pageBlocks.push({
        type: 'text',
        text: `PDF [${source.sourceRef}] "${source.title}" - ${source.pageIndices.length} of ${source.totalPages} pages are attached because of ${reason}; use the extracted text in the system prompt for the remaining pages.`,
      });
    }
    for (const pageIndex of source.pageIndices) {
      try {
        const buffer = await loadPageImage(
          input.talkId,
          source.sourceId,
          pageIndex,
        );
        pageBlocks.push({
          type: 'text',
          text: `PDF [${source.sourceRef}] "${source.title}" - page ${
            pageIndex + 1
          } of ${source.totalPages}:`,
        });
        pageBlocks.push({
          type: 'image',
          mimeType: 'image/jpeg',
          data: buffer.toString('base64'),
          detail: 'auto',
        });
        attachedImages += 1;
      } catch (err) {
        logger.warn(
          {
            err,
            talkId: input.talkId,
            sourceId: source.sourceId,
            sourceRef: source.sourceRef,
            pageIndex,
          },
          'Failed to load greenfield context PDF page image - skipping',
        );
      }
    }
  }

  if (attachedImages === 0) return input.userMessageText;
  return [...pageBlocks, { type: 'text', text: input.userMessageText }];
}

function estimateContentTokens(content: string | LlmContentBlock[]): number {
  if (typeof content === 'string') return estimateTokens(content);
  return content.reduce((total, block) => {
    if (block.type === 'text') return total + estimateTokens(block.text);
    if (block.type === 'image') return total + ESTIMATED_IMAGE_BLOCK_TOKENS;
    if (block.type === 'document') {
      return total + ESTIMATED_DOCUMENT_BLOCK_TOKENS;
    }
    if (block.type === 'tool_use') {
      return total + estimateTokens(JSON.stringify(block.input));
    }
    return total + estimateTokens(block.content);
  }, 0);
}

async function loadGreenfieldSourceSection(
  run: GreenfieldExecutorRunRow,
): Promise<{
  sourceSection: string | null;
  pageSources: GreenfieldPdfPageSource[];
}> {
  const sources = await loadGreenfieldContextSources(run);
  return {
    sourceSection: buildGreenfieldSourceSection(sources),
    pageSources: selectGreenfieldPdfPageSources({ run, sources }),
  };
}

function formatPriorOutputs(
  priorOutputs: PriorOrderedOutput[],
  maxChars: number,
): string {
  const perOutput =
    priorOutputs.length > 0 ? Math.floor(maxChars / priorOutputs.length) : 0;
  return priorOutputs
    .map((output) => {
      const label = output.agentNickname || output.agentId || 'Agent';
      return `[${label}]\n${truncateText(output.content, perOutput)}`;
    })
    .join('\n\n');
}

function formatPriorGaps(priorGaps: PriorOrderedGap[]): string {
  return priorGaps
    .map((gap) => {
      const label =
        gap.agentNickname || gap.agentId || `Agent ${gap.sequenceIndex + 1}`;
      const statusText =
        gap.status === 'failed'
          ? 'failed to finish'
          : gap.status === 'cancelled'
            ? 'was cancelled'
            : gap.status === 'awaiting'
              ? 'is waiting for confirmation'
              : gap.status === 'running'
                ? 'is still running'
                : 'is unavailable';
      return `[${label}] ${statusText}; its output is omitted.`;
    })
    .join('\n');
}

export async function buildGreenfieldStepUserMessageText(input: {
  workspaceId: string;
  triggerContent: string;
  talkMode?: 'ordered' | 'parallel' | null;
  responseGroupId?: string | null;
  sequenceIndex?: number | null;
}): Promise<{ userMessageText: string; isSynthesis: boolean }> {
  if (
    (input.talkMode ?? 'ordered') !== 'ordered' ||
    !input.responseGroupId ||
    typeof input.sequenceIndex !== 'number' ||
    input.sequenceIndex <= 0
  ) {
    return { userMessageText: input.triggerContent, isSynthesis: false };
  }

  const db = getDbPg();
  const priorOutputs = await db<PriorOrderedOutput[]>`
    with assistant_outputs as (
      select
        run_id,
        string_agg(body, E'\n\n' order by created_at asc, id asc) as content
      from public.messages
      where workspace_id = ${input.workspaceId}::uuid
        and author_kind = 'agent'
        and run_id is not null
      group by run_id
    )
    select
      r.sequence_index as "sequenceIndex",
      tas.source_agent_id as "agentId",
      tas.name as "agentNickname",
      ao.content
    from public.runs r
    join assistant_outputs ao on ao.run_id = r.id
    join public.talk_agent_snapshots tas
      on tas.workspace_id = r.workspace_id
     and tas.talk_id = r.talk_id
     and tas.id = r.agent_snapshot_id
    where r.workspace_id = ${input.workspaceId}::uuid
      and r.response_group_id = ${input.responseGroupId}
      and r.sequence_index < ${input.sequenceIndex}
      and r.status = 'completed'
    order by r.sequence_index asc
  `;
  const priorGaps = await db<PriorOrderedGap[]>`
    select
      r.sequence_index as "sequenceIndex",
      tas.source_agent_id as "agentId",
      tas.name as "agentNickname",
      r.status
    from public.runs r
    join public.talk_agent_snapshots tas
      on tas.workspace_id = r.workspace_id
     and tas.talk_id = r.talk_id
     and tas.id = r.agent_snapshot_id
    where r.workspace_id = ${input.workspaceId}::uuid
      and r.response_group_id = ${input.responseGroupId}
      and r.sequence_index < ${input.sequenceIndex}
      and r.status <> 'completed'
    order by r.sequence_index asc
  `;
  if (priorOutputs.length === 0 && priorGaps.length === 0) {
    return { userMessageText: input.triggerContent, isSynthesis: false };
  }

  const maxRows = await db<Array<{ max_sequence_index: number | null }>>`
    select max(sequence_index) as max_sequence_index
    from public.runs
    where workspace_id = ${input.workspaceId}::uuid
      and response_group_id = ${input.responseGroupId}
  `;
  const maxSequenceIndex = maxRows[0]?.max_sequence_index ?? null;
  const isSynthesis =
    maxSequenceIndex != null && input.sequenceIndex === maxSequenceIndex;
  const sections = [`Original user request:\n${input.triggerContent}`];

  if (priorOutputs.length > 0) {
    sections.push(
      `Prior analyses from other agents:\n${formatPriorOutputs(
        priorOutputs,
        MAX_ORDERED_PRIOR_OUTPUT_CHARS,
      )}`,
    );
  }
  if (priorGaps.length > 0) {
    sections.push(
      `Unavailable earlier ordered steps:\n${formatPriorGaps(priorGaps)}`,
    );
  }
  sections.push(
    isSynthesis
      ? 'Synthesize these perspectives into one recommendation. Treat the prior analyses as other agents work, not your own previous statements.'
      : 'Provide your own analysis from your role and perspective. Use prior analyses as context, not as your own previous statements.',
  );

  return { userMessageText: sections.join('\n\n'), isSynthesis };
}

function buildContext(input: {
  run: GreenfieldExecutorRunRow;
  history: LlmMessage[];
  sourceSection: string | null;
}): ExecutionContext {
  const systemPrompt = [`Talk: ${input.run.talk_title}`, input.sourceSection]
    .filter(Boolean)
    .join('\n\n');

  return {
    systemPrompt,
    contextTools: [],
    connectorTools: [],
    history: input.history,
  };
}

function mapExecutionEvent(
  event: ExecutionEvent,
  input: TalkExecutorInput,
  run: GreenfieldExecutorRunRow,
): TalkExecutionEvent | null {
  const shared = {
    runId: input.runId,
    talkId: input.talkId,
    threadId: input.threadId,
    agentId: run.source_agent_id ?? run.agent_snapshot_id,
    agentNickname: run.agent_name ?? null,
    responseGroupId: input.responseGroupId ?? null,
    sequenceIndex: input.sequenceIndex ?? null,
    providerId: run.provider_id,
    modelId: run.model_id,
  };

  switch (event.type) {
    case 'started':
      return {
        type: 'talk_response_started',
        ...shared,
        providerId: event.providerId,
        modelId: event.modelId,
      };
    case 'text_delta':
      return { type: 'talk_response_delta', ...shared, deltaText: event.text };
    case 'usage':
      return {
        type: 'talk_response_usage',
        ...shared,
        usage: {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          estimatedCostUsd: event.estimatedCostUsd,
        },
      };
    case 'completed':
      return {
        type: 'talk_response_completed',
        ...shared,
        completion: event.completion,
      };
    case 'failed':
      return {
        type: 'talk_response_failed',
        ...shared,
        errorCode: event.errorCode,
        errorMessage: event.errorMessage,
        completion: event.completion,
      };
    case 'cancelled':
      return { type: 'talk_response_cancelled', ...shared };
    case 'tool_call':
      return {
        type: 'tool_call_started',
        ...shared,
        toolName: event.toolName,
        arguments: event.arguments,
      };
    case 'tool_result':
    case 'awaiting_confirmation':
      return null;
  }
}

function buildResponseMetadataJson(input: {
  run: GreenfieldExecutorRunRow;
  estimatedContextTokens: number;
  isSynthesis: boolean;
  output: TalkExecutorOutput;
}): string {
  return JSON.stringify({
    runId: input.run.id,
    providerId: input.output.providerId ?? input.run.provider_id,
    modelId: input.output.modelId ?? input.run.model_id,
    contextTokens: input.estimatedContextTokens,
    responseGroupId: input.run.response_group_id,
    sequenceIndex: input.run.sequence_index,
    completionStatus: input.output.completion?.completionStatus ?? 'complete',
    providerStopReason: input.output.completion?.providerStopReason ?? null,
    incompleteReason: input.output.completion?.incompleteReason ?? null,
    completedCleanly:
      input.output.completion?.completionStatus !== 'incomplete',
    ...(input.isSynthesis ? { isSynthesis: true } : {}),
  });
}

export class GreenfieldTalkExecutor implements TalkExecutor {
  async execute(
    input: TalkExecutorInput,
    signal: AbortSignal,
    emit?: (event: TalkExecutionEvent) => void,
  ): Promise<TalkExecutorOutput> {
    const run = await getGreenfieldExecutorRun(input.runId);
    if (!run) {
      throw new TalkExecutorError(
        'RUN_NOT_FOUND',
        `Run ${input.runId} not found`,
      );
    }
    if (run.status !== 'running') {
      throw new TalkExecutorError(
        'RUN_NOT_RUNNING',
        `Run ${input.runId} is ${run.status}, not running`,
      );
    }

    const [history, sourceContext, stepUserMessage] = await Promise.all([
      loadGreenfieldHistory(run),
      loadGreenfieldSourceSection(run),
      buildGreenfieldStepUserMessageText({
        workspaceId: run.workspace_id,
        triggerContent: input.triggerContent,
        talkMode: run.talk_mode,
        responseGroupId: input.responseGroupId,
        sequenceIndex: input.sequenceIndex,
      }),
    ]);
    const context = buildContext({
      run,
      history,
      sourceSection: sourceContext.sourceSection,
    });
    const userMessageContent = await prependGreenfieldPdfPageImages({
      talkId: run.talk_id,
      userMessageText: stepUserMessage.userMessageText,
      pageSources: sourceContext.pageSources,
    });
    const estimatedContextTokens =
      estimateTokens(context.systemPrompt) +
      context.history.reduce(
        (total, message) => total + estimateContentTokens(message.content),
        0,
      ) +
      estimateContentTokens(userMessageContent);
    const [agent, effectiveTools] = await Promise.all([
      Promise.resolve(toRegisteredAgentRecord(run)),
      loadGreenfieldEffectiveTools(run),
    ]);

    const result = await executeWithResolvedAgent(
      agent,
      context,
      userMessageContent,
      {
        runId: input.runId,
        userId: input.requestedBy,
        signal,
        emit: (event) => {
          const mapped = mapExecutionEvent(event, input, run);
          if (mapped) emit?.(mapped);
        },
        credentialScope: {
          principalUserId: input.requestedBy,
          workspaceId: run.workspace_id,
        },
        effectiveTools,
      },
    );

    const output: TalkExecutorOutput = {
      content: result.content,
      agentId: agent.id,
      agentNickname: agent.name,
      providerId: result.providerId,
      modelId: result.modelId,
      usage: result.usage
        ? {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            estimatedCostUsd: result.usage.estimatedCostUsd,
          }
        : undefined,
      responseSequenceInRun: 1,
      completion: result.completion,
    };
    return {
      ...output,
      metadataJson: buildResponseMetadataJson({
        run,
        estimatedContextTokens,
        isSynthesis: stepUserMessage.isSynthesis,
        output,
      }),
    };
  }
}

export default GreenfieldTalkExecutor;
