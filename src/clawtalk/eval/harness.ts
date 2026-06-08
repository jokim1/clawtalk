import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type AgentAuditResult,
  DEFAULT_AGENT_ROLES,
  type DefaultAgentRole,
  type DryRunFixture,
  type DryRunObservation,
  EVAL_SCENARIO_CATEGORIES,
  type EvalCheck,
  type EvalCheckResult,
  type EvalMode,
  type EvalReport,
  type EvalScenario,
  type EvalScenarioReport,
  type EvalStatus,
  type GraderPrompt,
  SCORE_DIMENSIONS,
  type ScoreDimension,
  type SignalExpectation,
  type SignalScore,
} from './types.js';

export const EVALUATOR_VERSION = 'clawtalk-mvp-eval@1';
export const DEFAULT_SUITE_THRESHOLD = 4;

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const evalRoot = path.join(repoRoot, 'eval');
const scenarioRoot = path.join(evalRoot, 'scenarios');
const fixtureRoot = path.join(evalRoot, 'fixtures');
const graderRoot = path.join(evalRoot, 'graders');

interface RunEvaluationOptions {
  mode: EvalMode;
  scenarioIds: string[] | 'all';
  generatedAt?: string;
  scenarioRoot?: string;
  fixtureRoot?: string;
  graderRoot?: string;
}

interface CliOptions extends RunEvaluationOptions {
  format: 'pretty' | 'json';
  output?: string;
  list: boolean;
  help: boolean;
}

export function scoreRequiredSignals(
  expectation: SignalExpectation,
  observedSignals: ReadonlySet<string>,
  fallbackThreshold = DEFAULT_SUITE_THRESHOLD,
): SignalScore {
  if (expectation.requiredSignals.length === 0) {
    throw new Error('requiredSignals must not be empty');
  }

  const matchedSignals = expectation.requiredSignals.filter((signal) =>
    observedSignals.has(signal),
  );
  const missingSignals = expectation.requiredSignals.filter(
    (signal) => !observedSignals.has(signal),
  );
  const threshold = expectation.threshold ?? fallbackThreshold;
  const score = roundScore(
    1 + (matchedSignals.length / expectation.requiredSignals.length) * 4,
  );

  return {
    score,
    matchedSignals,
    missingSignals,
    threshold,
    passed: missingSignals.length === 0 && score >= threshold,
  };
}

export async function runEvaluation(
  options: RunEvaluationOptions,
): Promise<EvalReport> {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  if (options.mode === 'live') {
    return buildBlockedReport(options.mode, generatedAt);
  }

  const scenarioDirectory = options.scenarioRoot ?? scenarioRoot;
  const fixtureDirectory = options.fixtureRoot ?? fixtureRoot;
  const graderDirectory = options.graderRoot ?? graderRoot;
  const scenarios = await loadScenarios(scenarioDirectory);
  await validateGraderContracts(graderDirectory);
  const selected = selectScenarios(scenarios, options.scenarioIds);
  const scenarioReports = await Promise.all(
    selected.map((scenario) =>
      evaluateDryRunScenario(scenario, generatedAt, fixtureDirectory),
    ),
  );

  return buildReport(options.mode, generatedAt, scenarioReports);
}

export async function listScenarios(): Promise<EvalScenario[]> {
  return loadScenarios(scenarioRoot);
}

export async function validateGraderContracts(
  contractRoot = graderRoot,
): Promise<GraderPrompt[]> {
  const entries = await Promise.all(
    SCORE_DIMENSIONS.map(
      async (dimension) =>
        [
          dimension,
          await readJson<GraderPrompt>(
            path.join(contractRoot, `${dimension}.json`),
          ),
        ] as const,
    ),
  );

  for (const [dimension, grader] of entries) {
    if (grader.dimension !== dimension) {
      throw new Error(
        `Grader ${dimension} contract dimension must match its filename`,
      );
    }
    if (grader.scale !== 'numeric_1_to_5') {
      throw new Error(`Grader ${dimension} must use numeric_1_to_5 scale`);
    }
    validateThreshold(
      grader.thresholdDefault,
      `Grader ${dimension} thresholdDefault`,
    );
    validateNonEmptyString(
      grader.systemPrompt,
      `Grader ${dimension} systemPrompt`,
    );
    validateNonEmptyString(
      grader.userTemplate,
      `Grader ${dimension} userTemplate`,
    );
    if (
      !grader.userTemplate.includes('{agentRole}') ||
      !grader.userTemplate.includes('{agentReply}')
    ) {
      throw new Error(
        `Grader ${dimension} userTemplate must include agentRole and agentReply slots`,
      );
    }
    if (
      !grader.outputSchema ||
      grader.outputSchema.score !== 'number' ||
      grader.outputSchema.flags !== 'string[]' ||
      grader.outputSchema.explanation !== 'string'
    ) {
      throw new Error(
        `Grader ${dimension} outputSchema must declare score, flags, and explanation`,
      );
    }
  }

  return entries.map(([, grader]) => grader);
}

export async function runCli(argv: string[]): Promise<number> {
  const options = parseCliArgs(argv);
  if (options.help) {
    console.log(renderHelp());
    return 0;
  }

  if (options.list) {
    const scenarios = await listScenarios();
    for (const scenario of scenarios) {
      console.log(`${scenario.id}\t${scenario.category}\t${scenario.title}`);
    }
    return 0;
  }

  const report = await runEvaluation(options);
  if (options.output) {
    await mkdir(path.dirname(path.resolve(options.output)), {
      recursive: true,
    });
    await writeFile(
      options.output,
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
  }

  if (options.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderPrettyReport(report, options.output));
  }

  return exitCodeForReport(report);
}

export function exitCodeForReport(report: EvalReport): number {
  if (report.status === 'blocked') {
    return 2;
  }
  return report.status === 'pass' ? 0 : 1;
}

export function parseScenarioSelection(
  raw: string | undefined,
): string[] | 'all' {
  if (raw === undefined || raw === 'all') {
    return 'all';
  }

  const ids = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return ids;
}

export function selectScenarios(
  scenarios: EvalScenario[],
  selection: string[] | 'all',
): EvalScenario[] {
  if (selection === 'all') {
    if (scenarios.length === 0) {
      throw new Error('No eval scenarios are available');
    }
    return scenarios;
  }

  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const missing = selection.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(`Unknown eval scenario id(s): ${missing.join(', ')}`);
  }

  const selected = selection.map((id) => byId.get(id)!);
  if (selected.length === 0) {
    throw new Error('No eval scenarios selected');
  }
  return selected;
}

export function renderPrettyReport(
  report: EvalReport,
  outputPath?: string,
): string {
  const lines = [
    `ClawTalk MVP eval ${report.status.toUpperCase()} (${report.mode})`,
    `Evaluator: ${report.evaluatorVersion}`,
    `Generated: ${report.generatedAt}`,
  ];

  if (report.mode === 'dry-run') {
    lines.push(
      'Mode note: deterministic fixture observations only; not live backend or model-behavior proof.',
    );
  }

  if (report.blockedReason) {
    lines.push(`Blocked: ${report.blockedReason}`);
  }

  lines.push(
    `Summary: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount} scenarios, ` +
      `${report.summary.checkCount} checks, ` +
      `${report.summary.failedCriticalCheckCount} failed critical checks, ` +
      `${report.summary.failedAgentAuditCount}/${report.summary.agentAuditCount} failed agent audits`,
    '',
    'Scenarios:',
  );

  for (const scenario of report.scenarios) {
    const failedChecks = scenario.checkResults.filter((check) => !check.passed);
    lines.push(
      `- ${scenario.status.toUpperCase()} ${scenario.id} mean=${scenario.meanScore.toFixed(2)} ` +
        `checks=${scenario.checkResults.length - failedChecks.length}/${scenario.checkResults.length}`,
    );
    for (const failed of failedChecks) {
      lines.push(
        `  FAIL ${failed.id} score=${failed.score.toFixed(2)} threshold=${failed.threshold.toFixed(
          2,
        )} missing=${failed.missingSignals.join(',')}`,
      );
    }
  }

  const agentAudits = report.scenarios.flatMap(
    (scenario) => scenario.agentAudits,
  );
  if (agentAudits.length > 0) {
    lines.push('', 'Agent audit means:');
    for (const audit of agentAudits) {
      const mean = meanScore(Object.values(audit.scores));
      const status = audit.passed ? 'PASS' : 'FAIL';
      lines.push(
        `- ${status} ${audit.scenarioId}/${audit.agentRole} mean=${mean.toFixed(2)}`,
      );
    }
  }

  if (outputPath) {
    lines.push('', `JSON report written: ${outputPath}`);
  }

  return lines.join('\n');
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    mode: 'dry-run',
    scenarioIds: 'all',
    format: 'pretty',
    list: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--list') {
      options.list = true;
    } else if (arg.startsWith('--mode=')) {
      const mode = arg.slice('--mode='.length);
      if (mode !== 'dry-run' && mode !== 'live') {
        throw new Error(`Invalid --mode value: ${mode}`);
      }
      options.mode = mode;
    } else if (arg.startsWith('--scenarios=')) {
      options.scenarioIds = parseScenarioSelection(
        arg.slice('--scenarios='.length),
      );
    } else if (arg.startsWith('--scenario=')) {
      options.scenarioIds = parseScenarioSelection(
        arg.slice('--scenario='.length),
      );
    } else if (arg.startsWith('--format=')) {
      const format = arg.slice('--format='.length);
      if (format !== 'pretty' && format !== 'json') {
        throw new Error(`Invalid --format value: ${format}`);
      }
      options.format = format;
    } else if (arg.startsWith('--output=')) {
      options.output = arg.slice('--output='.length);
    } else {
      throw new Error(`Unknown eval argument: ${arg}`);
    }
  }

  return options;
}

function renderHelp(): string {
  return [
    'Usage: npm run eval -- [options]',
    '',
    'Options:',
    '  --mode=dry-run|live       dry-run uses deterministic fixtures; live is blocked until provider wiring lands',
    '  --scenarios=all|id,id     run all scenarios or a comma-separated subset',
    '  --format=pretty|json      print a table or raw JSON',
    '  --output=path             write the JSON report to a file',
    '  --list                    list scenario ids',
    '  --help                    show this help',
  ].join('\n');
}

async function loadScenarios(root: string): Promise<EvalScenario[]> {
  const files = (await readdir(root))
    .filter((file) => file.endsWith('.json'))
    .sort((left, right) => left.localeCompare(right));

  const scenarios = await Promise.all(
    files.map((file) => readJson<EvalScenario>(path.join(root, file))),
  );
  validateScenarioContracts(scenarios);
  return scenarios;
}

function validateScenarioContracts(scenarios: EvalScenario[]): void {
  for (const scenario of scenarios) {
    validateNonEmptyString(scenario.id, 'scenario.id');
    validateNonEmptyString(scenario.title, `${scenario.id}.title`);
    validateNonEmptyString(scenario.description, `${scenario.id}.description`);
    validateNonEmptyString(scenario.team, `${scenario.id}.team`);
    validateNonEmptyString(scenario.userPrompt, `${scenario.id}.userPrompt`);
    validateNonEmptyString(
      scenario.expectedDynamics,
      `${scenario.id}.expectedDynamics`,
    );
    validateNonEmptyString(scenario.fixture, `${scenario.id}.fixture`);
    if (!EVAL_SCENARIO_CATEGORIES.includes(scenario.category)) {
      throw new Error(
        `Scenario ${scenario.id} category must be one of ${EVAL_SCENARIO_CATEGORIES.join(', ')}`,
      );
    }
    if (scenario.mode !== 'ordered' && scenario.mode !== 'parallel') {
      throw new Error(
        `Scenario ${scenario.id} mode must be ordered or parallel`,
      );
    }
    if (
      typeof scenario.roundsLimit !== 'number' ||
      !Number.isInteger(scenario.roundsLimit) ||
      scenario.roundsLimit < 1
    ) {
      throw new Error(
        `Scenario ${scenario.id} roundsLimit must be a positive integer`,
      );
    }
    validateThreshold(scenario.threshold, `${scenario.id}.threshold`);
    if (!Array.isArray(scenario.checks) || scenario.checks.length === 0) {
      throw new Error(`Scenario ${scenario.id} must define at least one check`);
    }
    if (!scenario.checks.some((check) => check.launchCritical)) {
      throw new Error(
        `Scenario ${scenario.id} must define at least one launch-critical check`,
      );
    }

    for (const check of scenario.checks) {
      validateNonEmptyString(check.id, `${scenario.id}.check.id`);
      validateNonEmptyString(check.area, `${scenario.id}.${check.id}.area`);
      validateNonEmptyString(
        check.description,
        `${scenario.id}.${check.id}.description`,
      );
      if (typeof check.launchCritical !== 'boolean') {
        throw new Error(
          `Scenario ${scenario.id} check ${check.id} launchCritical must be boolean`,
        );
      }
      validateSignalExpectation(
        check,
        `Scenario ${scenario.id} check ${check.id}`,
      );
    }

    for (const expectation of scenario.agentExpectations ?? []) {
      if (!DEFAULT_AGENT_ROLES.includes(expectation.role)) {
        throw new Error(
          `Scenario ${scenario.id} has unknown agent role ${expectation.role}`,
        );
      }
      for (const dimension of SCORE_DIMENSIONS) {
        const signalExpectation = expectation.dimensions?.[dimension];
        if (!signalExpectation) {
          throw new Error(
            `Scenario ${scenario.id} ${expectation.role} missing ${dimension} expectation`,
          );
        }
        validateSignalExpectation(
          signalExpectation,
          `Scenario ${scenario.id} ${expectation.role} ${dimension}`,
        );
      }
    }
  }
}

function validateSignalExpectation(
  expectation: SignalExpectation,
  label: string,
): void {
  if (
    !Array.isArray(expectation.requiredSignals) ||
    expectation.requiredSignals.length === 0
  ) {
    throw new Error(`${label} requiredSignals must not be empty`);
  }
  for (const signal of expectation.requiredSignals) {
    validateNonEmptyString(signal, `${label} requiredSignals[]`);
  }
  if (expectation.threshold !== undefined) {
    validateThreshold(expectation.threshold, `${label} threshold`);
  }
}

function validateThreshold(value: unknown, label: string): void {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 1 ||
    value > 5
  ) {
    throw new Error(`${label} must be a finite number from 1 to 5`);
  }
}

function validateNonEmptyString(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

async function evaluateDryRunScenario(
  scenario: EvalScenario,
  generatedAt: string,
  root: string,
): Promise<EvalScenarioReport> {
  const fixture = await readJson<unknown>(path.join(root, scenario.fixture));
  validateDryRunFixture(fixture, scenario);

  const observedSignals = deriveObservedSignals(fixture, scenario);
  const checkResults = scenario.checks.map((check) =>
    evaluateCheck(check, observedSignals, scenario.threshold),
  );
  const agentAudits =
    scenario.agentExpectations?.map((expectation) =>
      evaluateAgentExpectation(
        scenario,
        expectation.role,
        expectation.dimensions,
        observedSignals,
        generatedAt,
      ),
    ) ?? [];

  const checksPass = checkResults.every((check) => check.passed);
  const agentAuditsPass = agentAudits.every((audit) => audit.passed);
  const scores = [
    ...checkResults.map((result) => result.score),
    ...agentAudits.flatMap((audit) => Object.values(audit.scores)),
  ];
  const mean = meanScore(scores);
  const passed = checksPass && agentAuditsPass && mean >= scenario.threshold;

  return {
    id: scenario.id,
    title: scenario.title,
    category: scenario.category,
    status: passed ? 'pass' : 'fail',
    threshold: scenario.threshold,
    meanScore: mean,
    checkResults,
    agentAudits,
  };
}

function validateDryRunFixture(
  value: unknown,
  scenario: EvalScenario,
): asserts value is DryRunFixture {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Fixture ${scenario.fixture} must be an object`);
  }

  const fixture = value as Partial<DryRunFixture>;
  validateNonEmptyString(
    fixture.scenarioId,
    `Fixture ${scenario.fixture} scenarioId`,
  );
  if (fixture.scenarioId !== scenario.id) {
    throw new Error(
      `Fixture ${scenario.fixture} belongs to ${fixture.scenarioId}, not ${scenario.id}`,
    );
  }
  validateUtcTimestamp(
    fixture.observedAt,
    `Fixture ${scenario.fixture} observedAt`,
  );
  if (fixture.source !== 'fixture') {
    throw new Error(`Fixture ${scenario.fixture} source must be fixture`);
  }
  if ('signals' in fixture) {
    throw new Error(
      `Fixture ${scenario.fixture} must attach signals to events, records, or agentReplies`,
    );
  }
  validateObservationSignals(fixture.events, scenario, 'events');
  validateObservationSignals(fixture.records, scenario, 'records');
  if (!fixture.events && !fixture.records && !fixture.agentReplies) {
    throw new Error(
      `Fixture ${scenario.fixture} must define events, records, or agentReplies with signals`,
    );
  }
  validateFixtureAgentReplies(fixture as DryRunFixture, scenario);
}

function validateObservationSignals(
  observations: DryRunObservation[] | undefined,
  scenario: EvalScenario,
  label: 'events' | 'records',
): void {
  if (observations === undefined) {
    return;
  }
  if (!Array.isArray(observations)) {
    throw new Error(`Fixture ${scenario.fixture} ${label} must be an array`);
  }
  for (const [index, observation] of observations.entries()) {
    if (
      !observation ||
      typeof observation !== 'object' ||
      Array.isArray(observation)
    ) {
      throw new Error(
        `Fixture ${scenario.fixture} ${label}[${index}] must be an object`,
      );
    }
    if (observation.signals !== undefined) {
      validateSignalList(
        observation.signals,
        `Fixture ${scenario.fixture} ${label}[${index}].signals`,
      );
    }
  }
}

function validateSignalList(
  value: unknown,
  label: string,
): asserts value is string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  for (const signal of value) {
    validateNonEmptyString(signal, `${label}[]`);
  }
}

function deriveObservedSignals(
  fixture: DryRunFixture,
  scenario: EvalScenario,
): ReadonlySet<string> {
  const observedSignals = new Set<string>();
  collectObservationSignals(observedSignals, fixture.events);
  collectObservationSignals(observedSignals, fixture.records);
  for (const reply of Object.values(fixture.agentReplies ?? {})) {
    collectSignalList(observedSignals, reply?.signals);
  }
  if (observedSignals.size === 0) {
    throw new Error(
      `Fixture ${scenario.fixture} did not provide any observation-backed signals`,
    );
  }
  return observedSignals;
}

function collectObservationSignals(
  observedSignals: Set<string>,
  observations: DryRunObservation[] | undefined,
): void {
  for (const observation of observations ?? []) {
    collectSignalList(observedSignals, observation.signals);
  }
}

function collectSignalList(
  observedSignals: Set<string>,
  signals: string[] | undefined,
): void {
  for (const signal of signals ?? []) {
    observedSignals.add(signal);
  }
}

function validateFixtureAgentReplies(
  fixture: DryRunFixture,
  scenario: EvalScenario,
): void {
  if (!scenario.agentExpectations || scenario.agentExpectations.length === 0) {
    return;
  }

  if (!fixture.agentReplies || typeof fixture.agentReplies !== 'object') {
    throw new Error(
      `Fixture ${scenario.fixture} agentReplies must be an object`,
    );
  }

  for (const expectation of scenario.agentExpectations) {
    const agentReply = fixture.agentReplies[expectation.role];
    if (!agentReply || typeof agentReply !== 'object') {
      throw new Error(
        `Fixture ${scenario.fixture} ${expectation.role} agentReply is required`,
      );
    }
    validateNonEmptyString(
      agentReply.reply,
      `Fixture ${scenario.fixture} ${expectation.role} reply`,
    );
    validateNonEmptyString(
      agentReply.roleMethod,
      `Fixture ${scenario.fixture} ${expectation.role} roleMethod`,
    );
    validateNonEmptyString(
      agentReply.tokenBudget,
      `Fixture ${scenario.fixture} ${expectation.role} tokenBudget`,
    );
    if (agentReply.signals !== undefined) {
      validateSignalList(
        agentReply.signals,
        `Fixture ${scenario.fixture} ${expectation.role} signals`,
      );
    }
    if (agentReply.toolManifest !== undefined) {
      if (!Array.isArray(agentReply.toolManifest)) {
        throw new Error(
          `Fixture ${scenario.fixture} ${expectation.role} toolManifest must be an array`,
        );
      }
      for (const tool of agentReply.toolManifest) {
        validateNonEmptyString(
          tool,
          `Fixture ${scenario.fixture} ${expectation.role} toolManifest[]`,
        );
      }
    }
  }
}

function validateUtcTimestamp(value: unknown, label: string): void {
  validateNonEmptyString(value, label);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp`);
  }
}

function evaluateCheck(
  check: EvalCheck,
  observedSignals: ReadonlySet<string>,
  scenarioThreshold: number,
): EvalCheckResult {
  return {
    id: check.id,
    area: check.area,
    description: check.description,
    launchCritical: check.launchCritical,
    ...scoreRequiredSignals(check, observedSignals, scenarioThreshold),
  };
}

function evaluateAgentExpectation(
  scenario: EvalScenario,
  role: DefaultAgentRole,
  dimensions: Record<ScoreDimension, SignalExpectation>,
  observedSignals: ReadonlySet<string>,
  generatedAt: string,
): AgentAuditResult {
  if (!DEFAULT_AGENT_ROLES.includes(role)) {
    throw new Error(`Unknown default agent role: ${role}`);
  }

  const scores = Object.fromEntries(
    SCORE_DIMENSIONS.map((dimension) => {
      const result = scoreRequiredSignals(
        dimensions[dimension],
        observedSignals,
        scenario.threshold,
      );
      return [dimension, result.score];
    }),
  ) as Record<ScoreDimension, number>;

  const flags = SCORE_DIMENSIONS.flatMap((dimension) => {
    const result = scoreRequiredSignals(
      dimensions[dimension],
      observedSignals,
      scenario.threshold,
    );
    return result.passed
      ? []
      : [
          `${dimension}:missing:${result.missingSignals.join('|') || 'no-signals'}`,
        ];
  });

  return {
    runId: `${scenario.id}:dry-run`,
    scenarioId: scenario.id,
    agentRole: role,
    evaluatorVersion: EVALUATOR_VERSION,
    scores,
    flags,
    explanation:
      flags.length === 0
        ? `${role} satisfied all deterministic ${scenario.id} audit signals.`
        : `${role} missed ${flags.length} deterministic audit dimensions.`,
    createdAt: generatedAt,
    passed:
      flags.length === 0 &&
      Object.values(scores).every((score) => score >= scenario.threshold),
  };
}

function buildReport(
  mode: EvalMode,
  generatedAt: string,
  scenarioReports: EvalScenarioReport[],
): EvalReport {
  const failedCriticalCheckCount = scenarioReports
    .flatMap((scenario) => scenario.checkResults)
    .filter((check) => check.launchCritical && !check.passed).length;
  const failedAgentAuditCount = scenarioReports
    .flatMap((scenario) => scenario.agentAudits)
    .filter((audit) => !audit.passed).length;
  const passedScenarioCount = scenarioReports.filter(
    (scenario) => scenario.status === 'pass',
  ).length;
  const status: EvalStatus =
    scenarioReports.length > 0 &&
    passedScenarioCount === scenarioReports.length &&
    failedCriticalCheckCount === 0 &&
    failedAgentAuditCount === 0
      ? 'pass'
      : 'fail';

  return {
    suite: 'clawtalk-mvp-eval',
    evaluatorVersion: EVALUATOR_VERSION,
    mode,
    status,
    generatedAt,
    threshold: DEFAULT_SUITE_THRESHOLD,
    summary: {
      scenarioCount: scenarioReports.length,
      passedScenarioCount,
      checkCount: scenarioReports.flatMap((scenario) => scenario.checkResults)
        .length,
      failedCriticalCheckCount,
      agentAuditCount: scenarioReports.flatMap(
        (scenario) => scenario.agentAudits,
      ).length,
      failedAgentAuditCount,
    },
    scenarios: scenarioReports,
  };
}

function buildBlockedReport(mode: EvalMode, generatedAt: string): EvalReport {
  return {
    suite: 'clawtalk-mvp-eval',
    evaluatorVersion: EVALUATOR_VERSION,
    mode,
    status: 'blocked',
    generatedAt,
    threshold: DEFAULT_SUITE_THRESHOLD,
    summary: {
      scenarioCount: 0,
      passedScenarioCount: 0,
      checkCount: 0,
      failedCriticalCheckCount: 0,
      agentAuditCount: 0,
      failedAgentAuditCount: 0,
    },
    scenarios: [],
    blockedReason:
      'Live eval mode is intentionally not wired in MVP. Use dry-run fixtures locally, then add provider/backend adapters before making live grading launch-blocking.',
  };
}

async function readJson<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

function meanScore(scores: number[]): number {
  if (scores.length === 0) {
    return 0;
  }
  return roundScore(
    scores.reduce((total, score) => total + score, 0) / scores.length,
  );
}

function roundScore(score: number): number {
  return Math.round(score * 100) / 100;
}
