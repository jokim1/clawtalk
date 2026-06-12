// P1-f (Talk Runtime v2): tool_result events surface tool outcomes on
// the live run entry. These tests pin the reducer contract: the latest
// outcome is recorded, and it survives the subsequent delta/progress
// rebuilds (the reducer reconstructs LiveResponseView per action — a
// missing preservation line silently drops the field one event later).

import { describe, expect, it } from 'vitest';

import { createInitialDetailState, detailReducer } from './talkRunReducer';
import type {
  TalkProgressUpdateEvent,
  TalkResponseDeltaEvent,
  TalkResponseStartedEvent,
  TalkToolResultEvent,
} from './talkStream';

const RUN_ID = 'run-tool-result';
const TALK_ID = 'talk-tool-result';

function startedEvent(): TalkResponseStartedEvent {
  return {
    talkId: TALK_ID,
    runId: RUN_ID,
    agentId: 'agent-1',
    agentNickname: 'Researcher',
  } as TalkResponseStartedEvent;
}

function toolResultEvent(
  overrides?: Partial<TalkToolResultEvent>,
): TalkToolResultEvent {
  return {
    talkId: TALK_ID,
    runId: RUN_ID,
    toolName: 'web_search',
    result: '{"provider":"web_search.tavily","results":[]}',
    isError: false,
    durationMs: 850,
    ...overrides,
  };
}

describe('talkRunReducer TOOL_RESULT', () => {
  it('records the latest tool outcome on the live run entry', () => {
    let state = createInitialDetailState();
    state = detailReducer(state, {
      type: 'RESPONSE_STARTED',
      event: startedEvent(),
    });
    state = detailReducer(state, {
      type: 'TOOL_RESULT',
      event: toolResultEvent(),
    });

    expect(state.liveResponsesByRunId[RUN_ID]?.lastToolResult).toEqual({
      toolName: 'web_search',
      result: '{"provider":"web_search.tavily","results":[]}',
      isError: false,
      durationMs: 850,
    });
  });

  it('overwrites with the newest outcome and keeps error flags', () => {
    let state = createInitialDetailState();
    state = detailReducer(state, {
      type: 'RESPONSE_STARTED',
      event: startedEvent(),
    });
    state = detailReducer(state, {
      type: 'TOOL_RESULT',
      event: toolResultEvent(),
    });
    state = detailReducer(state, {
      type: 'TOOL_RESULT',
      event: toolResultEvent({
        toolName: 'read_source',
        result: 'web_search error: provider timed out',
        isError: true,
        durationMs: 20_000,
      }),
    });

    expect(state.liveResponsesByRunId[RUN_ID]?.lastToolResult).toEqual({
      toolName: 'read_source',
      result: 'web_search error: provider timed out',
      isError: true,
      durationMs: 20_000,
    });
  });

  it('survives subsequent delta and progress rebuilds of the live entry', () => {
    let state = createInitialDetailState();
    state = detailReducer(state, {
      type: 'RESPONSE_STARTED',
      event: startedEvent(),
    });
    state = detailReducer(state, {
      type: 'TOOL_RESULT',
      event: toolResultEvent(),
    });
    state = detailReducer(state, {
      type: 'RESPONSE_DELTA',
      event: {
        talkId: TALK_ID,
        runId: RUN_ID,
        deltaText: 'Based on the search results, ',
      } as TalkResponseDeltaEvent,
    });
    state = detailReducer(state, {
      type: 'RESPONSE_PROGRESS',
      event: {
        talkId: TALK_ID,
        runId: RUN_ID,
        message: 'Synthesizing…',
      } as TalkProgressUpdateEvent,
    });

    const live = state.liveResponsesByRunId[RUN_ID];
    expect(live?.rawText).toBe('Based on the search results, ');
    expect(live?.progressMessage).toBe('Synthesizing…');
    expect(live?.lastToolResult).toEqual({
      toolName: 'web_search',
      result: '{"provider":"web_search.tavily","results":[]}',
      isError: false,
      durationMs: 850,
    });
  });
});
