import crypto from 'crypto';

// Phase 0 assumption: session tokens are high-entropy opaque secrets
// (at least 128 bits). Unsalted SHA-256 is acceptable under that
// assumption; Phase 1 may upgrade to HMAC with an installation pepper.
export function hashOpaqueToken(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// Request body hashing intentionally stays plain SHA-256 for deterministic
// idempotency comparisons and must not depend on token-hashing strategy.
export function hashRequestBody(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
