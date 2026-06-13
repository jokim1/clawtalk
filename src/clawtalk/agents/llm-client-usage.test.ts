import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  streamLlmResponse,
  type LlmMessage,
  type LlmProviderConfig,
  type LlmSecret,
  type LlmStreamEvent,
} from './llm-client.js';

// Minimal Anthropic provider that skips the adaptive (DB-backed) TTFT
// timeout and the TTFT recording side effect: responseStartTimeoutMs is set,
// and providerId is omitted so onFirstChunk never touches the database.
const ANTHROPIC_PROVIDER: LlmProviderConfig = {
  baseUrl: 'https://api.anthropic.test',
  apiFormat: 'anthropic_messages',
  authScheme: 'x_api_key',
  responseStartTimeoutMs: 30_000,
  streamIdleTimeoutMs: 30_000,
  absoluteTimeoutMs: 60_000,
};

const SECRET: LlmSecret = { apiKey: 'test-key', credentialKind: 'api_key' };

function sseResponse(
  events: Array<{ event: string; data: unknown }>,
): Response {
  const body = events
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join('');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function collect(
  gen: AsyncGenerator<LlmStreamEvent>,
): Promise<LlmStreamEvent[]> {
  const events: LlmStreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('streamLlmResponse Anthropic usage accounting', () => {
  it('reports the cumulative output_tokens from message_delta, not the message_start placeholder', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: { usage: { input_tokens: 9644, output_tokens: 1 } },
            },
          },
          {
            event: 'content_block_start',
            data: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'A multi-paragraph answer.' },
            },
          },
          {
            event: 'message_delta',
            data: {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 372 },
            },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]),
      ),
    );

    const events = await collect(
      streamLlmResponse(ANTHROPIC_PROVIDER, SECRET, 'claude-opus-4-8', [
        { role: 'user', content: 'hi' },
      ]),
    );

    const usageEvents = events.filter((e) => e.type === 'usage');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      type: 'usage',
      usage: { inputTokens: 9644, outputTokens: 372 },
    });
  });

  it('prefers a message_delta input_tokens update when one is sent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: { usage: { input_tokens: 100, output_tokens: 1 } },
            },
          },
          {
            event: 'message_delta',
            data: {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { input_tokens: 110, output_tokens: 50 },
            },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]),
      ),
    );

    const events = await collect(
      streamLlmResponse(ANTHROPIC_PROVIDER, SECRET, 'claude-opus-4-8', [
        { role: 'user', content: 'hi' },
      ]),
    );

    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toMatchObject({
      usage: { inputTokens: 110, outputTokens: 50 },
    });
  });

  it('includes Anthropic cache creation and cache read tokens in input token totals', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: {
                usage: {
                  input_tokens: 120,
                  cache_creation_input_tokens: 300,
                  cache_read_input_tokens: 400,
                  output_tokens: 1,
                },
              },
            },
          },
          {
            event: 'message_delta',
            data: {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { input_tokens: 130, output_tokens: 25 },
            },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]),
      ),
    );

    const events = await collect(
      streamLlmResponse(ANTHROPIC_PROVIDER, SECRET, 'claude-opus-4-8', [
        { role: 'user', content: 'hi' },
      ]),
    );

    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toMatchObject({
      usage: {
        inputTokens: 830,
        outputTokens: 25,
        cacheCreationInputTokens: 300,
        cacheReadInputTokens: 400,
      },
    });
  });

  it('emits no usage event when the stream reports none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          {
            event: 'content_block_start',
            data: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'no usage here' },
            },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]),
      ),
    );

    const events = await collect(
      streamLlmResponse(ANTHROPIC_PROVIDER, SECRET, 'claude-opus-4-8', [
        { role: 'user', content: 'hi' },
      ]),
    );

    expect(events.some((e) => e.type === 'usage')).toBe(false);
    // The text still streams and the turn still completes cleanly.
    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });
});

describe('streamLlmResponse Anthropic prompt caching guard', () => {
  function cacheControlCount(value: unknown): number {
    if (!value || typeof value !== 'object') return 0;
    if (Array.isArray(value)) {
      return value.reduce<number>(
        (sum, item) => sum + cacheControlCount(item),
        0,
      );
    }
    const record = value as Record<string, unknown>;
    const own = Object.prototype.hasOwnProperty.call(record, 'cache_control')
      ? 1
      : 0;
    return (
      own +
      Object.entries(record).reduce<number>(
        (sum, [key, child]) =>
          key === 'cache_control' ? sum : sum + cacheControlCount(child),
        0,
      )
    );
  }

  async function captureRequestBody(
    provider: LlmProviderConfig,
    messages: LlmMessage[] = [
      { role: 'system', content: 'Use old-compatible request shape.' },
      { role: 'user', content: 'hi' },
    ],
    options?: Parameters<typeof streamLlmResponse>[4],
  ): Promise<Record<string, unknown>> {
    const captured: { requestBody?: Record<string, unknown> } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        captured.requestBody = JSON.parse(String(init?.body));
        return sseResponse([
          { event: 'message_start', data: { type: 'message_start' } },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]);
      }),
    );

    await collect(
      streamLlmResponse(
        provider,
        SECRET,
        'claude-opus-4-8',
        messages,
        options ?? {
          tools: [
            {
              name: 'read_source',
              description: 'Read source.',
              inputSchema: { type: 'object', properties: {}, required: [] },
            },
          ],
        },
      ),
    );

    if (!captured.requestBody) throw new Error('expected request body');
    return captured.requestBody;
  }

  it('sends prompt-cache markers to the official Anthropic API', async () => {
    const body = await captureRequestBody({
      ...ANTHROPIC_PROVIDER,
      providerId: 'provider.anthropic',
      baseUrl: 'https://api.anthropic.com',
    });

    expect(body.system).toEqual([
      {
        type: 'text',
        text: 'Use old-compatible request shape.',
        cache_control: { type: 'ephemeral' },
      },
    ]);
    expect(
      (body.tools as Array<Record<string, unknown>> | undefined)?.[0]
        ?.cache_control,
    ).toEqual({ type: 'ephemeral' });
    expect(body.cache_control).toEqual({ type: 'ephemeral' });
    expect(cacheControlCount(body)).toBe(3);
  });

  it('does not send global prompt-cache markers to base URL overrides', async () => {
    const body = await captureRequestBody({
      ...ANTHROPIC_PROVIDER,
      providerId: 'provider.anthropic',
      baseUrl: 'https://anthropic-proxy.example.com',
    });

    expect(body.system).toBe('Use old-compatible request shape.');
    expect(body.cache_control).toBeUndefined();
    expect(
      (body.tools as Array<Record<string, unknown>> | undefined)?.[0]
        ?.cache_control,
    ).toBeUndefined();
    expect(cacheControlCount(body)).toBe(0);
  });

  it('does not send document prompt-cache markers to base URL overrides', async () => {
    const body = await captureRequestBody(
      {
        ...ANTHROPIC_PROVIDER,
        providerId: 'provider.anthropic',
        baseUrl: 'https://anthropic-proxy.example.com',
      },
      [
        { role: 'system', content: 'Use old-compatible request shape.' },
        {
          role: 'user',
          content: [
            {
              type: 'document',
              mimeType: 'application/pdf',
              data: 'BASE64PDFDATA',
              cacheControl: 'ephemeral',
            },
            { type: 'text', text: 'Summarize.' },
          ],
        },
      ],
    );

    expect(body.system).toBe('Use old-compatible request shape.');
    expect(
      (
        (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]
          ?.content[0] ?? {}
      ).cache_control,
    ).toBeUndefined();
    expect(cacheControlCount(body)).toBe(0);
  });

  it('does not send global prompt-cache markers when providerId is not Anthropic', async () => {
    const body = await captureRequestBody({
      ...ANTHROPIC_PROVIDER,
      providerId: 'provider.proxy',
      baseUrl: 'https://api.anthropic.com',
    });

    expect(body.system).toBe('Use old-compatible request shape.');
    expect(body.cache_control).toBeUndefined();
    expect(
      (body.tools as Array<Record<string, unknown>> | undefined)?.[0]
        ?.cache_control,
    ).toBeUndefined();
    expect(cacheControlCount(body)).toBe(0);
  });

  it('does not throw or send global prompt-cache markers for invalid base URLs', async () => {
    const body = await captureRequestBody({
      ...ANTHROPIC_PROVIDER,
      providerId: 'provider.anthropic',
      baseUrl: 'not a url',
    });

    expect(body.system).toBe('Use old-compatible request shape.');
    expect(body.cache_control).toBeUndefined();
    expect(
      (body.tools as Array<Record<string, unknown>> | undefined)?.[0]
        ?.cache_control,
    ).toBeUndefined();
    expect(cacheControlCount(body)).toBe(0);
  });
});
