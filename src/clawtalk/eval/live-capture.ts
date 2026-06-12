// Live eval capture + provider-backed grading.
//
// Runs an eval scenario against the REAL local stack — real Postgres rows,
// the real greenfield executor, real provider model calls — then persists a
// `source: "live"` observation file that `npm run eval -- --mode=live
// --live-root=<dir>` scores with the same deterministic signal contracts as
// the dry-run fixtures.
//
// Mechanical signals (run.created, run.status.completed, messages.persisted,
// agent.<role>.reply) are derived from actual database state after the runs
// complete. Semantic signals (e.g. strategist.thesis.unique) cannot be
// derived mechanically: each scenario agentExpectation dimension is graded by
// an evaluator model using the prompt contracts in eval/graders/*.json, and a
// dimension that passes its threshold attaches that dimension's required
// signals to the agent reply. Audit rows are persisted as a
// `<scenarioId>.audits.json` artifact next to the observation file — there is
// no agent-audit table in the product schema yet, so the observation record
// for `audit.agent_results.persisted` points at the artifact, not a table.
//
// Requirements: local Supabase running (npm run db:start),
// CLAWTALK_PROVIDER_SECRET_KEY, an API key env var for every provider the
// default team's models use (ANTHROPIC_API_KEY / OPENAI_API_KEY /
// GEMINI_API_KEY / NVIDIA_API_KEY — a preflight lists what's missing), and
// ANTHROPIC_API_KEY for evaluator grading. The capture seeds a dedicated
// eval user and rebuilds its workspace from templates each run, so captures
// are repeatable and never touch a real user's data.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../db.js';
import { callLlm, type LlmProviderConfig } from '../agents/llm-client.js';
import { encryptProviderSecret } from '../llm/provider-secret-store.js';
import {
  createGreenfieldTalk,
  listDefaultTalkAgentIds,
} from '../talks/greenfield-accessors.js';
import { enqueueGreenfieldChatTurn } from '../talks/greenfield-chat-accessors.js';
import { processTalkRunMessage } from '../talks/queue-consumer.js';
import { ensureWorkspaceBootstrapForUser } from '../workspaces/bootstrap.js';
import {
  SCORE_DIMENSIONS,
  type AgentAuditResult,
  type DefaultAgentRole,
  type EvalObservationFixture,
  type EvalScenario,
  type GraderPrompt,
  type ScoreDimension,
} from './types.js';

const EVAL_USER_ID = '0c787878-e7a1-4a11-9e1e-c1a07e7a11ed';
const EVAL_USER_EMAIL = 'eval-live-capture@clawtalk.local';
const EVALUATOR_VERSION = 'live-capture-v1';
const DEFAULT_GRADER_MODEL = 'claude-sonnet-4-6';
const SUPPORTED_SCENARIO_IDS = new Set(['s-talk-pricing-launch']);

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDirectory, '..', '..', '..');
const scenarioDirectory = path.join(repoRoot, 'eval', 'scenarios');
const graderDirectory = path.join(repoRoot, 'eval', 'graders');

const ANTHROPIC_PROVIDER: LlmProviderConfig = {
  providerId: 'provider.anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiFormat: 'anthropic_messages',
  authScheme: 'x_api_key',
};

interface CaptureCliOptions {
  scenarioIds: string[];
  liveRoot: string;
  graderModel: string;
  skipGrading: boolean;
}

interface RoleReply {
  role: DefaultAgentRole;
  runId: string;
  reply: string;
  roleMethod: string;
}

interface GraderVerdict {
  dimension: ScoreDimension;
  score: number;
  flags: string[];
  explanation: string;
  threshold: number;
  passed: boolean;
}

function parseArgs(
  argv: string[],
): CaptureCliOptions | { error: string } | { help: string } {
  const options: CaptureCliOptions = {
    scenarioIds: ['s-talk-pricing-launch'],
    liveRoot: path.join(repoRoot, 'tmp', 'eval-live-observations'),
    graderModel: process.env.EVAL_GRADER_MODEL?.trim() || DEFAULT_GRADER_MODEL,
    skipGrading: false,
  };
  for (const arg of argv) {
    if (arg.startsWith('--scenarios=')) {
      options.scenarioIds = arg
        .slice('--scenarios='.length)
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
    } else if (arg.startsWith('--live-root=')) {
      options.liveRoot = path.resolve(arg.slice('--live-root='.length));
    } else if (arg.startsWith('--grader-model=')) {
      options.graderModel = arg.slice('--grader-model='.length).trim();
    } else if (arg === '--skip-grading') {
      options.skipGrading = true;
    } else if (arg === '--help' || arg === '-h') {
      return { help: usage() };
    } else {
      return { error: `Unknown argument '${arg}'.\n${usage()}` };
    }
  }
  return options;
}

function usage(): string {
  return [
    'Usage: npm run eval:capture -- [options]',
    '  --scenarios=id[,id]     scenarios to capture (default: s-talk-pricing-launch)',
    '  --live-root=path        output directory for live observations (default: tmp/eval-live-observations)',
    '  --grader-model=model    evaluator model id (default: EVAL_GRADER_MODEL env or claude-sonnet-4-6)',
    '  --skip-grading          capture mechanical signals only; semantic checks will fail in live mode',
    '',
    'Requires local Supabase (npm run db:start), CLAWTALK_PROVIDER_SECRET_KEY,',
    'and an API key env var for every provider the default team uses',
    '(ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / NVIDIA_API_KEY).',
  ].join('\n');
}

async function loadScenario(scenarioId: string): Promise<EvalScenario> {
  const raw = await readFile(
    path.join(scenarioDirectory, `${scenarioId}.json`),
    'utf8',
  );
  return JSON.parse(raw) as EvalScenario;
}

async function loadGraderPrompts(): Promise<Map<ScoreDimension, GraderPrompt>> {
  const prompts = new Map<ScoreDimension, GraderPrompt>();
  for (const dimension of SCORE_DIMENSIONS) {
    const raw = await readFile(
      path.join(graderDirectory, `${dimension}.json`),
      'utf8',
    );
    prompts.set(dimension, JSON.parse(raw) as GraderPrompt);
  }
  return prompts;
}

async function seedEvalUser(): Promise<void> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (
      ${EVAL_USER_ID}::uuid,
      ${EVAL_USER_EMAIL},
      jsonb_build_object('full_name', 'Eval Capture')
    )
    on conflict (id) do update set
      email = excluded.email,
      raw_user_meta_data = excluded.raw_user_meta_data
  `;
  // Drop any workspace from a previous capture so every run bootstraps the
  // CURRENT default team from templates — a persisted roster from an older
  // run (edited agents, retired models) would make captures non-repeatable.
  await db`
    delete from public.workspaces
    where owner_id = ${EVAL_USER_ID}::uuid
  `;
}

const PROVIDER_ENV_KEYS: Record<string, string> = {
  'provider.anthropic': 'ANTHROPIC_API_KEY',
  'provider.openai': 'OPENAI_API_KEY',
  'provider.gemini': 'GEMINI_API_KEY',
  'provider.nvidia': 'NVIDIA_API_KEY',
};

async function seedWorkspaceSecretsForRoster(
  workspaceId: string,
  agentIds: string[],
): Promise<void> {
  const db = getDbPg();
  const providerRows = await db<Array<{ provider_id: string }>>`
    select distinct lpm.provider_id
    from public.agents a
    join public.llm_provider_models lpm
      on lpm.model_id = a.model_id
     and lpm.enabled = true
    where a.workspace_id = ${workspaceId}::uuid
      and a.id in ${db(agentIds)}
  `;
  const neededProviders = providerRows.map((row) => row.provider_id);
  const missing: string[] = [];
  for (const providerId of neededProviders) {
    const envKey = PROVIDER_ENV_KEYS[providerId];
    const apiKey = envKey ? process.env[envKey]?.trim() : undefined;
    if (!apiKey) {
      missing.push(
        `${providerId} (set ${envKey ?? 'an unsupported provider key'})`,
      );
      continue;
    }
    const ciphertext = await encryptProviderSecret({ apiKey });
    await db`
      insert into public.workspace_provider_secrets (
        workspace_id, provider_id, credential_kind, ciphertext, updated_by
      )
      values (
        ${workspaceId}::uuid, ${providerId}, 'api_key',
        ${ciphertext}, ${EVAL_USER_ID}::uuid
      )
      on conflict (workspace_id, provider_id, credential_kind) do update set
        ciphertext = excluded.ciphertext,
        updated_by = excluded.updated_by,
        updated_at = now()
    `;
  }
  if (missing.length > 0) {
    throw new Error(
      `The default team needs provider keys that are not in the environment: ${missing.join(', ')}. Live capture runs the REAL roster, so every provider it uses needs a valid key.`,
    );
  }
}

async function runScenarioTalk(scenario: EvalScenario): Promise<{
  talkId: string;
  runRows: Array<{
    id: string;
    status: string;
    sequence_index: number | null;
    role_key: string | null;
    method: string[] | null;
  }>;
  messageRows: Array<{ run_id: string | null; body: string }>;
}> {
  const workspaceId = await ensureWorkspaceBootstrapForUser(EVAL_USER_ID);

  const agentIds = await listDefaultTalkAgentIds({ workspaceId });
  if (agentIds.length < 5) {
    throw new Error(
      `Default team bootstrap returned ${agentIds.length} agents; expected 5.`,
    );
  }
  await seedWorkspaceSecretsForRoster(workspaceId, agentIds);

  const allowedRoundsLimits = [1, 2, 3, 5] as const;
  const roundsLimit =
    allowedRoundsLimits.find((limit) => limit === scenario.roundsLimit) ?? 1;
  const talk = await createGreenfieldTalk({
    workspaceId,
    createdBy: EVAL_USER_ID,
    title: `Eval capture: ${scenario.id} @ ${new Date().toISOString()}`,
    mode: scenario.mode,
    roundsLimit,
    agentIds,
  });

  const enqueued = await withUserContext(EVAL_USER_ID, () =>
    enqueueGreenfieldChatTurn({
      workspaceId,
      talkId: talk.id,
      userId: EVAL_USER_ID,
      content: scenario.userPrompt,
      targetAgentIds: agentIds,
    }),
  );
  if (!enqueued.ok) {
    throw new Error(`enqueueGreenfieldChatTurn failed: ${enqueued.reason}`);
  }

  const orderedRuns = [...enqueued.runs].sort(
    (a, b) => (a.sequence_index ?? 0) - (b.sequence_index ?? 0),
  );
  const db = getDbPg();
  for (const run of orderedRuns) {
    process.stdout.write(
      `  run ${(run.sequence_index ?? 0) + 1}/${orderedRuns.length} (${run.target_agent_name ?? run.id})...`,
    );
    await processTalkRunMessage({
      runId: run.id,
      dispatch: async () => {},
      cancelPollIntervalMs: 60_000,
    });
    // processTalkRunMessage swallows execution failures into the run row.
    // Fail fast so an ordered capture doesn't burn real model calls on a
    // transcript that is already invalid.
    const statusRows = await db<Array<{ status: string; error_json: unknown }>>`
      select status, error_json from public.runs where id = ${run.id}::uuid
    `;
    const status = statusRows[0]?.status ?? 'missing';
    if (status !== 'completed') {
      process.stdout.write(` ${status}\n`);
      throw new Error(
        `Run ${run.id} (${run.target_agent_name ?? 'agent'}) ended '${status}': ${JSON.stringify(statusRows[0]?.error_json)}`,
      );
    }
    process.stdout.write(' done\n');
  }

  const runRows = await db<
    Array<{
      id: string;
      status: string;
      sequence_index: number | null;
      role_key: string | null;
      method: string[] | null;
    }>
  >`
    select r.id, r.status, r.sequence_index, tas.role_key, tas.method
    from public.runs r
    join public.talk_agent_snapshots tas
      on tas.workspace_id = r.workspace_id
     and tas.talk_id = r.talk_id
     and tas.id = r.agent_snapshot_id
    where r.talk_id = ${talk.id}::uuid
    order by r.sequence_index asc nulls last
  `;
  const messageRows = await db<Array<{ run_id: string | null; body: string }>>`
    select run_id, body
    from public.messages
    where talk_id = ${talk.id}::uuid
      and author_kind = 'agent'
    order by created_at asc
  `;
  return { talkId: talk.id, runRows, messageRows };
}

export function collectRoleReplies(
  runRows: Awaited<ReturnType<typeof runScenarioTalk>>['runRows'],
  messageRows: Awaited<ReturnType<typeof runScenarioTalk>>['messageRows'],
): RoleReply[] {
  const replyByRun = new Map<string, string>();
  for (const message of messageRows) {
    if (message.run_id) replyByRun.set(message.run_id, message.body);
  }
  const replies: RoleReply[] = [];
  for (const run of runRows) {
    const role = run.role_key as DefaultAgentRole | null;
    const reply = replyByRun.get(run.id);
    if (!role || !reply) continue;
    replies.push({
      role,
      runId: run.id,
      reply,
      roleMethod: (run.method ?? []).join(' '),
    });
  }
  return replies;
}

function buildTranscript(scenario: EvalScenario, replies: RoleReply[]): string {
  const lines = [`User: ${scenario.userPrompt}`];
  for (const entry of replies) {
    lines.push(`${entry.role}: ${entry.reply}`);
  }
  return lines.join('\n\n');
}

export function fillTemplate(
  template: string,
  values: Record<string, string>,
): string {
  const placeholders = new Set<string>();
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    placeholders.add(match[1]!);
  }
  const missing = Array.from(placeholders).filter((key) => !(key in values));
  if (missing.length > 0) {
    throw new Error(
      `Grader template has unresolved placeholders: ${missing.join(', ')}. Grading against literal placeholder text would corrupt scores.`,
    );
  }
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => values[key]!);
}

export function parseGraderResponse(
  content: string,
): { score: number; flags: string[]; explanation: string } | null {
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      score?: unknown;
      flags?: unknown;
      explanation?: unknown;
    };
    // The grader contract is numeric_1_to_5; an out-of-range score is an
    // invalid response, not something to clamp into a pass.
    if (
      typeof parsed.score !== 'number' ||
      !Number.isFinite(parsed.score) ||
      parsed.score < 1 ||
      parsed.score > 5
    ) {
      return null;
    }
    return {
      score: parsed.score,
      flags: Array.isArray(parsed.flags)
        ? parsed.flags.filter(
            (flag): flag is string => typeof flag === 'string',
          )
        : [],
      explanation:
        typeof parsed.explanation === 'string' ? parsed.explanation : '',
    };
  } catch {
    return null;
  }
}

async function gradeRole(input: {
  scenario: EvalScenario;
  graders: Map<ScoreDimension, GraderPrompt>;
  graderModel: string;
  apiKey: string;
  roleReply: RoleReply;
  transcript: string;
  priorTranscript: string;
}): Promise<GraderVerdict[]> {
  const expectation = input.scenario.agentExpectations?.find(
    (entry) => entry.role === input.roleReply.role,
  );
  const verdicts: GraderVerdict[] = [];
  for (const dimension of SCORE_DIMENSIONS) {
    const grader = input.graders.get(dimension)!;
    const threshold =
      expectation?.dimensions[dimension]?.threshold ??
      grader.thresholdDefault ??
      input.scenario.threshold;
    // nonDuplication judges the reply against what came BEFORE it; every
    // other dimension reads the full transcript for context.
    const transcriptForDimension =
      dimension === 'nonDuplication' ? input.priorTranscript : input.transcript;
    const userMessage = fillTemplate(grader.userTemplate, {
      agentRole: input.roleReply.role,
      agentReply: input.roleReply.reply,
      talkTranscript: transcriptForDimension,
      roleMethod: input.roleReply.roleMethod || 'live default-team role method',
      userPrompt: input.scenario.userPrompt,
      expectedDynamics: input.scenario.expectedDynamics,
      tokenBudget: 'live Talk run under the default round budget',
      toolManifest: 'read_source (saved Talk sources); no other tools',
    });

    let parsed: ReturnType<typeof parseGraderResponse> = null;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      const response = await callLlm(
        ANTHROPIC_PROVIDER,
        { apiKey: input.apiKey, credentialKind: 'api_key' },
        input.graderModel,
        [
          { role: 'system', content: grader.systemPrompt },
          { role: 'user', content: userMessage },
        ],
        { maxOutputTokens: 600 },
      );
      parsed = parseGraderResponse(response.content);
    }
    if (!parsed) {
      throw new Error(
        `Grader ${dimension} for ${input.roleReply.role} returned unparseable or out-of-range output twice.`,
      );
    }
    verdicts.push({
      dimension,
      score: parsed.score,
      flags: parsed.flags,
      explanation: parsed.explanation,
      threshold,
      passed: parsed.score >= threshold,
    });
  }
  return verdicts;
}

export function buildObservation(input: {
  scenario: EvalScenario;
  runRows: Awaited<ReturnType<typeof runScenarioTalk>>['runRows'];
  messageRows: Awaited<ReturnType<typeof runScenarioTalk>>['messageRows'];
  replies: RoleReply[];
  verdictsByRole: Map<DefaultAgentRole, GraderVerdict[]>;
  audits: AgentAuditResult[];
  auditArtifact: string;
}): EvalObservationFixture {
  const events: EvalObservationFixture['events'] = [];
  for (const run of input.runRows) {
    events.push({
      kind: 'run.created',
      runId: run.id,
      signals: ['run.created'],
    });
    if (run.status === 'completed') {
      events.push({
        kind: 'run.completed',
        runId: run.id,
        signals: ['run.status.completed'],
      });
    }
  }

  const records: EvalObservationFixture['records'] = [
    {
      table: 'runs',
      completedCount: input.runRows.filter((run) => run.status === 'completed')
        .length,
      totalCount: input.runRows.length,
      signals: input.runRows.every((run) => run.status === 'completed')
        ? ['run.status.completed']
        : [],
    },
    {
      table: 'messages',
      count: input.messageRows.length,
      signals: input.messageRows.length > 0 ? ['messages.persisted'] : [],
    },
    {
      store: 'live-root',
      artifact: input.auditArtifact,
      count: input.audits.length,
      signals: input.audits.length > 0 ? ['audit.agent_results.persisted'] : [],
    },
  ];

  const agentReplies: NonNullable<EvalObservationFixture['agentReplies']> = {};
  for (const entry of input.replies) {
    const signals = new Set<string>([`agent.${entry.role}.reply`]);
    const verdicts = input.verdictsByRole.get(entry.role) ?? [];
    const expectation = input.scenario.agentExpectations?.find(
      (candidate) => candidate.role === entry.role,
    );
    for (const verdict of verdicts) {
      if (!verdict.passed) continue;
      const required =
        expectation?.dimensions[verdict.dimension]?.requiredSignals ?? [];
      for (const signal of required) signals.add(signal);
    }
    agentReplies[entry.role] = {
      reply: entry.reply,
      roleMethod: entry.roleMethod || 'live default-team role method',
      tokenBudget: 'live Talk run under default budget',
      toolManifest: [],
      signals: Array.from(signals),
    };
  }

  return {
    scenarioId: input.scenario.id,
    observedAt: new Date().toISOString(),
    source: 'live',
    transcript: [
      `User: ${input.scenario.userPrompt}`,
      ...input.replies.map((entry) => `${entry.role}: ${entry.reply}`),
    ],
    agentReplies,
    events,
    records,
  };
}

async function captureScenario(
  scenarioId: string,
  options: CaptureCliOptions,
): Promise<boolean> {
  const scenario = await loadScenario(scenarioId);
  console.log(`Capturing ${scenario.id} (${scenario.title})...`);

  // Remove any previous observation for this scenario up front — a failed
  // capture must not leave a stale file that --mode=live would score green.
  const auditArtifactName = `${scenario.id}.audits.json`;
  await rm(path.join(options.liveRoot, scenario.fixture), { force: true });
  await rm(path.join(options.liveRoot, auditArtifactName), { force: true });

  const { runRows, messageRows } = await runScenarioTalk(scenario);
  const failedRuns = runRows.filter((run) => run.status !== 'completed');
  if (failedRuns.length > 0) {
    const db = getDbPg();
    const errorRows = await db<Array<{ id: string; error_json: unknown }>>`
      select id, error_json
      from public.runs
      where id in ${db(failedRuns.map((run) => run.id))}
    `;
    for (const row of errorRows) {
      console.error(
        `  run ${row.id} failed: ${JSON.stringify(row.error_json)}`,
      );
    }
    throw new Error(
      `${failedRuns.length}/${runRows.length} runs did not complete; no observation written.`,
    );
  }
  const replies = collectRoleReplies(runRows, messageRows);
  console.log(
    `  captured ${replies.length} role replies, ${messageRows.length} messages, ${runRows.length} runs`,
  );

  const verdictsByRole = new Map<DefaultAgentRole, GraderVerdict[]>();
  const audits: AgentAuditResult[] = [];
  if (!options.skipGrading) {
    const graders = await loadGraderPrompts();
    const transcript = buildTranscript(scenario, replies);
    const apiKey = process.env.ANTHROPIC_API_KEY!.trim();
    for (const [index, roleReply] of replies.entries()) {
      process.stdout.write(`  grading ${roleReply.role}...`);
      const verdicts = await gradeRole({
        scenario,
        graders,
        graderModel: options.graderModel,
        apiKey,
        roleReply,
        transcript,
        priorTranscript: buildTranscript(scenario, replies.slice(0, index)),
      });
      verdictsByRole.set(roleReply.role, verdicts);
      const scores = Object.fromEntries(
        verdicts.map((verdict) => [verdict.dimension, verdict.score]),
      ) as Record<ScoreDimension, number>;
      audits.push({
        runId: roleReply.runId,
        scenarioId: scenario.id,
        agentRole: roleReply.role,
        evaluatorVersion: EVALUATOR_VERSION,
        scores,
        flags: verdicts.flatMap((verdict) => verdict.flags),
        explanation: verdicts
          .map((verdict) => `${verdict.dimension}: ${verdict.explanation}`)
          .join(' | '),
        createdAt: new Date().toISOString(),
        passed: verdicts.every((verdict) => verdict.passed),
      });
      process.stdout.write(
        ` ${verdicts.map((verdict) => `${verdict.dimension}=${verdict.score}`).join(' ')}\n`,
      );
    }
  } else {
    console.log('  --skip-grading: semantic signals and audits omitted');
  }

  const auditArtifact = auditArtifactName;
  const observation = buildObservation({
    scenario,
    runRows,
    messageRows,
    replies,
    verdictsByRole,
    audits,
    auditArtifact,
  });

  await mkdir(options.liveRoot, { recursive: true });
  const observationPath = path.join(options.liveRoot, scenario.fixture);
  await writeFile(observationPath, `${JSON.stringify(observation, null, 2)}\n`);
  await writeFile(
    path.join(options.liveRoot, auditArtifact),
    `${JSON.stringify(audits, null, 2)}\n`,
  );
  console.log(`  wrote ${observationPath}`);
  return true;
}

export async function runLiveCaptureCli(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ('help' in parsed) {
    console.log(parsed.help);
    return 0;
  }
  if ('error' in parsed) {
    console.error(parsed.error);
    return 2;
  }

  if (!process.env.CLAWTALK_PROVIDER_SECRET_KEY?.trim()) {
    console.error(
      'CLAWTALK_PROVIDER_SECRET_KEY is required (the executor decrypts the seeded provider secret with it). Copy it from .dev.vars.',
    );
    return 2;
  }
  if (!parsed.skipGrading && !process.env.ANTHROPIC_API_KEY?.trim()) {
    console.error(
      'ANTHROPIC_API_KEY is required for evaluator-model grading (or pass --skip-grading).',
    );
    return 2;
  }

  const unsupported = parsed.scenarioIds.filter(
    (id) => !SUPPORTED_SCENARIO_IDS.has(id),
  );
  if (unsupported.length > 0) {
    console.error(
      `Live capture does not support: ${unsupported.join(', ')}. Supported: ${Array.from(SUPPORTED_SCENARIO_IDS).join(', ')}.`,
    );
    return 2;
  }

  await initPgDatabase();
  try {
    await seedEvalUser();
    for (const scenarioId of parsed.scenarioIds) {
      await captureScenario(scenarioId, parsed);
    }
    console.log(
      `\nScore it with: npm run eval -- --mode=live --scenarios=${parsed.scenarioIds.join(',')} --live-root=${parsed.liveRoot}`,
    );
    return 0;
  } finally {
    await closePgDatabase();
  }
}
