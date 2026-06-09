// Outbox-event filter helpers.
//
// These are framing-agnostic — they decide *which* events a given
// subscriber receives, independent of whether delivery is SSE
// (the current Node-mode path in `routes/events.ts`) or WebSocket
// (the upcoming Durable-Object path in `talks/user-event-hub.ts`).

import type { OutboxEvent } from '../db/index.js';

export type OutboxEventFilter = (event: OutboxEvent) => boolean;

function isConversationRunPayload(payload: Record<string, unknown>): boolean {
  return payload.runKind === undefined || payload.runKind === 'conversation';
}

export function buildConversationRunEventFilter(): OutboxEventFilter {
  return (event) => {
    switch (event.event_type) {
      case 'talk_run_queued':
      case 'talk_run_started':
      case 'talk_run_completed':
      case 'talk_run_failed':
        return isConversationRunPayload(event.payload);
      default:
        return true;
    }
  };
}
