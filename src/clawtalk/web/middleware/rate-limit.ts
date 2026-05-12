type RateLimitBucket =
  | 'chat_write'
  | 'write'
  | 'read'
  | 'auth_start'
  | 'auth_callback'
  | 'auth_sensitive';

interface CounterState {
  count: number;
  windowStartMs: number;
}

interface RateLimitCheckInput {
  // `principalId` is the canonical identifier. `userId` remains a convenience
  // alias for older call sites that already have an authenticated user.
  userId?: string;
  principalId?: string;
  bucket: RateLimitBucket;
  nowMs?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSec: number;
}

const WINDOW_MS = 60_000;
const LIMITS: Record<RateLimitBucket, number> = {
  chat_write: 20,
  write: 60,
  read: 300,
  auth_start: 30,
  auth_callback: 30,
  auth_sensitive: 10,
};

// Phase 0 limitation: rate-limit state is process-local memory.
// Restarting the process resets counters.
const state = new Map<string, CounterState>();

export function checkRateLimit(input: RateLimitCheckInput): RateLimitResult {
  const nowMs = input.nowMs ?? Date.now();
  const limit = LIMITS[input.bucket];
  const principalId = input.principalId || input.userId || 'anonymous';
  const key = `${principalId}:${input.bucket}`;

  const existing = state.get(key);
  if (!existing || nowMs - existing.windowStartMs >= WINDOW_MS) {
    state.set(key, { count: 1, windowStartMs: nowMs });
    return {
      allowed: true,
      limit,
      remaining: limit - 1,
      retryAfterSec: 0,
    };
  }

  if (existing.count >= limit) {
    const retryAfterSec = Math.ceil(
      (WINDOW_MS - (nowMs - existing.windowStartMs)) / 1000,
    );
    return {
      allowed: false,
      limit,
      remaining: 0,
      retryAfterSec,
    };
  }

  existing.count += 1;
  state.set(key, existing);

  return {
    allowed: true,
    limit,
    remaining: Math.max(0, limit - existing.count),
    retryAfterSec: 0,
  };
}

export function _resetRateLimitStateForTests(): void {
  state.clear();
}
