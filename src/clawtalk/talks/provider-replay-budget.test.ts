import { describe, expect, it } from 'vitest';

import {
  fitsProviderReplayBudget,
  providerReplaySizeBytes,
} from './provider-replay-budget.js';

describe('provider replay budget', () => {
  it('accepts payloads at the byte budget and rejects payloads over it', () => {
    expect(fitsProviderReplayBudget('abc', 5)).toBe(true);
    expect(fitsProviderReplayBudget('abcd', 5)).toBe(false);
  });

  it('treats non-serializable provider payloads as over budget', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(providerReplaySizeBytes(circular)).toBe(Number.POSITIVE_INFINITY);
    expect(fitsProviderReplayBudget(circular)).toBe(false);
  });
});
