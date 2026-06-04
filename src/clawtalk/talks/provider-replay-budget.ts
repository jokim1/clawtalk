export const MAX_PROVIDER_REPLAY_BYTES = 64_000;

const textEncoder = new TextEncoder();

export function providerReplaySizeBytes(providerData: unknown): number {
  try {
    return textEncoder.encode(JSON.stringify(providerData)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function fitsProviderReplayBudget(
  providerData: unknown,
  maxBytes: number = MAX_PROVIDER_REPLAY_BYTES,
): boolean {
  return providerReplaySizeBytes(providerData) <= maxBytes;
}
