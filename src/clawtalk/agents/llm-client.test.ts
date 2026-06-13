import { describe, expect, it, vi } from 'vitest';

import {
  buildAnthropicRequest,
  buildLlmHttpErrorMessage,
  buildOpenAiRequest,
  classifyHttpFailure,
  fetchWithUpstreamRetry,
  isCloudflareBotBlock,
  type LlmMessage,
  type LlmProviderConfig,
} from './llm-client.js';

// A representative Cloudflare managed-challenge interstitial — the body
// chatgpt.com/backend-api/codex returns when it bot-blocks a Worker.
const CLOUDFLARE_CHALLENGE_BODY =
  '<!DOCTYPE html><!--[if lt IE 7]> <html class="no-js ie6 oldie" ' +
  'lang="en-US"> <![endif]--><head><title>Attention Required! | ' +
  'Cloudflare</title><meta name="robots" content="noindex,nofollow" />' +
  '</head><body>Please enable cookies.</body></html>';

const nvidiaProvider: LlmProviderConfig = {
  providerId: 'provider.nvidia',
  baseUrl: 'https://integrate.api.nvidia.com/v1',
  apiFormat: 'openai_chat_completions',
  authScheme: 'bearer',
};

const openaiProvider: LlmProviderConfig = {
  providerId: 'provider.openai',
  baseUrl: 'https://api.openai.com/v1',
  apiFormat: 'openai_chat_completions',
  authScheme: 'bearer',
};

const geminiProvider: LlmProviderConfig = {
  providerId: 'provider.gemini',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  apiFormat: 'openai_chat_completions',
  authScheme: 'bearer',
};

const messages: LlmMessage[] = [{ role: 'user', content: 'hi' }];

describe('buildOpenAiRequest — max_tokens vs max_completion_tokens', () => {
  // OpenAI's reasoning-family models (gpt-5-*, o1, o3) hard-reject `max_tokens`.
  // Other providers using the OpenAI-compat wire format still expect the old
  // name. Assert ABSENCE of the wrong field too — emitting both keeps tests
  // green but still 400s in prod.
  it('emits max_completion_tokens (and NOT max_tokens) for provider.openai + gpt-5-mini', () => {
    const req = buildOpenAiRequest(
      openaiProvider,
      'gpt-5-mini',
      messages,
      undefined,
      1024,
    );
    expect(req.max_completion_tokens).toBe(1024);
    expect(req.max_tokens).toBeUndefined();
  });

  it('emits max_tokens (and NOT max_completion_tokens) for provider.gemini + gemini-2.5-flash', () => {
    const req = buildOpenAiRequest(
      geminiProvider,
      'gemini-2.5-flash',
      messages,
      undefined,
      1024,
    );
    expect(req.max_tokens).toBe(1024);
    expect(req.max_completion_tokens).toBeUndefined();
  });

  it('emits max_tokens (and NOT max_completion_tokens) for provider.nvidia + kimi-k2.6', () => {
    const req = buildOpenAiRequest(
      nvidiaProvider,
      'moonshotai/kimi-k2.6',
      messages,
      undefined,
      1024,
    );
    expect(req.max_tokens).toBe(1024);
    expect(req.max_completion_tokens).toBeUndefined();
  });
});

describe('buildOpenAiRequest — moonshot thinking-disabled allowlist', () => {
  it('adds thinking:disabled for kimi-k2.6 on NVIDIA', () => {
    const req = buildOpenAiRequest(
      nvidiaProvider,
      'moonshotai/kimi-k2.6',
      messages,
      undefined,
      1024,
    );
    expect(req.thinking).toEqual({ type: 'disabled' });
  });

  it('adds thinking:disabled for kimi-k2.5 on NVIDIA (legacy still listed)', () => {
    const req = buildOpenAiRequest(
      nvidiaProvider,
      'moonshotai/kimi-k2.5',
      messages,
      undefined,
      1024,
    );
    expect(req.thinking).toEqual({ type: 'disabled' });
  });

  it('does NOT add thinking for a non-allowlisted moonshot model', () => {
    // Defensive: a future moonshot variant must not be silently muted.
    // If/when such a model needs the flag, add it to MOONSHOT_NO_THINKING.
    const req = buildOpenAiRequest(
      nvidiaProvider,
      'moonshotai/kimi-future-thinking-supported',
      messages,
      undefined,
      1024,
    );
    expect(req.thinking).toBeUndefined();
  });

  it('does NOT add thinking for OpenAI gpt-5-mini', () => {
    const req = buildOpenAiRequest(
      openaiProvider,
      'gpt-5-mini',
      messages,
      undefined,
      1024,
    );
    expect(req.thinking).toBeUndefined();
  });

  it('does NOT add thinking when a moonshot modelId is sent through a non-NVIDIA provider', () => {
    const req = buildOpenAiRequest(
      openaiProvider,
      'moonshotai/kimi-k2.6',
      messages,
      undefined,
      1024,
    );
    expect(req.thinking).toBeUndefined();
  });
});

describe('buildOpenAiRequest — tool_choice gating', () => {
  const tools = [
    {
      name: 'propose_content_append',
      description: 'x',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
  ];

  it('does not set tool_choice when forceToolUse is false (default)', () => {
    const req = buildOpenAiRequest(
      openaiProvider,
      'gpt-5-mini',
      messages,
      tools,
      1024,
    );
    expect(req.tool_choice).toBeUndefined();
  });

  it('sets tool_choice="required" when forceToolUse and tools are present', () => {
    const req = buildOpenAiRequest(
      openaiProvider,
      'gpt-5-mini',
      messages,
      tools,
      1024,
      true,
    );
    expect(req.tool_choice).toBe('required');
  });

  it('does NOT set tool_choice when forceToolUse is true but tools are absent', () => {
    // Sending tool_choice with no tools is a 400 from most backends.
    const req = buildOpenAiRequest(
      openaiProvider,
      'gpt-5-mini',
      messages,
      undefined,
      1024,
      true,
    );
    expect(req.tool_choice).toBeUndefined();
  });

  it('does NOT set tool_choice when forceToolUse is true but tools array is empty', () => {
    const req = buildOpenAiRequest(
      openaiProvider,
      'gpt-5-mini',
      messages,
      [],
      1024,
      true,
    );
    expect(req.tool_choice).toBeUndefined();
  });
});

describe('classifyHttpFailure', () => {
  it('returns upstream_timeout for 502/503/504/524', () => {
    expect(classifyHttpFailure(502, '')).toBe('upstream_timeout');
    expect(classifyHttpFailure(503, '')).toBe('upstream_timeout');
    expect(classifyHttpFailure(504, '')).toBe('upstream_timeout');
    expect(classifyHttpFailure(524, 'error code: 524')).toBe(
      'upstream_timeout',
    );
  });

  it('returns upstream_5xx for other 5xx', () => {
    expect(classifyHttpFailure(500, '')).toBe('upstream_5xx');
    expect(classifyHttpFailure(599, '')).toBe('upstream_5xx');
  });

  it('keeps existing classifications', () => {
    expect(classifyHttpFailure(401, '')).toBe('auth');
    expect(classifyHttpFailure(403, '')).toBe('auth');
    expect(classifyHttpFailure(429, '')).toBe('rate_limit');
    expect(classifyHttpFailure(400, '')).toBe('invalid_request');
    expect(classifyHttpFailure(451, '')).toBe('policy');
    expect(classifyHttpFailure(404, '')).toBe('network');
  });

  it('returns "blocked" for a Cloudflare challenge body (not "auth")', () => {
    expect(classifyHttpFailure(403, CLOUDFLARE_CHALLENGE_BODY)).toBe('blocked');
  });

  it('still returns "auth" for a 403 with no Cloudflare markers', () => {
    expect(classifyHttpFailure(403, '{"error":"invalid token"}')).toBe('auth');
  });
});

describe('isCloudflareBotBlock', () => {
  it('detects the Attention Required challenge page', () => {
    expect(isCloudflareBotBlock(CLOUDFLARE_CHALLENGE_BODY)).toBe(true);
  });

  it('detects the CF 1020 "you have been blocked" page', () => {
    expect(isCloudflareBotBlock('Sorry, you have been blocked')).toBe(true);
  });

  it('is false for normal JSON error bodies and empty bodies', () => {
    expect(isCloudflareBotBlock('{"error":"invalid model"}')).toBe(false);
    expect(isCloudflareBotBlock('')).toBe(false);
    // A provider that merely mentions cloudflare in prose must not match.
    expect(
      isCloudflareBotBlock('Upstream served by Cloudflare returned 500.'),
    ).toBe(false);
  });
});

describe('buildLlmHttpErrorMessage', () => {
  it('uses a friendly lead-in for 524', () => {
    const msg = buildLlmHttpErrorMessage({
      providerLabel: 'provider.nvidia',
      status: 524,
      statusText: '',
      body: 'error code: 524',
    });
    expect(msg).toContain('provider.nvidia upstream timed out (HTTP 524');
    expect(msg).toContain('Try again in a moment');
    expect(msg).toContain('switch to another agent');
    // The raw body is still appended so logs keep the debug info.
    expect(msg).toContain('error code: 524');
  });

  it('uses a friendly lead-in for 503 (different verb)', () => {
    const msg = buildLlmHttpErrorMessage({
      providerLabel: 'provider.nvidia',
      status: 503,
      statusText: 'Service Unavailable',
      body: '',
    });
    expect(msg).toContain('is temporarily unavailable');
    expect(msg).toContain('HTTP 503');
  });

  it('uses the original format for non-upstream-timeout errors', () => {
    const msg = buildLlmHttpErrorMessage({
      providerLabel: 'provider.openai',
      status: 400,
      statusText: 'Bad Request',
      body: '{"error":"invalid model"}',
    });
    expect(msg).toBe(
      'provider.openai API error (400 Bad Request): {"error":"invalid model"}',
    );
  });

  it('renders empty statusText as <none>', () => {
    const msg = buildLlmHttpErrorMessage({
      providerLabel: 'provider.nvidia',
      status: 500,
      statusText: '',
      body: 'internal error',
    });
    expect(msg).toContain('(500 <none>)');
  });

  it('truncates very long bodies', () => {
    const longBody = 'x'.repeat(2000);
    const msg = buildLlmHttpErrorMessage({
      providerLabel: 'provider.nvidia',
      status: 524,
      statusText: '',
      body: longBody,
    });
    // 600-char cap on the body slice.
    expect(msg.length).toBeLessThan(1200);
  });

  it('returns actionable guidance for a Cloudflare block (no raw HTML)', () => {
    const msg = buildLlmHttpErrorMessage({
      providerLabel: 'Codex Responses',
      status: 403,
      statusText: 'Forbidden',
      body: CLOUDFLARE_CHALLENGE_BODY,
    });
    expect(msg).toContain('blocked by Cloudflare bot-protection');
    expect(msg).toContain('OpenAI API key');
    expect(msg).toContain('AI Agents');
    // The raw challenge HTML must NOT leak into the message.
    expect(msg).not.toContain('<!DOCTYPE');
    expect(msg).not.toContain('Attention Required');
  });
});

describe('fetchWithUpstreamRetry', () => {
  function makeResponse(status: number, body = ''): Response {
    return new Response(body, {
      status,
      statusText: status === 524 ? '' : 'OK',
    });
  }

  it('returns the first response when status is not retryable', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(200));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const res = await fetchWithUpstreamRetry(
      'https://example/x',
      {},
      controller.signal,
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('retries once on 524, then returns the second response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(524, 'error code: 524'))
      .mockResolvedValueOnce(makeResponse(200, 'ok'));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const res = await fetchWithUpstreamRetry(
      'https://example/x',
      {},
      controller.signal,
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('does not retry when parentSignal is already aborted', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(524, 'error code: 524'));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort('user_cancel');
    const res = await fetchWithUpstreamRetry(
      'https://example/x',
      {},
      controller.signal,
    );
    expect(res.status).toBe(524);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('returns the second response even when it also fails (retries are one-shot)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(524, 'error code: 524'))
      .mockResolvedValueOnce(makeResponse(524, 'still failing'));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const res = await fetchWithUpstreamRetry(
      'https://example/x',
      {},
      controller.signal,
    );
    expect(res.status).toBe(524);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});

describe('buildAnthropicRequest — prompt caching', () => {
  const cacheTools = [
    {
      name: 'read_source',
      description: 'Read a source by id.',
      inputSchema: {
        type: 'object',
        properties: { sourceId: { type: 'string' } },
        required: ['sourceId'],
      },
    },
    {
      name: 'web_search',
      description: 'Search the web.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  ];

  function promptPrefixBytes(
    req: ReturnType<typeof buildAnthropicRequest>,
    messageCount = req.messages.length,
  ): string {
    return JSON.stringify({
      tools: req.tools,
      system: req.system,
      messages: req.messages.slice(0, messageCount),
      cache_control: req.cache_control,
      tool_choice: req.tool_choice,
    });
  }

  function cacheControlCount(
    req: ReturnType<typeof buildAnthropicRequest>,
  ): number {
    return JSON.stringify(req).match(/"cache_control"/g)?.length ?? 0;
  }

  it('adds system, tool-definition, and history cache breakpoints with byte-stable tool-loop prefixes', () => {
    const baseMessages: LlmMessage[] = [
      {
        role: 'system',
        content:
          'You are Research Agent.\n\nUse the Talk sources before answering.',
      },
      {
        role: 'user',
        content: 'Compare the launch notes against current market news.',
      },
    ];
    const iterationTwoMessages: LlmMessage[] = [
      ...baseMessages,
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will inspect the source and search.' },
          {
            type: 'tool_use',
            id: 'toolu_read_source',
            name: 'read_source',
            input: { sourceId: 'S2' },
          },
          {
            type: 'tool_use',
            id: 'toolu_web_search',
            name: 'web_search',
            input: { query: 'market news launch notes' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'toolu_read_source',
            content: 'Source S2: launch notes mention a June rollout.',
          },
          {
            type: 'tool_result',
            toolUseId: 'toolu_web_search',
            content: 'Search result: competitors announced updates in June.',
          },
        ],
      },
    ];
    const iterationThreeMessages: LlmMessage[] = [
      ...iterationTwoMessages,
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_followup',
            name: 'web_search',
            input: { query: 'competitor June update detail' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'toolu_followup',
            content: 'Search result: follow-up detail stays after prior tools.',
          },
        ],
      },
    ];

    const iterationTwoReq = buildAnthropicRequest(
      'claude-sonnet-4-6',
      iterationTwoMessages,
      cacheTools,
      1024,
      'api_key',
      false,
    );
    const iterationThreeReq = buildAnthropicRequest(
      'claude-sonnet-4-6',
      iterationThreeMessages,
      cacheTools,
      1024,
      'api_key',
      false,
    );

    expect(iterationTwoReq.system).toEqual([
      {
        type: 'text',
        text: 'You are Research Agent.\n\nUse the Talk sources before answering.',
        cache_control: { type: 'ephemeral' },
      },
    ]);
    expect(iterationTwoReq.tools?.[0]).not.toHaveProperty('cache_control');
    expect(iterationTwoReq.tools?.[1]?.cache_control).toEqual({
      type: 'ephemeral',
    });
    expect(iterationTwoReq.cache_control).toEqual({ type: 'ephemeral' });
    expect(cacheControlCount(iterationTwoReq)).toBe(3);

    const toolResultBlocks =
      iterationTwoReq.messages[iterationTwoReq.messages.length - 1].content;
    expect(
      toolResultBlocks.map((block) =>
        block.type === 'tool_result' ? block.tool_use_id : null,
      ),
    ).toEqual(['toolu_read_source', 'toolu_web_search']);
    expect(promptPrefixBytes(iterationTwoReq)).toBe(
      promptPrefixBytes(iterationThreeReq, iterationTwoReq.messages.length),
    );
  });

  it('treats forced Anthropic tool_choice as cache-invalidating request shape', () => {
    const requestMessages: LlmMessage[] = [
      { role: 'system', content: 'Use tools when required.' },
      { role: 'user', content: 'Edit the attached doc.' },
    ];
    const forcedReq = buildAnthropicRequest(
      'claude-sonnet-4-6',
      requestMessages,
      cacheTools,
      1024,
      'api_key',
      true,
    );
    const nonForcedReq = buildAnthropicRequest(
      'claude-sonnet-4-6',
      requestMessages,
      cacheTools,
      1024,
      'api_key',
      false,
    );

    expect(forcedReq.tool_choice).toEqual({ type: 'any' });
    expect(nonForcedReq.tool_choice).toBeUndefined();
    expect(promptPrefixBytes(forcedReq)).not.toBe(
      promptPrefixBytes(nonForcedReq),
    );
  });

  it('keeps Anthropic subscription identity first while caching the final system block', () => {
    const req = buildAnthropicRequest(
      'claude-sonnet-4-6',
      [
        { role: 'system', content: 'Use concise answers.' },
        { role: 'user', content: 'Hi' },
      ],
      undefined,
      1024,
      'subscription',
      false,
    );

    if (!Array.isArray(req.system)) throw new Error('expected system blocks');
    expect(req.system).toHaveLength(2);
    expect(req.system[0]?.text).toContain('Claude Code');
    expect(req.system[0]).not.toHaveProperty('cache_control');
    expect(req.system[1]).toEqual({
      type: 'text',
      text: 'Use concise answers.',
      cache_control: { type: 'ephemeral' },
    });
  });

  it('can skip global cache markers for Anthropic-compatible backends', () => {
    const req = buildAnthropicRequest(
      'claude-compatible-model',
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
      cacheTools,
      1024,
      'api_key',
      false,
      false,
    );

    expect(req.system).toBe('Use old-compatible request shape.');
    expect(req.tools?.some((tool) => tool.cache_control)).toBe(false);
    expect(req.messages[0].content[0]).toMatchObject({
      cache_control: { type: 'ephemeral' },
    });
    expect(req.cache_control).toBeUndefined();
    expect(cacheControlCount(req)).toBe(1);
  });

  it('matches 1-hour document TTLs on earlier system and tool breakpoints', () => {
    const req = buildAnthropicRequest(
      'claude-sonnet-4-6',
      [
        { role: 'system', content: 'Keep the PDF context stable.' },
        {
          role: 'user',
          content: [
            {
              type: 'document',
              mimeType: 'application/pdf',
              data: 'BASE64PDFDATA',
              cacheControl: 'ephemeral_1h',
            },
            { type: 'text', text: 'Summarize the stable PDF.' },
          ],
        },
      ],
      cacheTools,
      1024,
      'api_key',
      false,
    );

    if (!Array.isArray(req.system)) throw new Error('expected system blocks');
    expect(req.system[0]?.cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
    expect(req.tools?.[1]?.cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
    expect(req.messages[0].content[0]).toMatchObject({
      cache_control: { type: 'ephemeral', ttl: '1h' },
    });
    expect(req.cache_control).toEqual({ type: 'ephemeral' });
    expect(cacheControlCount(req)).toBe(4);
  });

  it('normalizes explicit document breakpoints to 1h when any document asks for 1h', () => {
    const req = buildAnthropicRequest(
      'claude-sonnet-4-6',
      [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              mimeType: 'application/pdf',
              data: 'FIRSTPDF',
              cacheControl: 'ephemeral',
            },
            {
              type: 'document',
              mimeType: 'application/pdf',
              data: 'SECONDPDF',
              cacheControl: 'ephemeral_1h',
            },
          ],
        },
      ],
      undefined,
      1024,
      'api_key',
      false,
    );

    expect(req.messages[0].content[0]).toMatchObject({
      cache_control: { type: 'ephemeral', ttl: '1h' },
    });
    expect(req.messages[0].content[1]).toMatchObject({
      cache_control: { type: 'ephemeral', ttl: '1h' },
    });
    expect(req.cache_control).toBeUndefined();
    expect(cacheControlCount(req)).toBe(2);
  });

  it('does not add automatic history caching when the final message block already has an explicit breakpoint', () => {
    const req = buildAnthropicRequest(
      'claude-sonnet-4-6',
      [
        { role: 'system', content: 'Use the PDF.' },
        {
          role: 'user',
          content: [
            {
              type: 'document',
              mimeType: 'application/pdf',
              data: 'BASE64PDFDATA',
              cacheControl: 'ephemeral_1h',
            },
          ],
        },
      ],
      cacheTools,
      1024,
      'api_key',
      false,
    );

    expect(req.cache_control).toBeUndefined();
    expect(cacheControlCount(req)).toBe(3);
  });

  it('keeps total cache breakpoints within Anthropic four-slot budget', () => {
    const req = buildAnthropicRequest(
      'claude-sonnet-4-6',
      [
        { role: 'system', content: 'Use the PDFs.' },
        {
          role: 'user',
          content: [
            {
              type: 'document',
              mimeType: 'application/pdf',
              data: 'FIRSTPDF',
              cacheControl: 'ephemeral',
            },
            {
              type: 'document',
              mimeType: 'application/pdf',
              data: 'SECONDPDF',
              cacheControl: 'ephemeral',
            },
            { type: 'text', text: 'Compare both PDFs.' },
          ],
        },
      ],
      cacheTools,
      1024,
      'api_key',
      false,
    );

    expect(req.cache_control).toBeUndefined();
    expect(cacheControlCount(req)).toBe(4);
  });

  it('prioritizes existing document breakpoints when only one new breakpoint slot remains', () => {
    const req = buildAnthropicRequest(
      'claude-sonnet-4-6',
      [
        { role: 'system', content: 'Use the PDFs.' },
        {
          role: 'user',
          content: [
            {
              type: 'document',
              mimeType: 'application/pdf',
              data: 'FIRSTPDF',
              cacheControl: 'ephemeral',
            },
            {
              type: 'document',
              mimeType: 'application/pdf',
              data: 'SECONDPDF',
              cacheControl: 'ephemeral',
            },
            {
              type: 'document',
              mimeType: 'application/pdf',
              data: 'THIRDPDF',
              cacheControl: 'ephemeral',
            },
            { type: 'text', text: 'Compare all PDFs.' },
          ],
        },
      ],
      cacheTools,
      1024,
      'api_key',
      false,
    );

    if (!Array.isArray(req.system)) throw new Error('expected system blocks');
    expect(req.system[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(req.tools?.[1]).not.toHaveProperty('cache_control');
    expect(req.cache_control).toBeUndefined();
    expect(cacheControlCount(req)).toBe(4);
  });

  it('caps explicit document breakpoints at Anthropic four-slot limit', () => {
    const req = buildAnthropicRequest(
      'claude-sonnet-4-6',
      [
        {
          role: 'user',
          content: [1, 2, 3, 4, 5].map((index) => ({
            type: 'document' as const,
            mimeType: 'application/pdf',
            data: `PDF${index}`,
            cacheControl: 'ephemeral' as const,
          })),
        },
      ],
      undefined,
      1024,
      'api_key',
      false,
    );

    expect(
      req.messages[0].content
        .slice(0, 4)
        .map((block) =>
          'cache_control' in block ? block.cache_control : null,
        ),
    ).toEqual([
      { type: 'ephemeral' },
      { type: 'ephemeral' },
      { type: 'ephemeral' },
      { type: 'ephemeral' },
    ]);
    expect(req.messages[0].content[4]).not.toHaveProperty('cache_control');
    expect(req.cache_control).toBeUndefined();
    expect(cacheControlCount(req)).toBe(4);
  });
});

describe('buildAnthropicRequest — document blocks', () => {
  it('translates an LlmContentBlock document into the Anthropic source-block shape with cache_control', () => {
    const msgs: LlmMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            mimeType: 'application/pdf',
            data: 'BASE64PDFDATA',
            title: 'Annual Report',
            cacheControl: 'ephemeral_1h',
          },
          { type: 'text', text: 'Summarize this PDF.' },
        ],
      },
    ];
    const req = buildAnthropicRequest(
      'claude-sonnet-4-6',
      msgs,
      undefined,
      1024,
      'api_key',
      false,
    );
    expect(req.messages).toHaveLength(1);
    const userBlocks = req.messages[0].content;
    expect(userBlocks[0]).toEqual({
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: 'BASE64PDFDATA',
      },
      title: 'Annual Report',
      cache_control: { type: 'ephemeral', ttl: '1h' },
    });
    expect(userBlocks[1]).toEqual({
      type: 'text',
      text: 'Summarize this PDF.',
    });
  });

  it('drops the ttl when cacheControl is plain ephemeral', () => {
    const msgs: LlmMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            mimeType: 'application/pdf',
            data: 'x',
            cacheControl: 'ephemeral',
          },
        ],
      },
    ];
    const req = buildAnthropicRequest(
      'claude-sonnet-4-6',
      msgs,
      undefined,
      1024,
    );
    const block = req.messages[0].content[0] as Record<string, unknown>;
    expect(block.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('omits document-block cache_control when not requested', () => {
    const msgs: LlmMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            mimeType: 'application/pdf',
            data: 'x',
          },
        ],
      },
    ];
    const req = buildAnthropicRequest(
      'claude-sonnet-4-6',
      msgs,
      undefined,
      1024,
    );
    const block = req.messages[0].content[0] as Record<string, unknown>;
    expect('cache_control' in block).toBe(false);
  });
});
