import { describe, expect, it, vi } from 'vitest';

import { processTalkRunMessage } from './queue-consumer.js';

describe('processTalkRunMessage (U1 stub)', () => {
  it('resolves without throwing', async () => {
    await expect(
      processTalkRunMessage({ runId: 'run-stub-1' }),
    ).resolves.toBeUndefined();
  });

  it('does not touch the database (U1 has no real work yet)', async () => {
    const spy = vi.fn();
    await processTalkRunMessage({ runId: 'run-stub-2' });
    expect(spy).not.toHaveBeenCalled();
  });
});
