import { describe, expect, it } from 'vitest';
import type { OutboxEvent } from '../db/index.js';
import { buildConversationRunEventFilter } from './event-filters.js';

function makeEvent(
  event_type: string,
  payload: Record<string, unknown>,
): OutboxEvent {
  return {
    event_id: 1,
    topic: 'talk:t1',
    event_type,
    payload,
    created_at: new Date().toISOString(),
  };
}

describe('buildConversationRunEventFilter', () => {
  const filter = buildConversationRunEventFilter();

  it('passes through unrecognized event types unchanged', () => {
    expect(filter(makeEvent('talk_response_delta', { foo: 'bar' }))).toBe(true);
    expect(filter(makeEvent('message_appended', {}))).toBe(true);
    expect(filter(makeEvent('made_up_event', {}))).toBe(true);
  });

  for (const event_type of [
    'talk_run_queued',
    'talk_run_started',
    'talk_run_completed',
    'talk_run_failed',
  ]) {
    it(`allows ${event_type} when runKind is undefined (conversation default)`, () => {
      expect(filter(makeEvent(event_type, {}))).toBe(true);
    });

    it(`allows ${event_type} when runKind === 'conversation'`, () => {
      expect(filter(makeEvent(event_type, { runKind: 'conversation' }))).toBe(
        true,
      );
    });

    it(`blocks ${event_type} when runKind is any other value`, () => {
      expect(filter(makeEvent(event_type, { runKind: 'job' }))).toBe(false);
      expect(filter(makeEvent(event_type, { runKind: 'reaction' }))).toBe(
        false,
      );
      expect(filter(makeEvent(event_type, { runKind: null }))).toBe(false);
    });
  }
});
