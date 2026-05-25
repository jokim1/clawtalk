// Generic tool-call card registry (per Liveblocks doc §
// "Tool calls as first-class UI components" + § Adoption sequencing >
// Judgment calls). Tool calls are UI citizens; each tool registers its
// own renderer keyed by `toolName`, and the timeline switches on that
// name rather than carrying a per-tool branch.
//
// Today only `propose_content_append → ProposalCard` is registered.
// When v2 ships `propose_content_replace`, `web_search`, etc., they
// register here without touching the timeline render path.

import type { ComponentType } from 'react';

import { ProposalCard, type ProposalCardProps } from './ProposalCard';

export type ToolCardComponent =
  | ComponentType<ProposalCardProps>
  // Add other tool-card prop shapes here as future tools register cards.
  ;

const REGISTRY = new Map<string, ToolCardComponent>();

export function registerToolCard(
  toolName: string,
  card: ToolCardComponent,
): void {
  REGISTRY.set(toolName, card);
}

export function getToolCard(toolName: string): ToolCardComponent | null {
  return REGISTRY.get(toolName) ?? null;
}

// Default registrations.
registerToolCard('propose_content_append', ProposalCard);

export { ProposalCard };
export type { ProposalCardProps } from './ProposalCard';
