import { getDbPg } from '../../db.js';
import type { EffectiveToolAccess } from '../db/agent-accessors.js';
import { CONTEXT_SOURCE_STATUS_SQL } from './context-source-status-sql.js';
import { executeGoogleDriveTalkTool } from './google-drive-tools.js';
import {
  buildAllowedRuntimeToolSet,
  isRuntimeToolAllowed,
} from './runtime-tool-filter.js';
import {
  TalkExecutorError,
  type TalkExecutor,
  type TalkExecutorInput,
  type TalkExecutorOutput,
  type TalkExecutionEvent,
  type TalkJobExecutionPolicy,
} from './executor.js';

export const PDF_ATTACHMENT_MIME_TYPE = 'application/pdf';

type ToolResult = { result: string; isError?: boolean };

// Deadline on the web_search provider request. The run-level signal only
// fires on user cancel, so without this a single hung provider fetch wedges
// the whole round until the scheduler's 1h stuck-run sweep. The abort signal
// bounds the fetch leg only; the registry separately bounds its own DB reads
// via a transaction-local statement_timeout (postgres.js queries are not
// abortable).
export const WEB_SEARCH_TIMEOUT_MS = 20_000;

async function executeWebSearch(
  userId: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ToolResult> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) {
    return {
      result: 'Error: web_search requires a non-empty `query` string.',
      isError: true,
    };
  }

  const rawMax = args.max_results;
  const maxResults =
    typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax > 0
      ? Math.floor(rawMax)
      : undefined;

  const timeoutController = new AbortController();
  const timeoutTimer = setTimeout(() => {
    timeoutController.abort(
      new DOMException(
        `web_search timed out after ${WEB_SEARCH_TIMEOUT_MS / 1000}s`,
        'TimeoutError',
      ),
    );
  }, WEB_SEARCH_TIMEOUT_MS);
  try {
    const { runWebSearchForUser } = await import('../web-search/registry.js');
    const response = await runWebSearchForUser(userId, query, {
      maxResults,
      signal: AbortSignal.any([signal, timeoutController.signal]),
    });
    return {
      result: JSON.stringify({
        provider: response.providerId,
        query: response.query,
        results: response.results,
        ...(response.results.length === 0
          ? { note: 'No results returned by the provider.' }
          : {}),
      }),
    };
  } catch (err) {
    // Provider/config errors keep their identity even if they surface after
    // the timer has fired — a late 401 must say "fix your key", not "retry".
    const { WebSearchError } = await import('../web-search/types.js');
    if (err instanceof WebSearchError) {
      return { result: `web_search error: ${err.message}`, isError: true };
    }
    if (timeoutController.signal.aborted && !signal.aborted) {
      return {
        result: `web_search error: the search provider did not respond within ${WEB_SEARCH_TIMEOUT_MS / 1000} seconds and the request was aborted. Continue with any results you already have, or retry the search once.`,
        isError: true,
      };
    }
    return {
      result: `web_search error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  } finally {
    clearTimeout(timeoutTimer);
  }
}

/** @internal Exported for greenfield integration tests and tool dispatch. */
export function buildToolExecutor(
  talkId: string,
  userId: string,
  runId: string,
  signal: AbortSignal,
  jobPolicy?: TalkJobExecutionPolicy | null,
  effectiveTools?: EffectiveToolAccess[],
  agentId?: string | null,
  agentNickname?: string | null,
  triggerMessageId?: string | null,
) {
  const googleReadToolNames = new Set([
    'google_drive_search',
    'google_drive_read',
    'google_drive_list_folder',
    'google_docs_read',
    'google_sheets_read_range',
  ]);
  const googleWriteToolNames = new Set([
    'google_docs_create',
    'google_docs_batch_update',
    'google_sheets_batch_update',
  ]);
  const enabledToolFamilies = new Set(
    (effectiveTools ?? [])
      .filter((tool) => tool.enabled)
      .map((tool) => tool.toolFamily),
  );
  const allowedRuntimeTools = buildAllowedRuntimeToolSet(effectiveTools);

  function runtimeToolDisabled(toolName: string): {
    result: string;
    isError: true;
  } | null {
    if (isRuntimeToolAllowed(allowedRuntimeTools, toolName)) return null;
    return {
      result: `Error: ${toolName} is not enabled for this agent`,
      isError: true,
    };
  }

  return async (
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    if (toolName === 'read_source') {
      const rawRef = args.sourceRef;
      if (typeof rawRef !== 'string') {
        return { result: 'Error: sourceRef parameter required', isError: true };
      }
      const ref = rawRef.trim();
      if (!ref) {
        return { result: 'Error: sourceRef parameter required', isError: true };
      }

      const db = getDbPg();
      const normalizedRef = ref.toUpperCase();
      const normalizedIdRef = ref.toLowerCase();
      const sourceRows = await db<
        Array<{
          extracted_text: string | null;
          summary: string | null;
          status: string;
          mime_type: string | null;
          expected_page_count: number | null;
          page_image_count: number;
        }>
      >`
        select
          s.extracted_text,
          s.summary,
          ${db.unsafe(CONTEXT_SOURCE_STATUS_SQL)} as status,
          s.meta_json->>'mimeType' as mime_type,
          s.expected_page_count,
          coalesce(p.page_count, 0) as page_image_count
        from public.context_sources s
        left join lateral (
          select count(*)::int as page_count
          from public.context_source_pages
          where source_id = s.id
        ) p on true
        where s.talk_id = ${talkId}::uuid
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
      const sourceRow = sourceRows[0];

      if (!sourceRow) {
        return { result: `Source ${ref} not found`, isError: true };
      }

      const hasCompletePdfPages =
        sourceRow.mime_type === PDF_ATTACHMENT_MIME_TYPE &&
        sourceRow.expected_page_count !== null &&
        sourceRow.expected_page_count > 0 &&
        sourceRow.page_image_count === sourceRow.expected_page_count;
      if (sourceRow.status !== 'ready') {
        if (hasCompletePdfPages) {
          return {
            result: `Source ${ref} has no extracted text. This PDF is available as page images in the current context; read_source only returns extracted text.`,
            isError: true,
          };
        }
        return {
          result:
            sourceRow.status === 'pending'
              ? `Source ${ref} is pending; extracted text is not available yet.`
              : `Source ${ref} is ${sourceRow.status}; extracted text is not available.`,
          isError: true,
        };
      }

      if (sourceRow.extracted_text?.trim()) {
        return { result: sourceRow.extracted_text };
      }
      if (sourceRow.summary?.trim()) {
        return { result: sourceRow.summary };
      }

      return {
        result: hasCompletePdfPages
          ? `Source ${ref} has no extracted text. This PDF is available as page images in the current context; read_source only returns extracted text.`
          : `Source ${ref} has no extracted text available.`,
        isError: true,
      };
    }

    if (
      toolName === 'read_state' ||
      toolName === 'list_state' ||
      toolName === 'update_state' ||
      toolName === 'delete_state'
    ) {
      return {
        result:
          'Error: state_not_available: Greenfield Talks do not have mutable state in this runtime.',
        isError: true,
      };
    }

    if (toolName.startsWith('connector_')) {
      return {
        result: `Unknown connector tool format: ${toolName}`,
        isError: true,
      };
    }

    if (toolName === 'web_fetch') {
      if (effectiveTools && !enabledToolFamilies.has('web')) {
        return {
          result: 'Error: web tools are not enabled for this agent',
          isError: true,
        };
      }
      const runtimeDisabled = runtimeToolDisabled(toolName);
      if (runtimeDisabled) return runtimeDisabled;
      return {
        result: 'Error: web_fetch is disabled on the greenfield runtime.',
        isError: true,
      };
    }

    if (toolName === 'web_search') {
      if (effectiveTools && !enabledToolFamilies.has('web')) {
        return {
          result: 'Error: web tools are not enabled for this agent',
          isError: true,
        };
      }
      const runtimeDisabled = runtimeToolDisabled(toolName);
      if (runtimeDisabled) return runtimeDisabled;
      if (jobPolicy && !jobPolicy.allowWeb) {
        return {
          result: 'Error: web_search is not available for this scheduled job',
          isError: true,
        };
      }
      return executeWebSearch(userId, args, signal);
    }

    if (toolName.startsWith('browser_')) {
      if (effectiveTools && !enabledToolFamilies.has('browser')) {
        return {
          result: 'Error: browser tools are not enabled for this agent',
          isError: true,
        };
      }
      const runtimeDisabled = runtimeToolDisabled(toolName);
      if (runtimeDisabled) return runtimeDisabled;
      return {
        result: 'Error: browser tools are disabled on the greenfield runtime.',
        isError: true,
      };
    }

    if (
      toolName === 'google_drive_search' ||
      toolName === 'google_drive_read' ||
      toolName === 'google_drive_list_folder' ||
      toolName === 'google_docs_read' ||
      toolName === 'google_docs_create' ||
      toolName === 'google_docs_batch_update' ||
      toolName === 'google_sheets_read_range' ||
      toolName === 'google_sheets_batch_update'
    ) {
      const requiredFamily = googleWriteToolNames.has(toolName)
        ? 'google_write'
        : googleReadToolNames.has(toolName)
          ? 'google_read'
          : null;
      if (
        effectiveTools &&
        requiredFamily &&
        !enabledToolFamilies.has(requiredFamily)
      ) {
        return {
          result: `Error: ${requiredFamily === 'google_write' ? 'Google write' : 'Google read'} tools are not enabled for this agent`,
          isError: true,
        };
      }
      const runtimeDisabled = runtimeToolDisabled(toolName);
      if (runtimeDisabled) return runtimeDisabled;
      return executeGoogleDriveTalkTool({
        talkId,
        userId,
        toolName,
        args,
        signal,
        jobPolicy: jobPolicy
          ? { allowExternalMutation: jobPolicy.allowExternalMutation }
          : null,
      });
    }

    if (toolName === 'apply_content_edit') {
      return {
        result:
          'Error: apply_content_edit is handled by the native greenfield document executor.',
        isError: true,
      };
    }

    return {
      result: `Tool '${toolName}' is not available in Talk context execution`,
      isError: true,
    };
  };
}

export class CleanTalkExecutor implements TalkExecutor {
  async execute(
    _input: TalkExecutorInput,
    _signal: AbortSignal,
    _emit?: (event: TalkExecutionEvent) => void,
  ): Promise<TalkExecutorOutput> {
    throw new TalkExecutorError(
      'LEGACY_EXECUTOR_RETIRED',
      'CleanTalkExecutor is retired on the greenfield runtime. Use GreenfieldTalkExecutor.',
    );
  }
}

export default CleanTalkExecutor;
