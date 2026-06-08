import { describe, expect, it } from 'vitest';

import type { AgentProviderCard, AiAgentsPageData } from '../../lib/api';
import {
  credentialModeLabel,
  formatAgentDate,
  humanizeProviderId,
  resolveModelLabel,
  resolveProviderName,
} from './agentFormat';

function buildCatalog(): AiAgentsPageData {
  const provider = {
    id: 'provider.openai',
    name: 'OpenAI',
    modelSuggestions: [
      {
        modelId: 'gpt-5',
        displayName: 'GPT-5',
        contextWindowTokens: 0,
        defaultMaxOutputTokens: 0,
      },
    ],
  } as unknown as AgentProviderCard;
  return {
    defaultClaudeModelId: 'claude-opus-4-8',
    claudeModelSuggestions: [
      {
        modelId: 'claude-opus-4-8',
        displayName: 'Claude Opus 4.8',
        contextWindowTokens: 0,
        defaultMaxOutputTokens: 0,
      },
    ],
    additionalProviders: [provider],
  };
}

describe('humanizeProviderId', () => {
  it('strips the provider. prefix and title-cases', () => {
    expect(humanizeProviderId('provider.anthropic')).toBe('Anthropic');
  });
  it('splits separators into words', () => {
    expect(humanizeProviderId('kimi_k2')).toBe('Kimi K2');
  });
  it('falls back to the raw id when nothing is left', () => {
    expect(humanizeProviderId('provider.')).toBe('provider.');
  });
});

describe('resolveProviderName', () => {
  it('uses the catalog name when present', () => {
    expect(resolveProviderName(buildCatalog(), 'provider.openai')).toBe(
      'OpenAI',
    );
  });
  it('humanizes the id when the catalog is missing', () => {
    expect(resolveProviderName(null, 'provider.anthropic')).toBe('Anthropic');
  });
  it('humanizes the id when the provider is not in the catalog', () => {
    expect(resolveProviderName(buildCatalog(), 'provider.anthropic')).toBe(
      'Anthropic',
    );
  });
});

describe('resolveModelLabel', () => {
  it('resolves an additional-provider model', () => {
    expect(resolveModelLabel(buildCatalog(), 'gpt-5')).toBe('GPT-5');
  });
  it('resolves a Claude main-list model', () => {
    expect(resolveModelLabel(buildCatalog(), 'claude-opus-4-8')).toBe(
      'Claude Opus 4.8',
    );
  });
  it('falls back to the raw model id', () => {
    expect(resolveModelLabel(buildCatalog(), 'unknown-model')).toBe(
      'unknown-model',
    );
    expect(resolveModelLabel(null, 'unknown-model')).toBe('unknown-model');
  });
});

describe('formatAgentDate', () => {
  it('extracts the date portion of an ISO timestamp', () => {
    expect(formatAgentDate('2026-06-07T08:00:00.000Z')).toBe('2026-06-07');
  });
  it('returns a dash for empty input', () => {
    expect(formatAgentDate(null)).toBe('—');
    expect(formatAgentDate('')).toBe('—');
  });
  it('returns the raw string when it is not an ISO date', () => {
    expect(formatAgentDate('whenever')).toBe('whenever');
  });
});

describe('credentialModeLabel', () => {
  it('labels each mode', () => {
    expect(credentialModeLabel('api_key')).toBe('API key');
    expect(credentialModeLabel('subscription')).toBe('Subscription');
    expect(credentialModeLabel(null)).toBe('Auto');
  });
});
