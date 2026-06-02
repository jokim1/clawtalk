import { describe, expect, it } from 'vitest';

import {
  extractAssistantProviderData,
  selectProviderReplayMessageIds,
  type ProviderReplayCandidate,
} from './provider-replay-scope.js';

function candidate(
  id: string,
  overrides: Partial<ProviderReplayCandidate> = {},
): ProviderReplayCandidate {
  return {
    id,
    source_agent_id: 'agent-a',
    snapshot_provider_id: 'provider.codex',
    snapshot_model_id: 'codex-model',
    replay_provider_id: 'provider.codex',
    replay_model_id: 'codex-model',
    provider_data_json: {
      codexReasoningItems: [{ encrypted_content: `cipher-${id}` }],
    },
    ...overrides,
  };
}

describe('provider replay scope', () => {
  it('selects only same-agent/provider/model replay rows from the newest tail', () => {
    const selected = selectProviderReplayMessageIds(
      [
        candidate('old'),
        candidate('wrong-agent', { source_agent_id: 'agent-b' }),
        candidate('wrong-snapshot-provider', {
          snapshot_provider_id: 'provider.other',
        }),
        candidate('wrong-replay-model', { replay_model_id: 'other-model' }),
        candidate('new'),
      ],
      {
        sourceAgentId: 'agent-a',
        providerId: 'provider.codex',
        modelId: 'codex-model',
      },
    );

    expect(selected).toEqual(new Set(['old', 'new']));
  });

  it('extracts only replayable Codex provider-data keys', () => {
    expect(
      extractAssistantProviderData({
        codexReasoningItems: [{ encrypted_content: 'cipher' }],
        ignored: 'client-safe metadata',
      }),
    ).toEqual({
      codexReasoningItems: [{ encrypted_content: 'cipher' }],
    });
  });
});
