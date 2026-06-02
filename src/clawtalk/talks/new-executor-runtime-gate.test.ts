import { describe, expect, it } from 'vitest';

import { buildToolExecutor } from './new-executor.js';

const USER_ID = '0c000000-0000-0000-0000-000000000001';

describe('buildToolExecutor runtime tool gates', () => {
  it('denies direct apply_content_edit calls when the runtime tool is disabled', async () => {
    const executeTool = buildToolExecutor(
      '0c000000-0000-0000-0000-000000000010',
      USER_ID,
      '0c000000-0000-0000-0000-000000000011',
      new AbortController().signal,
      null,
      [
        {
          toolFamily: 'document_edit',
          runtimeTools: ['apply_content_edit'],
          enabled: false,
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
      result: 'Error: apply_content_edit is not enabled for this agent',
      isError: true,
    });
  });
});
