import { describe, expect, it } from 'vitest';

import {
  isAnthropicMissingDirectCredentialCode,
  requiresAnthropicSubscriptionContainer,
} from './execution-planner.js';

describe('execution planner credential error compatibility', () => {
  it('treats both Anthropic missing direct credential codes as fallback-safe', () => {
    expect(
      isAnthropicMissingDirectCredentialCode('ANTHROPIC_REQUIRES_API_KEY'),
    ).toBe(true);
    expect(
      isAnthropicMissingDirectCredentialCode('ANTHROPIC_REQUIRES_CREDENTIAL'),
    ).toBe(true);
    expect(
      isAnthropicMissingDirectCredentialCode('PROVIDER_SECRET_MISSING'),
    ).toBe(false);
  });

  it('requires container credentials for Anthropic subscription mode independent of browser tools', () => {
    expect(
      requiresAnthropicSubscriptionContainer({
        providerId: 'provider.anthropic',
        configuredAuthMode: 'subscription',
      }),
    ).toBe(true);
    expect(
      requiresAnthropicSubscriptionContainer({
        providerId: 'provider.anthropic',
        configuredAuthMode: 'api_key',
      }),
    ).toBe(false);
    expect(
      requiresAnthropicSubscriptionContainer({
        providerId: 'provider.openai',
        configuredAuthMode: 'subscription',
      }),
    ).toBe(false);
  });
});
