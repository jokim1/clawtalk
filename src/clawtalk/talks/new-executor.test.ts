import { describe, expect, it } from 'vitest';

import { buildToolExecutor } from './new-executor.js';

const TALK_ID = '0c878787-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_ID = '0c878787-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const RUN_ID = '0c878787-cccc-cccc-cccc-cccccccccccc';

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
