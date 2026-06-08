import type { TalkPersonaRole } from '../llm/types.js';

export interface TalkRunContextDetails {
  version: 1;
  personaRole: TalkPersonaRole | null;
  prompt: {
    hasRedactedPrompt: boolean;
    estimatedTokens: number;
  };
  tools: {
    contextToolNames: string[];
  };
  history: {
    triggerMessageId: string | null;
    turnCount: number;
  };
}
