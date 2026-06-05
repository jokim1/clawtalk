// Wire shape of a persisted run-context snapshot — the JSON the
// `/api/v1/talks/:talkId/runs/:runId/context` route returns and the
// `run_context_snapshots` row stores. Produced by `toRunContextSnapshot`
// in greenfield-detail.ts and consumed by the run-context routes.
//
// Extracted from the retired `context-loader.ts` (the legacy executor's
// context builder; the live runtime uses greenfield-executor.ts's own
// loaders). These types were the only surface of that 2.8k-LOC module
// still referenced by live code.

import type { TalkPersonaRole } from '../llm/types.js';

export interface TalkRunContextStateEntrySnapshot {
  key: string;
  value: unknown;
  version: number;
  updatedAt: string;
  reason: 'state_snapshot' | 'retrieved';
}

export interface TalkRunContextSourceManifestItem {
  ref: string;
  title: string;
  sourceType: string;
  sourceUrl: string | null;
  fileName: string | null;
}

export interface TalkRunContextInlineSourceSnapshot {
  ref: string;
  text: string;
}

export interface TalkRunContextRetrievedSourceSnapshot {
  ref: string;
  title: string;
  excerpt: string;
}

export interface TalkRunContextSnapshot {
  version: 1;
  threadId: string | null;
  personaRole: TalkPersonaRole | null;
  roleHint: string | null;
  goalIncluded: boolean;
  summaryIncluded: boolean;
  activeRules: string[];
  stateSnapshot: {
    totalCount: number;
    omittedCount: number;
    included: TalkRunContextStateEntrySnapshot[];
  };
  sources: {
    totalCount: number;
    manifest: TalkRunContextSourceManifestItem[];
    inline: TalkRunContextInlineSourceSnapshot[];
    forcedInjection: {
      refs: string[];
      slugs: string[];
      bytes: number;
    };
  };
  retrieval: {
    query: string | null;
    queryTerms: string[];
    roleTerms: string[];
    state: TalkRunContextStateEntrySnapshot[];
    sources: TalkRunContextRetrievedSourceSnapshot[];
  };
  tools: {
    contextToolNames: string[];
    connectorToolNames: string[];
  };
  history: {
    messageIds: string[];
    turnCount: number;
  };
  estimatedTokens: number;
}
