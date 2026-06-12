import { afterEach, describe, expect, it, vi } from 'vitest';

import { runWebSearchForUser } from '../web-search/registry.js';
import { WebSearchError } from '../web-search/types.js';
import { buildToolExecutor, WEB_SEARCH_TIMEOUT_MS } from './new-executor.js';

vi.mock('../web-search/registry.js', () => ({
  // A provider request that never settles on its own — it rejects only via
  // its abort signal, with the signal's reason, mirroring real fetch
  // semantics (including immediate rejection on an already-aborted signal).
  runWebSearchForUser: vi.fn(
    (_query: string, options?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        const abortSignal = options?.signal;
        const rejectAborted = () =>
          reject(
            abortSignal?.reason ??
              new DOMException('This operation was aborted', 'AbortError'),
          );
        if (abortSignal?.aborted) {
          rejectAborted();
          return;
        }
        abortSignal?.addEventListener('abort', rejectAborted);
      }),
  ),
}));

const TALK_ID = '0c878787-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_ID = '0c878787-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const RUN_ID = '0c878787-cccc-cccc-cccc-cccccccccccc';

const WEB_TOOL_ACCESS = [
  {
    toolFamily: 'web',
    runtimeTools: ['web_search'],
    enabled: true,
    requiresApproval: false,
  },
];

const TIMEOUT_RESULT = {
  result: `web_search error: the search provider did not respond within ${WEB_SEARCH_TIMEOUT_MS / 1000} seconds and the request was aborted. Continue with any results you already have, or retry the search once.`,
  isError: true,
};

function makeWebSearchExecutor(signal: AbortSignal) {
  return buildToolExecutor(
    TALK_ID,
    USER_ID,
    RUN_ID,
    signal,
    null,
    WEB_TOOL_ACCESS,
  );
}

describe('web_search timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts a hung provider request and returns a timeout tool error', async () => {
    vi.useFakeTimers();
    const executeTool = makeWebSearchExecutor(new AbortController().signal);

    const resultPromise = executeTool('web_search', { query: 'hangs forever' });
    await vi.advanceTimersByTimeAsync(WEB_SEARCH_TIMEOUT_MS);

    await expect(resultPromise).resolves.toEqual(TIMEOUT_RESULT);
  });

  it('keeps run cancellation on the generic abort path, not the timeout message', async () => {
    const runController = new AbortController();
    const executeTool = makeWebSearchExecutor(runController.signal);

    const resultPromise = executeTool('web_search', { query: 'cancel me' });
    runController.abort('cancelled');

    const result = await resultPromise;
    expect(result.isError).toBe(true);
    expect(result.result).not.toContain('did not respond within');
    expect(result.result).toContain('cancelled');
  });

  it('maps a late WebSearchError to its own message, not the timeout message', async () => {
    vi.mocked(runWebSearchForUser).mockRejectedValueOnce(
      new WebSearchError(
        'Tavily search failed (401): invalid key',
        'web_search.tavily',
        401,
      ),
    );
    const executeTool = makeWebSearchExecutor(new AbortController().signal);

    await expect(
      executeTool('web_search', { query: 'auth fails' }),
    ).resolves.toEqual({
      result: 'web_search error: Tavily search failed (401): invalid key',
      isError: true,
    });
  });

  it('prefers the cancel path when both the timeout and the run signal have aborted', async () => {
    vi.useFakeTimers();
    // Rejection arrives a beat after abort, leaving a window for the run
    // signal to abort after the timeout already fired.
    vi.mocked(runWebSearchForUser).mockImplementationOnce(
      (_query: string, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const abortSignal = options?.signal;
          abortSignal?.addEventListener('abort', () => {
            setTimeout(() => reject(abortSignal.reason), 5);
          });
        }),
    );
    const runController = new AbortController();
    const executeTool = makeWebSearchExecutor(runController.signal);

    const resultPromise = executeTool('web_search', { query: 'race' });
    await vi.advanceTimersByTimeAsync(WEB_SEARCH_TIMEOUT_MS);
    runController.abort('cancelled');
    await vi.advanceTimersByTimeAsync(5);

    const result = await resultPromise;
    expect(result.isError).toBe(true);
    expect(result.result).not.toContain('did not respond within');
  });
});

describe('buildToolExecutor direct fallback behavior', () => {
  it('fails closed for direct apply_content_edit calls outside the native document executor', async () => {
    const executeTool = buildToolExecutor(
      TALK_ID,
      USER_ID,
      RUN_ID,
      new AbortController().signal,
      null,
      [
        {
          toolFamily: 'document_edit',
          runtimeTools: ['apply_content_edit'],
          enabled: true,
          requiresApproval: false,
        },
      ],
    );

    await expect(
      executeTool('apply_content_edit', {
        kind: 'append',
        target: 'document',
        text: 'should not be written',
      }),
    ).resolves.toEqual({
      result:
        'Error: apply_content_edit is handled by the native greenfield document executor.',
      isError: true,
    });
  });
});
