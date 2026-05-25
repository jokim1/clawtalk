// Generic tool-call card registry (per Liveblocks doc §
// "Tool calls as first-class UI components" + § Adoption sequencing >
// Judgment calls). Tool calls are UI citizens; each tool registers its
// own renderer keyed by `toolName`, and the timeline switches on that
// name rather than carrying a per-tool branch.

import type { ComponentType } from 'react';

import { ProposalCard, type ProposalCardProps } from './ProposalCard';
import type { ContentProposalSummary } from '../../lib/api';

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

/**
 * Map a proposal's kind to the tool name whose card renders it.
 * Keeps the timeline switch keyed on data shape, not hardcoded names.
 */
export function toolNameForProposal(
  proposal: Pick<ContentProposalSummary, 'kind'>,
): string {
  if (proposal.kind === 'replace') return 'propose_content_replace';
  if (proposal.kind === 'bulk') return 'propose_content_bulk';
  return 'propose_content_append';
}

// Default registrations.
registerToolCard('propose_content_append', ProposalCard);
registerToolCard('propose_content_replace', ProposalCard);
registerToolCard('propose_content_bulk', ProposalCard);

export { ProposalCard };
export type { ProposalCardProps } from './ProposalCard';
