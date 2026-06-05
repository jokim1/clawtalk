import type { TalkAgent } from './api';

/**
 * Shape of the "add an agent" footer draft on the Talk Agents tab. Owned by
 * the page (state + materialize/save handlers); shared here so TalkAgentsPanel
 * can type its props without importing back from the page (avoids a cycle).
 */
export type AgentCreationDraft = {
  sourceKind: 'claude_default' | 'provider';
  providerId: string | null;
  modelId: string;
  role: TalkAgent['role'];
};

export const TALK_AGENT_ROLE_OPTIONS: TalkAgent['role'][] = [
  'assistant',
  'analyst',
  'critic',
  'strategist',
  'devils-advocate',
  'synthesizer',
  'editor',
];

export function formatTalkRole(role: TalkAgent['role']): string {
  switch (role) {
    case 'assistant':
      return 'General';
    case 'analyst':
      return 'Analyst';
    case 'critic':
      return 'Critic';
    case 'strategist':
      return 'Strategist';
    case 'devils-advocate':
      return "Devil's Advocate";
    case 'synthesizer':
      return 'Synthesizer';
    case 'editor':
      return 'Editor';
    default:
      return role;
  }
}
