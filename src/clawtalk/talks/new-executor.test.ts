import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildToolExecutor, WEB_SEARCH_TIMEOUT_MS } from './new-executor.js';

vi.mock('../web-search/registry.js', () => ({
  // A provider request that never resolves — only the abort signal can
  // settle it, mirroring a hung fetch (which also rejects immediately
  // when handed an already-aborted signal).
  runWebSearchForUser: vi.fn(
    (_query: string, options?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        const rejectAborted = () =>
          reject(new DOMException('This operation was aborted', 'AbortError'));
        if (options?.signal?.aborted) {
          rejectAborted();
          return;
        }
        options?.signal?.addEventListener('abort', rejectAborted);
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

describe('web_search timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts a hung provider request and returns a timeout tool error', async () => {
    vi.useFakeTimers();
    const executeTool = buildToolExecutor(
      TALK_ID,
      USER_ID,
      RUN_ID,
      new AbortController().signal,
      null,
      WEB_TOOL_ACCESS,
    );

    const resultPromise = executeTool('web_search', { query: 'hangs forever' });
    await vi.advanceTimersByTimeAsync(WEB_SEARCH_TIMEOUT_MS);

    await expect(resultPromise).resolves.toEqual({
      result: `web_search error: the search provider did not respond within ${WEB_SEARCH_TIMEOUT_MS / 1000} seconds and the request was aborted. Continue with any results you already have, or retry the search once.`,
      isError: true,
    });
  });

  it('keeps run cancellation on the generic abort path, not the timeout message', async () => {
    const runController = new AbortController();
    const executeTool = buildToolExecutor(
      TALK_ID,
      USER_ID,
      RUN_ID,
      runController.signal,
      null,
      WEB_TOOL_ACCESS,
    );

    const resultPromise = executeTool('web_search', { query: 'cancel me' });
    runController.abort('cancelled');

    const result = await resultPromise;
    expect(result.isError).toBe(true);
    expect(result.result).not.toContain('did not respond within');
    expect(result.result).toContain('abort');
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
