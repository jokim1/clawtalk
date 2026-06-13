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

  it('does not resurrect a deleted live entry for a terminal run (late replayed frame)', () => {
    // tool_result outbox inserts are fire-and-forget, so a late frame
    // can land after the terminal event — and replays reproduce the
    // ordering deterministically. The guard mirrors RESPONSE_DELTA's.
    let state = createInitialDetailState();
    state = detailReducer(state, {
      type: 'SNAPSHOT_HYDRATED',
      runs: [
        {
          id: RUN_ID,
          status: 'completed',
          createdAt: new Date().toISOString(),
        } as never,
      ],
    });
    expect(state.liveResponsesByRunId[RUN_ID]).toBeUndefined();

    state = detailReducer(state, {
      type: 'TOOL_RESULT',
      event: toolResultEvent(),
    });

    expect(state.liveResponsesByRunId[RUN_ID]).toBeUndefined();
  });

  it('does not flip an already-terminal live entry back to running', () => {
    let state = createInitialDetailState();
    state = detailReducer(state, {
      type: 'RESPONSE_STARTED',
      event: startedEvent(),
    });
    state = detailReducer(state, {
      type: 'RESPONSE_FAILED',
      event: {
        talkId: TALK_ID,
        runId: RUN_ID,
        errorMessage: 'provider exploded',
      } as never,
    });
    expect(state.liveResponsesByRunId[RUN_ID]?.terminalStatus).toBe('failed');

    state = detailReducer(state, {
      type: 'TOOL_RESULT',
      event: toolResultEvent(),
    });

    const live = state.liveResponsesByRunId[RUN_ID];
    expect(live?.terminalStatus).toBe('failed');
    expect(live?.pendingStatus).toBeUndefined();
    expect(live?.lastToolResult?.toolName).toBe('web_search');
  });

  it('keeps the last tool outcome through a RUN_FAILED rebuild', () => {
    let state = createInitialDetailState();
    state = detailReducer(state, {
      type: 'RESPONSE_STARTED',
      event: startedEvent(),
    });
    state = detailReducer(state, {
      type: 'TOOL_RESULT',
      event: toolResultEvent({
        result: 'web_search error: wedged',
        isError: true,
      }),
    });
    state = detailReducer(state, {
      type: 'RUN_FAILED',
      runId: RUN_ID,
      showInlineFailure: true,
      triggerMessageId: null,
      errorCode: 'run_watchdog_timeout',
      errorMessage: 'executor never settled',
    });

    const live = state.liveResponsesByRunId[RUN_ID];
    expect(live?.terminalStatus).toBe('failed');
    // Wedge/failure diagnosis is exactly when the tool outcome matters.
    expect(live?.lastToolResult).toEqual({
      toolName: 'web_search',
      result: 'web_search error: wedged',
      isError: true,
      durationMs: 850,
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

describe('talkRunReducer MERGE_HISTORICAL_RUNS reconciliation', () => {
  it('deletes a stale live entry when snapshot hydration sees a terminal run', () => {
    let state = createInitialDetailState();
    state = detailReducer(state, {
      type: 'RUN_STARTED',
      runId: RUN_ID,
      triggerMessageId: 'msg-1',
      targetAgentId: 'agent-1',
      targetAgentNickname: 'Researcher',
    });
    expect(state.liveResponsesByRunId[RUN_ID]).toBeDefined();

    state = detailReducer(state, {
      type: 'SNAPSHOT_HYDRATED',
      runs: [
        {
          id: RUN_ID,
          status: 'completed',
          createdAt: '2026-06-13T00:00:00.000Z',
          completedAt: '2026-06-13T00:00:05.000Z',
        } as never,
      ],
    });

    expect(state.runsById[RUN_ID]?.status).toBe('completed');
    expect(state.liveResponsesByRunId[RUN_ID]).toBeUndefined();
  });

  it('deletes a stale live entry when the refetched run is terminal', () => {
    let state = createInitialDetailState();
    state = detailReducer(state, {
      type: 'RUN_QUEUED',
      runId: RUN_ID,
      triggerMessageId: 'msg-1',
      targetAgentId: 'agent-1',
      targetAgentNickname: 'Researcher',
    });
    expect(state.liveResponsesByRunId[RUN_ID]).toBeDefined();

    state = detailReducer(state, {
      type: 'MERGE_HISTORICAL_RUNS',
      runs: [
        {
          id: RUN_ID,
          status: 'completed',
          createdAt: '2026-06-13T00:00:00.000Z',
          completedAt: '2026-06-13T00:00:05.000Z',
        } as never,
      ],
    });

    expect(state.runsById[RUN_ID]?.status).toBe('completed');
    expect(state.liveResponsesByRunId[RUN_ID]).toBeUndefined();
  });

  it('preserves failed live feedback when the refetched run is terminal', () => {
    let state = createInitialDetailState();
    state = detailReducer(state, {
      type: 'RUN_STARTED',
      runId: RUN_ID,
      triggerMessageId: 'msg-1',
      targetAgentId: 'agent-1',
      targetAgentNickname: 'Researcher',
    });

    state = detailReducer(state, {
      type: 'MERGE_HISTORICAL_RUNS',
      runs: [
        {
          id: RUN_ID,
          status: 'failed',
          createdAt: '2026-06-13T00:00:00.000Z',
          startedAt: '2026-06-13T00:00:01.000Z',
          completedAt: '2026-06-13T00:00:05.000Z',
          errorCode: 'provider_error',
          errorMessage: 'Provider failed.',
        } as never,
      ],
    });

    expect(state.runsById[RUN_ID]?.status).toBe('failed');
    expect(state.liveResponsesByRunId[RUN_ID]?.pendingStatus).toBeUndefined();
    expect(state.liveResponsesByRunId[RUN_ID]?.terminalStatus).toBe('failed');
    expect(state.liveResponsesByRunId[RUN_ID]?.errorMessage).toBe(
      'Provider failed.',
    );
  });

  it('preserves cancelled live feedback when the refetched run is terminal', () => {
    let state = createInitialDetailState();
    state = detailReducer(state, {
      type: 'RUN_STARTED',
      runId: RUN_ID,
      triggerMessageId: 'msg-1',
      targetAgentId: 'agent-1',
      targetAgentNickname: 'Researcher',
    });

    state = detailReducer(state, {
      type: 'SNAPSHOT_HYDRATED',
      runs: [
        {
          id: RUN_ID,
          status: 'cancelled',
          createdAt: '2026-06-13T00:00:00.000Z',
          startedAt: '2026-06-13T00:00:01.000Z',
          completedAt: '2026-06-13T00:00:05.000Z',
        } as never,
      ],
    });

    expect(state.runsById[RUN_ID]?.status).toBe('cancelled');
    expect(state.liveResponsesByRunId[RUN_ID]?.pendingStatus).toBeUndefined();
    expect(state.liveResponsesByRunId[RUN_ID]?.terminalStatus).toBe(
      'cancelled',
    );
  });

  it('preserves a live entry when the refetched run is still non-terminal', () => {
    let state = createInitialDetailState();
    state = detailReducer(state, {
      type: 'RUN_QUEUED',
      runId: RUN_ID,
      triggerMessageId: 'msg-1',
      targetAgentId: 'agent-1',
      targetAgentNickname: 'Researcher',
    });

    state = detailReducer(state, {
      type: 'MERGE_HISTORICAL_RUNS',
      runs: [
        {
          id: RUN_ID,
          status: 'running',
          createdAt: '2026-06-13T00:00:00.000Z',
          startedAt: '2026-06-13T00:00:01.000Z',
        } as never,
      ],
    });

    expect(state.runsById[RUN_ID]?.status).toBe('running');
    expect(state.liveResponsesByRunId[RUN_ID]).toBeDefined();
  });
});
