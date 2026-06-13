import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/agent-accessors.js', () => ({
  getRegisteredAgent: vi.fn(),
}));
vi.mock('./execution-resolver.js', () => ({
  resolveExecution: vi.fn(),
  ExecutionResolverError: class ExecutionResolverError extends Error {
    code: string;

    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));
vi.mock('./llm-client.js', () => ({
  streamLlmResponse: vi.fn(),
  LlmClientError: class LlmClientError extends Error {
    failureClass: string;
    statusCode?: number;

    constructor(message: string, failureClass: string, statusCode?: number) {
      super(message);
      this.failureClass = failureClass;
      this.statusCode = statusCode;
    }
  },
}));

import { getRegisteredAgent } from '../db/agent-accessors.js';
import { resolveExecution } from './execution-resolver.js';
import { streamLlmResponse } from './llm-client.js';
import {
  ALWAYS_ALLOWED_CONTEXT_TOOLS,
  READ_ONLY_PARALLELIZABLE_TOOLS,
  READ_ONLY_TOOL_CONCURRENCY,
  executeWithAgent,
} from './agent-router.js';
import { DeadlineBudget } from '../talks/deadline-budget.js';

describe('agent-router', () => {
  beforeEach(() => {
    vi.mocked(getRegisteredAgent).mockReturnValue({
      id: 'agent-1',
      enabled: 1,
      provider_id: 'provider.openai',
      model_id: 'gpt-5-mini',
      system_prompt: 'Be useful.',
    } as never);
    vi.mocked(resolveExecution).mockReturnValue({
      providerConfig: {
        providerId: 'provider.openai',
        baseUrl: 'https://api.openai.com/v1',
        apiFormat: 'openai_chat_completions',
        authScheme: 'bearer',
      },
      secret: {
        apiKey: 'sk-test',
      },
    } as never);
  });

  it('does not permit retired state tools implicitly', () => {
    expect(ALWAYS_ALLOWED_CONTEXT_TOOLS.has('read_state')).toBe(false);
    expect(ALWAYS_ALLOWED_CONTEXT_TOOLS.has('list_state')).toBe(false);
  });

  it('always permits apply_content_edit (Talk-internal Content edits)', () => {
    // The Content tool belongs to no tool family, so the Talk effective
    // set never enables it. Without ALWAYS_ALLOWED inclusion it gets
    // silently filtered for every agent, breaking the feature.
    expect(ALWAYS_ALLOWED_CONTEXT_TOOLS.has('apply_content_edit')).toBe(true);
  });

  it('fails incomplete direct-http responses when the provider stops early', async () => {
    vi.mocked(streamLlmResponse).mockImplementation(async function* () {
      yield { type: 'text_delta', text: "I'll read the full content" };
      yield { type: 'done', stopReason: 'length' };
    } as typeof streamLlmResponse);

    const events: Array<Record<string, unknown>> = [];
    await expect(
      executeWithAgent('agent-1', null, 'Review both docs', {
        runId: 'run-1',
        userId: 'owner-1',
        emit: (event) => events.push(event as Record<string, unknown>),
      }),
    ).rejects.toMatchObject({
      code: 'incomplete_response',
    });

    const failedEvent = events.find((event) => event.type === 'failed');
    expect(failedEvent).toMatchObject({
      errorCode: 'incomplete_response',
      completion: {
        completionStatus: 'incomplete',
        providerStopReason: 'length',
        incompleteReason: 'truncated',
      },
    });
    expect(events.some((event) => event.type === 'completed')).toBe(false);
  });

  it('retries Codex incomplete responses up to MAX_CODEX_CONTINUATIONS, threading provider_data into the replay', async () => {
    vi.mocked(resolveExecution).mockReturnValue({
      providerConfig: {
        providerId: 'provider.openai_codex',
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        apiFormat: 'codex_responses',
        authScheme: 'bearer',
      },
      secret: { apiKey: 'oauth-token', credentialKind: 'subscription' },
    } as never);

    const reasoningBlob = {
      type: 'reasoning',
      encrypted_content: 'OPAQUE',
      summary: [],
    };
    let call = 0;
    const seenMessageHistories: unknown[][] = [];
    vi.mocked(streamLlmResponse).mockImplementation(async function* (
      _provider,
      _secret,
      _modelId,
      messages,
    ) {
      // Snapshot history each turn so we can verify replay.
      seenMessageHistories.push([...messages]);
      call += 1;
      if (call === 1) {
        // First turn: reasoning-only / commentary, incomplete.
        yield { type: 'text_delta', text: 'thinking…' };
        yield {
          type: 'provider_data',
          providerData: { codexReasoningItems: [reasoningBlob] },
        };
        yield { type: 'done', stopReason: 'incomplete' };
        return;
      }
      // Second turn: clean answer.
      yield { type: 'text_delta', text: 'final answer' };
      yield { type: 'done', stopReason: 'stop' };
    } as typeof streamLlmResponse);

    const result = await executeWithAgent('agent-1', null, 'Compute X', {
      runId: 'run-codex',
      userId: 'owner-1',
    });

    expect(call).toBe(2);
    // Final content concatenates both turns.
    expect(result.content).toBe('thinking…final answer');
    // The retry turn re-sent the reasoning blob as part of the
    // assistant continuation message.
    const retryHistory = seenMessageHistories[1] as Array<{
      role: string;
      providerData?: { codexReasoningItems?: unknown[] };
    }>;
    const continuation = retryHistory.find(
      (m) => m.role === 'assistant' && m.providerData?.codexReasoningItems,
    );
    expect(continuation).toBeTruthy();
  });

  it('passes the model default output budget through to the direct HTTP client', async () => {
    vi.mocked(resolveExecution).mockReturnValue({
      providerConfig: {
        providerId: 'provider.openai',
        baseUrl: 'https://api.openai.com/v1',
        apiFormat: 'openai_chat_completions',
        authScheme: 'bearer',
      },
      secret: {
        apiKey: 'sk-test',
      },
      defaultMaxOutputTokens: 8192,
    } as never);
    vi.mocked(streamLlmResponse).mockImplementation(async function* (
      _provider,
      _secret,
      _modelId,
      _messages,
      options,
    ) {
      expect(options?.maxOutputTokens).toBe(8192);
      yield { type: 'text_delta', text: 'Ready.' };
      yield { type: 'done', stopReason: 'stop' };
    } as typeof streamLlmResponse);

    const result = await executeWithAgent('agent-1', null, 'Review both docs', {
      runId: 'run-2',
      userId: 'owner-1',
    });

    expect(result.content).toBe('Ready.');
  });

  it('gates context-tool DEFINITIONS on the Talk effective set (effectiveTools drives the tool list)', async () => {
    let capturedToolNames: string[] = [];
    vi.mocked(streamLlmResponse).mockImplementation(async function* (
      _provider,
      _secret,
      _modelId,
      _messages,
      options,
    ) {
      capturedToolNames = (
        (options?.tools ?? []) as Array<{ name: string }>
      ).map((t) => t.name);
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', stopReason: 'stop' };
    } as typeof streamLlmResponse);

    const context = {
      systemPrompt: 'Talk system prompt',
      contextTools: [{ name: 'web_search' }],
      connectorTools: [],
      history: [],
    };

    await executeWithAgent('agent-1', context as never, 'search please', {
      runId: 'run-tools-on',
      userId: 'owner-1',
      effectiveTools: [
        {
          toolFamily: 'web',
          runtimeTools: ['web_search'],
          enabled: true,
          requiresApproval: false,
        },
      ],
    });

    expect(capturedToolNames).toContain('web_search');
  });

  it('defaults to NO tools when effectiveTools is absent (D8 fail-safe — never silently all-light)', async () => {
    let capturedToolNames: string[] = [];
    vi.mocked(streamLlmResponse).mockImplementation(async function* (
      _provider,
      _secret,
      _modelId,
      _messages,
      options,
    ) {
      capturedToolNames = (
        (options?.tools ?? []) as Array<{ name: string }>
      ).map((t) => t.name);
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', stopReason: 'stop' };
    } as typeof streamLlmResponse);

    const context = {
      systemPrompt: 'Talk system prompt',
      contextTools: [{ name: 'web_search' }],
      connectorTools: [],
      history: [],
    };

    // No effectiveTools passed → web_search (not an always-allowed context
    // tool) must be filtered out of the tool definitions.
    await executeWithAgent('agent-1', context as never, 'search please', {
      runId: 'run-tools-absent',
      userId: 'owner-1',
    });

    expect(capturedToolNames).not.toContain('web_search');
  });

  it('stamps durationMs on tool_result emits for both resolved and thrown tools (P1-f)', async () => {
    vi.useFakeTimers();
    try {
      let llmCall = 0;
      vi.mocked(streamLlmResponse).mockImplementation(async function* () {
        llmCall += 1;
        if (llmCall === 1) {
          yield {
            type: 'tool_call_start',
            toolCall: { id: 'tc-1', name: 'web_search' },
          };
          yield {
            type: 'tool_call_delta',
            toolCall: { id: 'tc-1', arguments: '{"query":"news"}' },
          };
          yield { type: 'done', stopReason: 'tool_calls' };
        } else if (llmCall === 2) {
          yield {
            type: 'tool_call_start',
            toolCall: { id: 'tc-2', name: 'read_source' },
          };
          yield {
            type: 'tool_call_delta',
            toolCall: { id: 'tc-2', arguments: '{"sourceRef":"s-1"}' },
          };
          yield { type: 'done', stopReason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'done' };
          yield { type: 'done', stopReason: 'stop' };
        }
      } as typeof streamLlmResponse);

      const context = {
        systemPrompt: 'Talk system prompt',
        contextTools: [{ name: 'web_search' }, { name: 'read_source' }],
        connectorTools: [],
        history: [],
      };
      const events: Array<Record<string, unknown>> = [];
      await executeWithAgent('agent-1', context as never, 'use tools', {
        runId: 'run-durations',
        userId: 'owner-1',
        emit: (event) => events.push(event as Record<string, unknown>),
        effectiveTools: [
          {
            toolFamily: 'web',
            runtimeTools: ['web_search', 'read_source'],
            enabled: true,
            requiresApproval: false,
          },
        ] as never,
        executeToolCall: async (toolName: string) => {
          // Fake timers: advance the mocked clock "during" the call so
          // the router's Date.now() span is deterministic.
          vi.advanceTimersByTime(250);
          if (toolName === 'read_source') {
            throw new Error('source unavailable');
          }
          return { result: 'ok', isError: false };
        },
      });

      const toolResults = events.filter((e) => e.type === 'tool_result');
      expect(toolResults).toHaveLength(2);
      expect(toolResults[0]).toMatchObject({
        toolName: 'web_search',
        isError: false,
        durationMs: 250,
      });
      expect(toolResults[1]).toMatchObject({
        toolName: 'read_source',
        isError: true,
        durationMs: 250,
      });
      expect(String(toolResults[1]?.result)).toContain('source unavailable');
    } finally {
      vi.useRealTimers();
    }
  });

  // --- T5: parallel read-only tool execution -----------------------------

  // Drive the router's tool loop with one batch of tool calls on turn 1, then
  // a clean final answer on turn 2. Returns a handle capturing the message
  // history the router replays on turn 2 so tests can assert the tool-result
  // append order (the byte-stable prefix T4 caching depends on).
  function mockToolBatchThenFinal(
    batch: Array<{ id: string; name: string; args: string }>,
  ): { turn2Messages: Array<Record<string, unknown>> | null } {
    const captured: {
      turn2Messages: Array<Record<string, unknown>> | null;
    } = { turn2Messages: null };
    let turn = 0;
    vi.mocked(streamLlmResponse).mockImplementation(async function* (
      _provider,
      _secret,
      _modelId,
      messages,
    ) {
      turn += 1;
      if (turn === 1) {
        for (const call of batch) {
          yield {
            type: 'tool_call_start',
            toolCall: { id: call.id, name: call.name },
          };
          yield {
            type: 'tool_call_delta',
            toolCall: { id: call.id, arguments: call.args },
          };
        }
        yield { type: 'done', stopReason: 'tool_use' };
        return;
      }
      captured.turn2Messages = messages as unknown as Array<
        Record<string, unknown>
      >;
      yield { type: 'text_delta', text: 'final' };
      yield { type: 'done', stopReason: 'stop' };
    } as typeof streamLlmResponse);
    return captured;
  }

  it('runs read-only registry tools concurrently (3×100ms reads overlap, ~100ms not ~300ms)', async () => {
    mockToolBatchThenFinal([
      { id: 'r1', name: 'web_search', args: '{}' },
      { id: 'r2', name: 'web_search', args: '{}' },
      { id: 'r3', name: 'web_search', args: '{}' },
    ]);

    let inFlight = 0;
    let maxInFlight = 0;
    const executeToolCall = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 100));
      inFlight -= 1;
      return { result: 'ok' };
    });

    const startedAt = Date.now();
    await executeWithAgent('agent-1', null, 'search', {
      runId: 'run-parallel-reads',
      userId: 'owner-1',
      executeToolCall,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(executeToolCall).toHaveBeenCalledTimes(3);
    // Deterministic proof of concurrency: all three were in flight at once.
    expect(maxInFlight).toBe(3);
    // Wall-clock sanity only (maxInFlight above is the real proof): parallel
    // ≈100ms vs ≈300ms sequential. Generous bound to stay flake-free on CI.
    expect(elapsedMs).toBeLessThan(280);
  });

  it('runs non-registry (write) tools sequentially in batch order (side-effect ordering)', async () => {
    mockToolBatchThenFinal([
      { id: 'w1', name: 'apply_content_edit', args: '{"n":1}' },
      { id: 'w2', name: 'apply_content_edit', args: '{"n":2}' },
      { id: 'w3', name: 'apply_content_edit', args: '{"n":3}' },
    ]);

    const events: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const executeToolCall = vi.fn(
      async (_toolName: string, args: Record<string, unknown>) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        events.push(`start:${args.n}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        events.push(`end:${args.n}`);
        inFlight -= 1;
        return { result: 'ok' };
      },
    );

    await executeWithAgent('agent-1', null, 'edit', {
      runId: 'run-sequential-writes',
      userId: 'owner-1',
      executeToolCall,
    });

    // Writes never overlap and run strictly in batch order.
    expect(maxInFlight).toBe(1);
    expect(events).toEqual([
      'start:1',
      'end:1',
      'start:2',
      'end:2',
      'start:3',
      'end:3',
    ]);
  });

  it('runs tools absent from the registry sequentially (no name/family inference)', async () => {
    // Neither tool is in READ_ONLY_PARALLELIZABLE_TOOLS. Even though
    // 'connector_fetch' superficially reads, the partition never infers from
    // names or families — unrecognized tools default to sequential.
    mockToolBatchThenFinal([
      { id: 'u1', name: 'connector_fetch', args: '{}' },
      { id: 'u2', name: 'mystery_tool', args: '{}' },
    ]);

    let inFlight = 0;
    let maxInFlight = 0;
    const executeToolCall = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return { result: 'ok' };
    });

    await executeWithAgent('agent-1', null, 'go', {
      runId: 'run-unknown-sequential',
      userId: 'owner-1',
      executeToolCall,
    });

    expect(maxInFlight).toBe(1);
  });

  it('appends tool results in batch order even when reads finish out of order (byte-stable prefix for T4)', async () => {
    const captured = mockToolBatchThenFinal([
      { id: 'r1', name: 'web_search', args: '{"id":"r1"}' },
      { id: 'r2', name: 'web_search', args: '{"id":"r2"}' },
      { id: 'r3', name: 'web_search', args: '{"id":"r3"}' },
    ]);

    // Completion order is the REVERSE of batch order: r3 finishes first,
    // r1 finishes last.
    const delaysById: Record<string, number> = { r1: 60, r2: 30, r3: 10 };
    const executeToolCall = vi.fn(
      async (_toolName: string, args: Record<string, unknown>) => {
        const id = String(args.id);
        await new Promise((resolve) => setTimeout(resolve, delaysById[id]));
        return { result: `result-${id}` };
      },
    );

    await executeWithAgent('agent-1', null, 'search', {
      runId: 'run-stable-order',
      userId: 'owner-1',
      executeToolCall,
    });

    // openai_chat_completions emits one role:'tool' message per result. Their
    // order in the replayed history must be batch order (r1, r2, r3), NOT
    // completion order (r3, r2, r1).
    const toolMessages = (captured.turn2Messages ?? []).filter(
      (m) => (m as { role?: string }).role === 'tool',
    );
    expect(
      toolMessages.map((m) => (m as { toolCallId?: string }).toolCallId),
    ).toEqual(['r1', 'r2', 'r3']);
    expect(
      toolMessages.map((m) => (m as { content?: string }).content),
    ).toEqual(['result-r1', 'result-r2', 'result-r3']);
  });

  it('registry is the conservative pure-read set; writes AND Google reads default sequential', () => {
    // Only the two provably side-effect-free tools are parallelizable.
    expect([...READ_ONLY_PARALLELIZABLE_TOOLS].sort()).toEqual([
      'read_source',
      'web_search',
    ]);
    // Writes must never be parallelized.
    expect(READ_ONLY_PARALLELIZABLE_TOOLS.has('apply_content_edit')).toBe(
      false,
    );
    expect(READ_ONLY_PARALLELIZABLE_TOOLS.has('google_docs_create')).toBe(
      false,
    );
    expect(READ_ONLY_PARALLELIZABLE_TOOLS.has('google_docs_batch_update')).toBe(
      false,
    );
    expect(
      READ_ONLY_PARALLELIZABLE_TOOLS.has('google_sheets_batch_update'),
    ).toBe(false);
    // Google READS are intentionally excluded: their 401-retry path can
    // refresh/delete stored OAuth creds and bypasses the refresh dedupe, so
    // concurrent Google reads could stampede a credential write. Sequential
    // until that path is deduped.
    expect(READ_ONLY_PARALLELIZABLE_TOOLS.has('google_drive_read')).toBe(false);
    expect(READ_ONLY_PARALLELIZABLE_TOOLS.has('google_drive_search')).toBe(
      false,
    );
    expect(READ_ONLY_PARALLELIZABLE_TOOLS.has('google_docs_read')).toBe(false);
    expect(READ_ONLY_PARALLELIZABLE_TOOLS.has('google_sheets_read_range')).toBe(
      false,
    );
  });

  it('treats writes as barriers: reads in a run overlap, a read after a write waits for it (batch order preserved)', async () => {
    const captured = mockToolBatchThenFinal([
      { id: 'r1', name: 'web_search', args: '{"id":"r1"}' },
      { id: 'r2', name: 'web_search', args: '{"id":"r2"}' },
      { id: 'w1', name: 'apply_content_edit', args: '{"id":"w1"}' },
      { id: 'r3', name: 'web_search', args: '{"id":"r3"}' },
    ]);

    let readInFlight = 0;
    let maxReadInFlight = 0;
    let tick = 0;
    let w1EndedAt = -1;
    let r3StartedAt = -1;
    const executeToolCall = vi.fn(
      async (name: string, args: Record<string, unknown>) => {
        const id = String(args.id);
        if (name === 'web_search') {
          readInFlight += 1;
          maxReadInFlight = Math.max(maxReadInFlight, readInFlight);
          if (id === 'r3') r3StartedAt = tick++;
          await new Promise((resolve) => setTimeout(resolve, 30));
          readInFlight -= 1;
        } else {
          // A write must never run while a read is in flight.
          expect(readInFlight).toBe(0);
          await new Promise((resolve) => setTimeout(resolve, 10));
          w1EndedAt = tick++;
        }
        return { result: `result-${id}` };
      },
    );

    await executeWithAgent('agent-1', null, 'go', {
      runId: 'run-barrier',
      userId: 'owner-1',
      executeToolCall,
    });

    // r1 and r2 (contiguous reads before the write) overlapped.
    expect(maxReadInFlight).toBe(2);
    // The write is a barrier: r3 (after w1 in batch order) started only after
    // w1 finished.
    expect(w1EndedAt).toBeGreaterThanOrEqual(0);
    expect(r3StartedAt).toBeGreaterThan(w1EndedAt);
    // Final append order is batch order, not completion order.
    const toolMessages = (captured.turn2Messages ?? []).filter(
      (m) => (m as { role?: string }).role === 'tool',
    );
    expect(
      toolMessages.map((m) => (m as { toolCallId?: string }).toolCallId),
    ).toEqual(['r1', 'r2', 'w1', 'r3']);
  });

  it('bounds read-only concurrency to READ_ONLY_TOOL_CONCURRENCY for a large read run', async () => {
    const batchSize = READ_ONLY_TOOL_CONCURRENCY * 2;
    mockToolBatchThenFinal(
      Array.from({ length: batchSize }, (_unused, i) => ({
        id: `r${i}`,
        name: 'web_search',
        args: '{}',
      })),
    );

    let inFlight = 0;
    let maxInFlight = 0;
    const executeToolCall = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return { result: 'ok' };
    });

    await executeWithAgent('agent-1', null, 'go', {
      runId: 'run-cap',
      userId: 'owner-1',
      executeToolCall,
    });

    expect(executeToolCall).toHaveBeenCalledTimes(batchSize);
    // Never exceeds the cap, and saturates it (batch is larger than the cap).
    expect(maxInFlight).toBe(READ_ONLY_TOOL_CONCURRENCY);
  });

  it('honors a cancel that lands after streaming but before the tool batch launches (no tool calls fire)', async () => {
    const controller = new AbortController();
    // Stream the tool calls, then abort AFTER the final `done` event — so the
    // cancel lands between the stream loop and the tool-dispatch section,
    // exercising the pre-batch abort guard (not the stream-loop guard).
    vi.mocked(streamLlmResponse).mockImplementation(async function* () {
      yield {
        type: 'tool_call_start',
        toolCall: { id: 'r1', name: 'web_search' },
      };
      yield {
        type: 'tool_call_delta',
        toolCall: { id: 'r1', arguments: '{}' },
      };
      yield { type: 'done', stopReason: 'tool_use' };
      controller.abort();
    } as typeof streamLlmResponse);

    const executeToolCall = vi.fn(async () => ({ result: 'ok' }));
    const events: Array<Record<string, unknown>> = [];

    await expect(
      executeWithAgent('agent-1', null, 'go', {
        runId: 'run-precancel',
        userId: 'owner-1',
        signal: controller.signal,
        executeToolCall,
        emit: (event) => events.push(event as Record<string, unknown>),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    // No tool executed; a cancelled event was emitted.
    expect(executeToolCall).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'cancelled')).toBe(true);
  });

  // --- T6: run-scoped budget enforced at the step boundary ----------------

  it('stops at the step boundary with deadline_exceeded when the run budget is exhausted', async () => {
    vi.mocked(streamLlmResponse).mockClear();
    vi.mocked(streamLlmResponse).mockImplementation(async function* () {
      yield { type: 'done', stopReason: 'stop' };
    } as typeof streamLlmResponse);

    // remainingMs() === 0 from the first iteration.
    const budget = new DeadlineBudget({ totalMs: 0, defaultStepMs: 20_000 });
    const events: Array<Record<string, unknown>> = [];

    await expect(
      executeWithAgent('agent-1', null, 'go', {
        runId: 'run-budget-exhausted',
        userId: 'owner-1',
        budget,
        emit: (event) => events.push(event as Record<string, unknown>),
      }),
    ).rejects.toMatchObject({ code: 'deadline_exceeded' });

    // The loop never started an LLM round, and emitted a failed event.
    expect(streamLlmResponse).not.toHaveBeenCalled();
    expect(
      events.some(
        (e) => e.type === 'failed' && e.errorCode === 'deadline_exceeded',
      ),
    ).toBe(true);
  });

  it('runs normally when the run budget has time remaining', async () => {
    vi.mocked(streamLlmResponse).mockImplementation(async function* () {
      yield { type: 'text_delta', text: 'done' };
      yield { type: 'done', stopReason: 'stop' };
    } as typeof streamLlmResponse);

    const budget = new DeadlineBudget({
      totalMs: 60_000,
      defaultStepMs: 20_000,
    });
    const result = await executeWithAgent('agent-1', null, 'go', {
      runId: 'run-budget-ok',
      userId: 'owner-1',
      budget,
    });

    expect(result.content).toBe('done');
  });
});
