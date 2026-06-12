import { getDbPg, withTrustedDbWrites, withUserContext } from '../../db.js';
import { logger } from '../../logger.js';
import {
  executeWithResolvedAgent,
  type ExecutionContext,
  type ExecutionEvent,
} from '../agents/agent-router.js';
import type {
  LlmContentBlock,
  LlmMessage,
  LlmToolDefinition,
} from '../agents/llm-client.js';
import {
  buildEffectiveToolsFromTalkToolRows,
  listUserToolPermissionsForUser,
  type EffectiveToolAccess,
  type RegisteredAgentRecord,
  type RegisteredAgentCredentialMode,
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
  type TalkJobExecutionPolicy,
} from './executor.js';
import { buildGoogleDriveContextTools } from './google-drive-tools.js';
import { isContentEditIntent } from './content-edit-intent.js';
import {
  buildAllowedRuntimeToolSet,
  filterRuntimeToolDefinitions,
  isRuntimeToolAllowed,
} from './runtime-tool-filter.js';
import { CONTEXT_SOURCE_STATUS_SQL } from './context-source-status-sql.js';
import {
  extractAssistantProviderData,
  selectProviderReplayMessageIds,
} from './provider-replay-scope.js';
import {
  executeGreenfieldApplyContentEdit,
  GREENFIELD_APPLY_CONTENT_EDIT_TOOL,
  GREENFIELD_DOCUMENT_EDIT_RUNTIME_TOOL,
  loadGreenfieldDocumentContext,
} from './greenfield-document-tools.js';
import { buildToolExecutor, PDF_ATTACHMENT_MIME_TYPE } from './new-executor.js';
import { emitOutboxEvent } from './outbox-emit.js';

type GreenfieldExecutorRunRow = {
  id: string;
  workspace_id: string;
  talk_id: string;
  job_id: string | null;
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

type GreenfieldToolManifestRecord = Record<string, unknown>;

type GreenfieldHistoryMessageRow = {
  id: string;
  author_kind: 'user' | 'agent';
  body: string | null;
  agent_name: string | null;
  source_agent_id: string | null;
  snapshot_provider_id: string | null;
  snapshot_model_id: string | null;
  replay_provider_id: string | null;
  replay_model_id: string | null;
  provider_data_json: Record<string, unknown> | null;
};

type GreenfieldContextSourceRow = {
  id: string;
  kind: string;
  name: string;
  extracted_text: string | null;
  summary: string | null;
  status: string;
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

type GreenfieldDocumentContext = Awaited<
  ReturnType<typeof loadGreenfieldDocumentContext>
>;

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
const EMPTY_HISTORY_MESSAGE_CONTENT = '[No text content in this turn]';
const MAX_SOURCE_CHARS = 12_000;
const MAX_ORDERED_PRIOR_OUTPUT_CHARS = 24_000;
const ESTIMATED_IMAGE_BLOCK_TOKENS = 3_000;
const ESTIMATED_DOCUMENT_BLOCK_TOKENS = 8_000;
const OMITTED_CONTEXT_MARKER = '[omitted due to context window]';
const TRUNCATED_CONTEXT_SUFFIX = '\n\n[truncated for context window]';

const WEB_TOOL_DEFINITIONS: LlmToolDefinition[] = [
  {
    name: 'web_search',
    description: [
      'Search the live web for current information. Returns result objects with title, url, and a short snippet.',
      '',
      'Use this for anything that may have changed recently: current events, news, prices, schedules, rosters, and "latest" or "current" facts.',
      'Keep queries short and include a timeframe when freshness matters.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Short natural-language search query.',
        },
        max_results: {
          type: 'number',
          description: 'Optional result cap. Defaults to 5.',
        },
      },
      required: ['query'],
    },
  },
];

const GREENFIELD_CONTEXT_TOOL_DEFINITIONS: LlmToolDefinition[] = [
  {
    name: 'read_source',
    description:
      'Read the full extracted text of a saved Talk source by its source id. Legacy S-number aliases are accepted only when an imported source still has one.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceRef: {
          type: 'string',
          description: 'The source id, or a legacy S-number alias if present.',
        },
      },
      required: ['sourceRef'],
    },
  },
];

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

function parseToolManifestRecord(
  value: unknown,
): GreenfieldToolManifestRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as GreenfieldToolManifestRecord)
    : null;
}

function parseCredentialKindSnapshot(
  value: unknown,
): RegisteredAgentCredentialMode | null {
  const record = parseToolManifestRecord(value);
  const mode = record?.agentCredentialMode;
  return mode === 'api_key' || mode === 'subscription' ? mode : null;
}

function toRegisteredAgentRecord(
  run: GreenfieldExecutorRunRow,
): RegisteredAgentRecord {
  const credentialMode = parseCredentialKindSnapshot(run.tool_manifest_json);
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
    credential_mode: credentialMode,
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
      r.job_id,
      t.title as talk_title,
      t.mode as talk_mode,
      r.round,
      r.status,
      tas.model_id,
      tas.provider_id,
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
      on lpm.provider_id = tas.provider_id
     and lpm.model_id = tas.model_id
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
  const record = parseToolManifestRecord(value);
  if (!record) return null;
  const effectiveTools = record.effectiveTools;
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
  if (run.job_id) return [];

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
  const rows = await withTrustedDbWrites(
    () => db<GreenfieldHistoryMessageRow[]>`
      select
        m.id,
        m.author_kind,
        m.body,
        tas.source_agent_id::text as source_agent_id,
        tas.name as agent_name,
        tas.provider_id as snapshot_provider_id,
        tas.model_id as snapshot_model_id,
        mpr.provider_id as replay_provider_id,
        mpr.model_id as replay_model_id,
        mpr.provider_data_json
      from public.messages m
      left join public.talk_agent_snapshots tas
        on tas.workspace_id = m.workspace_id
       and tas.talk_id = m.talk_id
       and tas.id = m.agent_snapshot_id
      left join public.message_provider_replay mpr
        on mpr.workspace_id = m.workspace_id
       and mpr.talk_id = m.talk_id
       and mpr.message_id = m.id
      where m.workspace_id = ${run.workspace_id}::uuid
        and m.talk_id = ${run.talk_id}::uuid
        and m.round < ${run.round}
      order by m.round desc, m.created_at desc, m.id desc
      limit ${MAX_HISTORY_MESSAGES}
    `,
  );

  const rowsChronological = [...rows].reverse();
  const providerReplayMessageIds = selectProviderReplayMessageIds(
    rowsChronological,
    {
      sourceAgentId: run.source_agent_id,
      providerId: run.provider_id,
      modelId: run.model_id,
    },
  );
  return rowsChronological.map((row): LlmMessage => {
    const body =
      row.body && row.body.length > 0
        ? row.body
        : EMPTY_HISTORY_MESSAGE_CONTENT;
    if (row.author_kind === 'user') {
      return { role: 'user', content: body };
    }
    const label = row.agent_name?.trim();
    const includeProviderData = providerReplayMessageIds.has(row.id);
    const message: LlmMessage = {
      role: 'assistant',
      content: label ? `[${label}]\n${body}` : body,
    };
    if (includeProviderData) {
      const providerData = extractAssistantProviderData(row.provider_data_json);
      if (providerData) message.providerData = providerData;
    }
    return message;
  });
}

function annotateGreenfieldContextSources(
  rows: GreenfieldContextSourceRow[],
): GreenfieldContextSourceView[] {
  return rows.map((source) => {
    const displayRef =
      source.kind === 'rule' ? null : source.source_ref || source.id;
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
  options: { includeUnreadySources?: boolean } = {},
): Promise<GreenfieldContextSourceView[]> {
  const db = getDbPg();
  const includeUnreadySources = options.includeUnreadySources === true;
  const rows = await db<GreenfieldContextSourceRow[]>`
    select
      s.id,
      s.kind,
      s.name,
      s.extracted_text,
      s.summary,
      ${db.unsafe(CONTEXT_SOURCE_STATUS_SQL)} as status,
      s.meta_json->>'mimeType' as mime_type,
      s.expected_page_count,
      coalesce(p.page_count, 0) as page_image_count,
      coalesce(p.page_indices, '{}'::int[]) as page_indices,
      coalesce(p.page_byte_sizes, '{}'::int[]) as page_byte_sizes,
      s.sort_order,
      s.id::text as source_ref,
      s.meta_json->>'compatKind' as compat_kind
    from public.context_sources s
    left join lateral (
      select source_id,
             count(*)::int as page_count,
             array_agg(page_index order by page_index) as page_indices,
             array_agg(byte_size order by page_index) as page_byte_sizes
      from public.context_source_pages
      where source_id = s.id
      group by source_id
    ) p on true
    where s.workspace_id = ${run.workspace_id}::uuid
      and s.talk_id = ${run.talk_id}::uuid
      and s.include_in_prompt = true
      and (
        ${includeUnreadySources}
        or
        s.kind = 'rule'
        or (
          ${db.unsafe(CONTEXT_SOURCE_STATUS_SQL)} = 'ready'
          or (
            s.meta_json->>'mimeType' = ${PDF_ATTACHMENT_MIME_TYPE}
            and s.expected_page_count is not null
            and s.expected_page_count > 0
            and coalesce(p.page_count, 0) = s.expected_page_count
          )
        )
      )
    order by s.sort_order asc nulls last, s.created_at asc, s.id asc
    limit 20
  `;
  return annotateGreenfieldContextSources(rows);
}

async function loadGreenfieldContextSourceForRead(input: {
  run: GreenfieldExecutorRunRow;
  ref: string;
}): Promise<GreenfieldContextSourceView | null> {
  const db = getDbPg();
  const normalizedRef = input.ref.toUpperCase();
  const normalizedIdRef = input.ref.toLowerCase();
  const rows = await db<GreenfieldContextSourceRow[]>`
    select
      s.id,
      s.kind,
      s.name,
      s.extracted_text,
      s.summary,
      ${db.unsafe(CONTEXT_SOURCE_STATUS_SQL)} as status,
      s.meta_json->>'mimeType' as mime_type,
      s.expected_page_count,
      coalesce(p.page_count, 0) as page_image_count,
      coalesce(p.page_indices, '{}'::int[]) as page_indices,
      coalesce(p.page_byte_sizes, '{}'::int[]) as page_byte_sizes,
      s.sort_order,
      s.id::text as source_ref,
      s.meta_json->>'compatKind' as compat_kind
    from public.context_sources s
    left join lateral (
      select source_id,
             count(*)::int as page_count,
             array_agg(page_index order by page_index) as page_indices,
             array_agg(byte_size order by page_index) as page_byte_sizes
      from public.context_source_pages
      where source_id = s.id
      group by source_id
    ) p on true
    where s.workspace_id = ${input.run.workspace_id}::uuid
      and s.talk_id = ${input.run.talk_id}::uuid
      and s.kind <> 'rule'
      and s.include_in_prompt = true
      and (
        s.id::text = ${normalizedIdRef}
        or upper(s.meta_json->>'sourceRef') = ${normalizedRef}
      )
    order by
      case
        when s.id::text = ${normalizedIdRef} then 0
        when upper(s.meta_json->>'sourceRef') = ${normalizedRef} then 1
        else 2
      end,
      s.sort_order asc nulls last,
      s.created_at asc,
      s.id asc
    limit 1
  `;
  return annotateGreenfieldContextSources(rows)[0] ?? null;
}

function hasCompleteGreenfieldPdfPages(
  source: GreenfieldContextSourceView,
): boolean {
  return (
    source.mime_type === PDF_ATTACHMENT_MIME_TYPE &&
    source.expected_page_count !== null &&
    source.expected_page_count > 0 &&
    source.page_image_count === source.expected_page_count
  );
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
    const body =
      source.summary?.trim() ||
      source.extracted_text?.trim() ||
      (source.kind === 'rule' ? source.name.trim() : '');
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

function parseGreenfieldJobPolicy(
  run: GreenfieldExecutorRunRow,
): TalkJobExecutionPolicy | null {
  if (!run.job_id) return null;
  const manifest = parseToolManifestRecord(run.tool_manifest_json);
  const scope = parseToolManifestRecord(manifest?.jobSourceScope);
  const allowWeb = scope?.allow_web === true || scope?.allowWeb === true;
  return {
    jobId: run.job_id,
    allowedConnectorIds: [],
    allowWeb,
    allowStateMutation: false,
    allowExternalMutation: false,
  };
}

function buildGreenfieldContextTools(input: {
  effectiveTools: EffectiveToolAccess[];
  jobPolicy: TalkJobExecutionPolicy | null;
  hasAttachedDocument: boolean;
}): LlmToolDefinition[] {
  const enabledToolFamilies = new Set(
    input.effectiveTools
      .filter((tool) => tool.enabled)
      .map((tool) => tool.toolFamily),
  );
  const allowedRuntimeTools = buildAllowedRuntimeToolSet(input.effectiveTools);
  const tools: LlmToolDefinition[] = [...GREENFIELD_CONTEXT_TOOL_DEFINITIONS];

  if (
    (!input.jobPolicy || input.jobPolicy.allowWeb) &&
    enabledToolFamilies.has('web')
  ) {
    tools.push(
      ...filterRuntimeToolDefinitions(
        WEB_TOOL_DEFINITIONS,
        allowedRuntimeTools,
      ),
    );
  }

  const googleReadEnabled = enabledToolFamilies.has('google_read');
  const googleWriteEnabled = enabledToolFamilies.has('google_write');
  if (googleReadEnabled || googleWriteEnabled) {
    const googleTools = buildGoogleDriveContextTools({
      readEnabled: googleReadEnabled,
      writeEnabled: googleWriteEnabled,
      hasAttachedContent: input.hasAttachedDocument && !input.jobPolicy,
    });
    tools.push(
      ...filterRuntimeToolDefinitions(googleTools, allowedRuntimeTools),
    );
  }

  if (
    input.hasAttachedDocument &&
    !input.jobPolicy &&
    isRuntimeToolAllowed(
      allowedRuntimeTools,
      GREENFIELD_DOCUMENT_EDIT_RUNTIME_TOOL,
    )
  ) {
    tools.push(GREENFIELD_APPLY_CONTENT_EDIT_TOOL);
  }

  return tools;
}

async function readGreenfieldSourceTool(input: {
  run: GreenfieldExecutorRunRow;
  args: Record<string, unknown>;
}): Promise<{ result: string; isError?: boolean }> {
  const rawRef = input.args.sourceRef;
  if (typeof rawRef !== 'string' || !rawRef.trim()) {
    return { result: 'Error: sourceRef parameter required', isError: true };
  }
  const ref = rawRef.trim();
  const source = await loadGreenfieldContextSourceForRead({
    run: input.run,
    ref,
  });
  if (!source) return { result: `Source ${ref} not found`, isError: true };
  const hasCompletePdfPages = hasCompleteGreenfieldPdfPages(source);
  if (source.status !== 'ready') {
    if (hasCompletePdfPages) {
      return {
        result: `Source ${ref} has no extracted text. This PDF is available as page images in the current context; read_source only returns extracted text.`,
        isError: true,
      };
    }
    return {
      result:
        source.status === 'pending'
          ? `Source ${ref} is pending; extracted text is not available yet.`
          : `Source ${ref} is ${source.status}; extracted text is not available.`,
      isError: true,
    };
  }
  const body = source.extracted_text?.trim() || source.summary?.trim();
  if (body) return { result: body };
  return {
    result: hasCompletePdfPages
      ? `Source ${ref} has no extracted text. This PDF is available as page images in the current context; read_source only returns extracted text.`
      : `Source ${ref} has no extracted text available.`,
    isError: true,
  };
}

function hasGreenfieldDocumentEditIds(result: string): boolean {
  try {
    const parsed = JSON.parse(result) as { editIds?: unknown };
    return (
      Array.isArray(parsed.editIds) &&
      parsed.editIds.some((editId) => typeof editId === 'string')
    );
  } catch {
    return false;
  }
}

function buildGreenfieldToolExecutor(input: {
  run: GreenfieldExecutorRunRow;
  signal: AbortSignal;
  jobPolicy: TalkJobExecutionPolicy | null;
  effectiveTools: EffectiveToolAccess[];
  advertisedToolNames: Set<string>;
  agentId: string;
  agentNickname: string | null;
  triggerMessageId?: string | null;
  onApplyContentEdit?: () => void;
}): (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<{ result: string; isError?: boolean }> {
  const baseExecutor = buildToolExecutor(
    input.run.talk_id,
    input.run.requested_by,
    input.run.id,
    input.signal,
    input.jobPolicy,
    input.effectiveTools,
    input.agentId,
    input.agentNickname,
    input.triggerMessageId,
  );
  const allowedRuntimeTools = buildAllowedRuntimeToolSet(input.effectiveTools);
  return async (toolName, args) => {
    if (toolName === 'read_source') {
      return readGreenfieldSourceTool({ run: input.run, args });
    }
    if (
      toolName === 'list_state' ||
      toolName === 'read_state' ||
      toolName === 'update_state' ||
      toolName === 'delete_state'
    ) {
      return {
        result:
          'Error: state_not_available: Greenfield Talks do not have mutable state in this runtime.',
        isError: true,
      };
    }
    if (toolName === 'apply_content_edit') {
      if (input.jobPolicy) {
        return {
          result:
            'Error: apply_content_edit is not available for scheduled job runs',
          isError: true,
        };
      }
      if (
        !isRuntimeToolAllowed(
          allowedRuntimeTools,
          GREENFIELD_DOCUMENT_EDIT_RUNTIME_TOOL,
        )
      ) {
        return {
          result: 'Error: apply_content_edit is not enabled for this agent',
          isError: true,
        };
      }
      const result = await executeGreenfieldApplyContentEdit({
        workspaceId: input.run.workspace_id,
        talkId: input.run.talk_id,
        runId: input.run.id,
        agentId: input.run.source_agent_id,
        agentNickname: input.agentNickname,
        messageId: input.triggerMessageId ?? null,
        args,
      });
      if (!result.isError && hasGreenfieldDocumentEditIds(result.result)) {
        input.onApplyContentEdit?.();
      }
      return result;
    }
    if (!input.advertisedToolNames.has(toolName)) {
      return {
        result: `Tool '${toolName}' is not available in greenfield execution`,
        isError: true,
      };
    }
    if (toolName === 'web_search') {
      return withUserContext(input.run.requested_by, () =>
        baseExecutor(toolName, args),
      );
    }
    return baseExecutor(toolName, args);
  };
}

export async function buildGreenfieldStepUserMessageText(input: {
  workspaceId: string;
  talkId: string;
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
        and talk_id = ${input.talkId}::uuid
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
      and r.talk_id = ${input.talkId}::uuid
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
      and r.talk_id = ${input.talkId}::uuid
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
      and talk_id = ${input.talkId}::uuid
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
  documentSection: string | null;
  contextTools: LlmToolDefinition[];
}): ExecutionContext {
  // Talk tool toggles change between rounds, but earlier assistant turns in
  // the history assert the OLD toolset ("my only tool is read_source") and
  // models anchor on that self-narrative over the silent tools array —
  // observed with claude-opus-4-8 denying an advertised web_search for three
  // consecutive rounds after the Web toggle flipped mid-Talk. Enumerating the
  // live toolset in prose is what breaks the anchor.
  const toolNames = input.contextTools.map((tool) => tool.name);
  const toolsSection =
    toolNames.length > 0
      ? `Tools available in this run: ${toolNames.join(', ')}. This list is authoritative for the current run and overrides any earlier turn that claimed a tool was unavailable.`
      : 'No tools are available in this run.';
  const systemPrompt = [
    `Talk: ${input.run.talk_title}`,
    toolsSection,
    input.documentSection,
    input.sourceSection,
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    systemPrompt,
    contextTools: input.contextTools,
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
  providerData?: {
    codexReasoningItems?: Array<Record<string, unknown>>;
    codexMessageItems?: Array<Record<string, unknown>>;
  };
  toolTrace?: Record<string, unknown>;
}): string {
  const codexReasoning =
    input.providerData?.codexReasoningItems &&
    input.providerData.codexReasoningItems.length > 0
      ? input.providerData.codexReasoningItems
      : undefined;
  const codexMessages =
    input.providerData?.codexMessageItems &&
    input.providerData.codexMessageItems.length > 0
      ? input.providerData.codexMessageItems
      : undefined;
  return JSON.stringify({
    runId: input.run.id,
    providerId: input.run.provider_id,
    modelId: input.run.model_id,
    contextTokens: input.estimatedContextTokens,
    responseGroupId: input.run.response_group_id,
    sequenceIndex: input.run.sequence_index,
    completionStatus: input.output.completion?.completionStatus ?? 'complete',
    providerStopReason: input.output.completion?.providerStopReason ?? null,
    incompleteReason: input.output.completion?.incompleteReason ?? null,
    completedCleanly:
      input.output.completion?.completionStatus !== 'incomplete',
    ...(input.isSynthesis ? { isSynthesis: true } : {}),
    ...(codexReasoning ? { codexReasoningItems: codexReasoning } : {}),
    ...(codexMessages ? { codexMessageItems: codexMessages } : {}),
    ...(input.toolTrace ? { toolTrace: input.toolTrace } : {}),
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

    const jobPolicy = parseGreenfieldJobPolicy(run);
    const [history, sourceContext, stepUserMessage, effectiveTools] =
      await Promise.all([
        loadGreenfieldHistory(run),
        loadGreenfieldSourceSection(run),
        buildGreenfieldStepUserMessageText({
          workspaceId: run.workspace_id,
          talkId: run.talk_id,
          triggerContent: input.triggerContent,
          talkMode: run.talk_mode,
          responseGroupId: input.responseGroupId,
          sequenceIndex: input.sequenceIndex,
        }),
        loadGreenfieldEffectiveTools(run),
      ]);
    const documentContext: GreenfieldDocumentContext =
      await loadGreenfieldDocumentContext({
        workspaceId: run.workspace_id,
        talkId: run.talk_id,
        allowEdits: !jobPolicy,
      });
    const agent = toRegisteredAgentRecord(run);
    const contextTools = buildGreenfieldContextTools({
      effectiveTools,
      jobPolicy,
      hasAttachedDocument: Boolean(documentContext.document),
    });
    const context = buildContext({
      run,
      history,
      sourceSection: sourceContext.sourceSection,
      documentSection: documentContext.promptSection,
      contextTools,
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
    const canApplyContentEdit = contextTools.some(
      (tool) => tool.name === GREENFIELD_DOCUMENT_EDIT_RUNTIME_TOOL,
    );
    const editIntentDetected =
      !jobPolicy &&
      Boolean(documentContext.document) &&
      canApplyContentEdit &&
      isContentEditIntent(stepUserMessage.userMessageText);
    // TEMP websearch-trace instrumentation (remove after P0 web-search triage):
    // snapshots the tool pipeline into message metadata so prod runs are
    // inspectable via SQL. See debug/websearch-trace.
    const toolTrace = {
      manifestParsed:
        parseToolManifestEffectiveTools(run.tool_manifest_json) !== null,
      families: effectiveTools.map(
        (tool) =>
          `${tool.toolFamily}:${tool.enabled ? 1 : 0}:${tool.runtimeTools.join('|')}`,
      ),
      contextToolNames: contextTools.map((tool) => tool.name),
      jobPolicy: jobPolicy ? { allowWeb: jobPolicy.allowWeb } : null,
      credentialMode: agent.credential_mode,
    };
    console.log('[websearch-trace] executor', JSON.stringify(toolTrace));
    let applyContentEditCalled = false;
    const executeToolCall = buildGreenfieldToolExecutor({
      run,
      signal,
      jobPolicy,
      effectiveTools,
      advertisedToolNames: new Set(contextTools.map((tool) => tool.name)),
      agentId: agent.id,
      agentNickname: agent.name,
      triggerMessageId: input.triggerMessageId,
      onApplyContentEdit: () => {
        applyContentEditCalled = true;
      },
    });
    if (editIntentDetected && documentContext.document?.owner_id) {
      await emitOutboxEvent({
        topic: `talk:${run.talk_id}`,
        eventType: 'content_edit_run_started',
        payload: {
          contentId: documentContext.document.id,
          runId: input.runId,
          agentId: agent.id,
          agentNickname: agent.name,
        },
        ownerIds: [documentContext.document.owner_id],
      });
    }

    let result: Awaited<ReturnType<typeof executeWithResolvedAgent>>;
    try {
      result = await executeWithResolvedAgent(
        agent,
        context,
        userMessageContent,
        {
          runId: input.runId,
          userId: run.requested_by,
          signal,
          emit: (event) => {
            const mapped = mapExecutionEvent(event, input, run);
            if (mapped) emit?.(mapped);
          },
          executeToolCall,
          forceToolUseOnFirstIteration: editIntentDetected,
          credentialKindSnapshot: agent.credential_mode,
          credentialScope: {
            principalUserId: run.requested_by,
            workspaceId: run.workspace_id,
          },
          effectiveTools,
        },
      );
    } finally {
      if (
        editIntentDetected &&
        documentContext.document?.owner_id &&
        !applyContentEditCalled
      ) {
        await emitOutboxEvent({
          topic: `talk:${run.talk_id}`,
          eventType: 'content_edit_run_aborted',
          payload: {
            contentId: documentContext.document.id,
            runId: input.runId,
            reason: 'no_apply_call',
          },
          ownerIds: [documentContext.document.owner_id],
        });
      }
    }

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
        providerData: result.providerData,
        toolTrace,
      }),
    };
  }
}

export default GreenfieldTalkExecutor;
