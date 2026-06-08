import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  exitCodeForReport,
  parseScenarioSelection,
  runCli,
  runEvaluation,
  scoreRequiredSignals,
  selectScenarios,
  validateGraderContracts,
} from '../src/clawtalk/eval/harness.js';
import {
  SCORE_DIMENSIONS,
  type EvalScenario,
  type ScoreDimension,
} from '../src/clawtalk/eval/types.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('eval harness scoring', () => {
  it('scores a complete deterministic signal set as 5', () => {
    const result = scoreRequiredSignals(
      { requiredSignals: ['run.created', 'run.completed'] },
      new Set(['run.created', 'run.completed']),
    );

    expect(result).toMatchObject({
      score: 5,
      missingSignals: [],
      passed: true,
    });
  });

  it('fails partial signal coverage below the default launch threshold', () => {
    const result = scoreRequiredSignals(
      { requiredSignals: ['edit.pending', 'edit.accepted'] },
      new Set(['edit.pending']),
    );

    expect(result.score).toBe(3);
    expect(result.missingSignals).toEqual(['edit.accepted']);
    expect(result.passed).toBe(false);
  });

  it('fails when any required signal is missing even if the numeric score reaches 4', () => {
    const result = scoreRequiredSignals(
      { requiredSignals: ['a', 'b', 'c', 'd'] },
      new Set(['a', 'b', 'c']),
    );

    expect(result.score).toBe(4);
    expect(result.missingSignals).toEqual(['d']);
    expect(result.passed).toBe(false);
  });

  it('rejects empty requiredSignals instead of auto-passing', () => {
    expect(() =>
      scoreRequiredSignals({ requiredSignals: [] }, new Set()),
    ).toThrow(/requiredSignals must not be empty/);
  });
});

describe('eval scenario selection', () => {
  const scenarios: EvalScenario[] = [
    {
      id: 's-one',
      title: 'One',
      description: 'One',
      category: 'talk',
      team: 'default',
      mode: 'ordered',
      roundsLimit: 1,
      userPrompt: 'Prompt',
      expectedDynamics: 'Dynamics',
      threshold: 4,
      fixture: 'one.fixture.json',
      checks: [],
    },
  ];

  it('rejects unknown scenario ids before running', () => {
    expect(() => selectScenarios(scenarios, ['missing'])).toThrow(
      /Unknown eval scenario/,
    );
  });

  it('rejects empty all-scenario selections', () => {
    expect(() => selectScenarios([], 'all')).toThrow(/No eval scenarios/);
  });

  it('rejects explicitly empty scenario filters instead of falling back to all', () => {
    const selection = parseScenarioSelection('');

    expect(selection).toEqual([]);
    expect(() => selectScenarios(scenarios, selection)).toThrow(
      /No eval scenarios selected/,
    );
  });
});

describe('grader contracts', () => {
  it('loads one valid grader contract per score dimension', async () => {
    const graders = await validateGraderContracts();

    expect(graders).toHaveLength(6);
    expect(graders.map((grader) => grader.dimension).sort()).toEqual([
      'concision',
      'evidenceDiscipline',
      'methodAdherence',
      'nonDuplication',
      'roleAdherence',
      'usefulness',
    ]);
  });

  it('rejects malformed numeric grader thresholds before accepting contracts', async () => {
    const graderRoot = await writeGraderContracts({
      concision: { thresholdDefault: '4' },
    });

    await expect(validateGraderContracts(graderRoot)).rejects.toThrow(
      /thresholdDefault must be a finite number from 1 to 5/,
    );
  });

  it('rejects grader files whose dimension does not match the filename', async () => {
    const graderRoot = await writeGraderContracts({
      roleAdherence: { dimension: 'concision' },
    });

    await expect(validateGraderContracts(graderRoot)).rejects.toThrow(
      /roleAdherence contract dimension must match its filename/,
    );
  });
});

describe('dry-run suite', () => {
  it('passes all launch-critical fixture scenarios', async () => {
    const report = await runEvaluation({
      mode: 'dry-run',
      scenarioIds: 'all',
      generatedAt: '2026-06-07T00:00:00.000Z',
    });

    expect(report.status).toBe('pass');
    expect(report.summary.scenarioCount).toBe(6);
    expect(report.summary.failedCriticalCheckCount).toBe(0);
    expect(report.summary.failedAgentAuditCount).toBe(0);
    expect(exitCodeForReport(report)).toBe(0);

    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(runCli([])).resolves.toBe(0);
  });

  it('fails the suite when a launch-critical deterministic signal is missing', async () => {
    const roots = await writeFailingEvalFixture();
    const report = await runEvaluation({
      mode: 'dry-run',
      scenarioIds: 'all',
      generatedAt: '2026-06-07T00:00:00.000Z',
      scenarioRoot: roots.scenarioRoot,
      fixtureRoot: roots.fixtureRoot,
    });

    expect(report.status).toBe('fail');
    expect(report.summary.scenarioCount).toBe(1);
    expect(report.summary.failedCriticalCheckCount).toBe(1);
    expect(report.scenarios[0]?.checkResults[0]?.missingSignals).toEqual([
      'missing.signal',
    ]);
    expect(exitCodeForReport(report)).toBe(1);
  });

  it('fails the suite when a non-critical deterministic check is missing', async () => {
    const roots = await writeSoftFailEvalFixture();
    const report = await runEvaluation({
      mode: 'dry-run',
      scenarioIds: 'all',
      generatedAt: '2026-06-07T00:00:00.000Z',
      scenarioRoot: roots.scenarioRoot,
      fixtureRoot: roots.fixtureRoot,
    });

    expect(report.status).toBe('fail');
    expect(report.summary.failedCriticalCheckCount).toBe(0);
    expect(
      report.scenarios[0]?.checkResults.map((check) => check.passed),
    ).toEqual([true, false]);
    expect(exitCodeForReport(report)).toBe(1);
  });

  it('returns exit 2 for intentionally blocked live mode', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      runEvaluation({ mode: 'live', scenarioIds: 'all' }),
    ).resolves.toMatchObject({
      status: 'blocked',
    });
    await expect(runCli(['--mode=live'])).resolves.toBe(2);
  });

  it('rejects malformed scenario contracts before scoring', async () => {
    const roots = await writeInvalidEvalFixture();

    await expect(
      runEvaluation({
        mode: 'dry-run',
        scenarioIds: 'all',
        generatedAt: '2026-06-07T00:00:00.000Z',
        scenarioRoot: roots.scenarioRoot,
        fixtureRoot: roots.fixtureRoot,
      }),
    ).rejects.toThrow(/threshold must be a finite number from 1 to 5/);
  });

  it('rejects malformed scenario runtime fields before scoring', async () => {
    const roots = await writeInvalidRuntimeFieldEvalFixture();

    await expect(
      runEvaluation({
        mode: 'dry-run',
        scenarioIds: 'all',
        generatedAt: '2026-06-07T00:00:00.000Z',
        scenarioRoot: roots.scenarioRoot,
        fixtureRoot: roots.fixtureRoot,
      }),
    ).rejects.toThrow(/category must be one of/);
  });

  it('rejects malformed dry-run fixture runtime fields before scoring', async () => {
    const roots = await writeInvalidDryRunFixture({
      source: 'not-fixture',
      observedAt: 'not-a-date',
    });

    await expect(
      runEvaluation({
        mode: 'dry-run',
        scenarioIds: 'all',
        generatedAt: '2026-06-07T00:00:00.000Z',
        scenarioRoot: roots.scenarioRoot,
        fixtureRoot: roots.fixtureRoot,
      }),
    ).rejects.toThrow(/observedAt must be an ISO-8601 UTC timestamp/);
  });

  it('rejects legacy top-level fixture signals before scoring', async () => {
    const roots = await writeInvalidDryRunFixture({
      signals: ['critical.present'],
    });

    await expect(
      runEvaluation({
        mode: 'dry-run',
        scenarioIds: 'all',
        generatedAt: '2026-06-07T00:00:00.000Z',
        scenarioRoot: roots.scenarioRoot,
        fixtureRoot: roots.fixtureRoot,
      }),
    ).rejects.toThrow(
      /must attach signals to events, records, or agentReplies/,
    );
  });

  it('rejects malformed dry-run fixture signals before scoring', async () => {
    const roots = await writeInvalidDryRunFixture({
      events: [{ kind: 'fixture.signal', signals: ['critical.present', ''] }],
    });

    await expect(
      runEvaluation({
        mode: 'dry-run',
        scenarioIds: 'all',
        generatedAt: '2026-06-07T00:00:00.000Z',
        scenarioRoot: roots.scenarioRoot,
        fixtureRoot: roots.fixtureRoot,
      }),
    ).rejects.toThrow(/events\[0\]\.signals\[\] must be a non-empty string/);
  });

  it('rejects agent audit scenarios without grader fixture inputs', async () => {
    const roots = await writeInvalidAgentReplyFixture();

    await expect(
      runEvaluation({
        mode: 'dry-run',
        scenarioIds: 'all',
        generatedAt: '2026-06-07T00:00:00.000Z',
        scenarioRoot: roots.scenarioRoot,
        fixtureRoot: roots.fixtureRoot,
      }),
    ).rejects.toThrow(/agentReplies must be an object/);
  });
});

async function writeGraderContracts(
  overrides: Partial<Record<ScoreDimension, Record<string, unknown>>> = {},
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'clawtalk-eval-graders-'));

  for (const dimension of SCORE_DIMENSIONS) {
    await writeJson(path.join(root, `${dimension}.json`), {
      dimension,
      scale: 'numeric_1_to_5',
      thresholdDefault: 4,
      outputSchema: {
        score: 'number',
        flags: 'string[]',
        explanation: 'string',
      },
      systemPrompt: `Grade ${dimension}.`,
      userTemplate:
        'Agent role: {agentRole}\nAgent reply:\n{agentReply}\nFull transcript:\n{talkTranscript}',
      ...overrides[dimension],
    });
  }

  return root;
}

async function writeFailingEvalFixture(): Promise<{
  scenarioRoot: string;
  fixtureRoot: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'clawtalk-eval-test-'));
  const scenarioRoot = path.join(root, 'scenarios');
  const fixtureRoot = path.join(root, 'fixtures');
  await mkdir(scenarioRoot);
  await mkdir(fixtureRoot);

  const scenario: EvalScenario = {
    id: 's-failing-signal',
    title: 'Failing signal',
    description: 'A temporary scenario with one missing signal.',
    category: 'talk',
    team: 'default',
    mode: 'ordered',
    roundsLimit: 1,
    userPrompt: 'Prompt',
    expectedDynamics: 'Dynamics',
    threshold: 4,
    fixture: 's-failing-signal.fixture.json',
    checks: [
      {
        id: 'critical-signal-check',
        area: 'talk',
        description: 'Requires a deterministic signal that is absent.',
        launchCritical: true,
        requiredSignals: ['present.signal', 'missing.signal'],
      },
    ],
  };

  await writeJson(path.join(scenarioRoot, 's-failing-signal.json'), scenario);
  await writeJson(path.join(fixtureRoot, scenario.fixture), {
    scenarioId: scenario.id,
    observedAt: '2026-06-07T00:00:00.000Z',
    source: 'fixture',
    events: [{ kind: 'fixture.signal', signals: ['present.signal'] }],
  });

  return { scenarioRoot, fixtureRoot };
}

async function writeSoftFailEvalFixture(): Promise<{
  scenarioRoot: string;
  fixtureRoot: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'clawtalk-eval-test-'));
  const scenarioRoot = path.join(root, 'scenarios');
  const fixtureRoot = path.join(root, 'fixtures');
  await mkdir(scenarioRoot);
  await mkdir(fixtureRoot);

  const scenario: EvalScenario = {
    id: 's-soft-failing-signal',
    title: 'Soft failing signal',
    description: 'A temporary scenario with a missing non-critical signal.',
    category: 'talk',
    team: 'default',
    mode: 'ordered',
    roundsLimit: 1,
    userPrompt: 'Prompt',
    expectedDynamics: 'Dynamics',
    threshold: 4,
    fixture: 's-soft-failing-signal.fixture.json',
    checks: [
      {
        id: 'critical-signal-check',
        area: 'talk',
        description: 'A passing critical signal.',
        launchCritical: true,
        requiredSignals: ['critical.present'],
      },
      {
        id: 'soft-signal-check',
        area: 'talk',
        description: 'A non-critical signal that must still fail the gate.',
        launchCritical: false,
        requiredSignals: ['soft.present', 'soft.missing'],
      },
    ],
  };

  await writeJson(
    path.join(scenarioRoot, 's-soft-failing-signal.json'),
    scenario,
  );
  await writeJson(path.join(fixtureRoot, scenario.fixture), {
    scenarioId: scenario.id,
    observedAt: '2026-06-07T00:00:00.000Z',
    source: 'fixture',
    events: [
      { kind: 'fixture.signal', signals: ['critical.present', 'soft.present'] },
    ],
  });

  return { scenarioRoot, fixtureRoot };
}

async function writeInvalidEvalFixture(): Promise<{
  scenarioRoot: string;
  fixtureRoot: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'clawtalk-eval-test-'));
  const scenarioRoot = path.join(root, 'scenarios');
  const fixtureRoot = path.join(root, 'fixtures');
  await mkdir(scenarioRoot);
  await mkdir(fixtureRoot);

  const scenario: EvalScenario = {
    id: 's-invalid',
    title: 'Invalid',
    description: 'A temporary invalid scenario.',
    category: 'talk',
    team: 'default',
    mode: 'ordered',
    roundsLimit: 1,
    userPrompt: 'Prompt',
    expectedDynamics: 'Dynamics',
    threshold: 0,
    fixture: 's-invalid.fixture.json',
    checks: [],
  };

  await writeJson(path.join(scenarioRoot, 's-invalid.json'), scenario);
  await writeJson(path.join(fixtureRoot, scenario.fixture), {
    scenarioId: scenario.id,
    observedAt: '2026-06-07T00:00:00.000Z',
    source: 'fixture',
    events: [],
  });

  return { scenarioRoot, fixtureRoot };
}

async function writeInvalidRuntimeFieldEvalFixture(): Promise<{
  scenarioRoot: string;
  fixtureRoot: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'clawtalk-eval-test-'));
  const scenarioRoot = path.join(root, 'scenarios');
  const fixtureRoot = path.join(root, 'fixtures');
  await mkdir(scenarioRoot);
  await mkdir(fixtureRoot);

  const scenario = {
    id: 's-invalid-runtime-field',
    title: 'Invalid runtime field',
    description: 'A temporary scenario with invalid runtime fields.',
    category: 'not-a-category',
    team: 'default',
    mode: 'sideways',
    roundsLimit: 'many',
    userPrompt: 'Prompt',
    expectedDynamics: 'Dynamics',
    threshold: 4,
    fixture: 's-invalid-runtime-field.fixture.json',
    checks: [
      {
        id: 'critical-signal-check',
        area: 'talk',
        description: 'A passing critical signal.',
        launchCritical: true,
        requiredSignals: ['critical.present'],
      },
    ],
  };

  await writeJson(
    path.join(scenarioRoot, 's-invalid-runtime-field.json'),
    scenario,
  );
  await writeJson(path.join(fixtureRoot, scenario.fixture), {
    scenarioId: scenario.id,
    observedAt: '2026-06-07T00:00:00.000Z',
    source: 'fixture',
    events: [{ kind: 'fixture.signal', signals: ['critical.present'] }],
  });

  return { scenarioRoot, fixtureRoot };
}

async function writeInvalidDryRunFixture(
  fixtureOverrides: Record<string, unknown>,
): Promise<{
  scenarioRoot: string;
  fixtureRoot: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'clawtalk-eval-test-'));
  const scenarioRoot = path.join(root, 'scenarios');
  const fixtureRoot = path.join(root, 'fixtures');
  await mkdir(scenarioRoot);
  await mkdir(fixtureRoot);

  const scenario: EvalScenario = {
    id: 's-invalid-fixture',
    title: 'Invalid fixture',
    description: 'A temporary scenario with invalid fixture fields.',
    category: 'talk',
    team: 'default',
    mode: 'ordered',
    roundsLimit: 1,
    userPrompt: 'Prompt',
    expectedDynamics: 'Dynamics',
    threshold: 4,
    fixture: 's-invalid-fixture.fixture.json',
    checks: [
      {
        id: 'critical-signal-check',
        area: 'talk',
        description: 'A passing critical signal.',
        launchCritical: true,
        requiredSignals: ['critical.present'],
      },
    ],
  };

  await writeJson(path.join(scenarioRoot, 's-invalid-fixture.json'), scenario);
  await writeJson(path.join(fixtureRoot, scenario.fixture), {
    scenarioId: scenario.id,
    observedAt: '2026-06-07T00:00:00.000Z',
    source: 'fixture',
    events: [{ kind: 'fixture.signal', signals: ['critical.present'] }],
    ...fixtureOverrides,
  });

  return { scenarioRoot, fixtureRoot };
}

async function writeInvalidAgentReplyFixture(): Promise<{
  scenarioRoot: string;
  fixtureRoot: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'clawtalk-eval-test-'));
  const scenarioRoot = path.join(root, 'scenarios');
  const fixtureRoot = path.join(root, 'fixtures');
  await mkdir(scenarioRoot);
  await mkdir(fixtureRoot);

  const scenario: EvalScenario = {
    id: 's-invalid-agent-reply',
    title: 'Invalid agent reply',
    description: 'A temporary scenario with missing grader fixture inputs.',
    category: 'talk',
    team: 'default',
    mode: 'ordered',
    roundsLimit: 1,
    userPrompt: 'Prompt',
    expectedDynamics: 'Dynamics',
    threshold: 4,
    fixture: 's-invalid-agent-reply.fixture.json',
    checks: [
      {
        id: 'critical-signal-check',
        area: 'talk',
        description: 'A passing critical signal.',
        launchCritical: true,
        requiredSignals: ['critical.present'],
      },
    ],
    agentExpectations: [
      {
        role: 'strategist',
        dimensions: Object.fromEntries(
          SCORE_DIMENSIONS.map((dimension) => [
            dimension,
            { requiredSignals: [`strategist.${dimension}.present`] },
          ]),
        ) as Record<ScoreDimension, { requiredSignals: string[] }>,
      },
    ],
  };

  await writeJson(
    path.join(scenarioRoot, 's-invalid-agent-reply.json'),
    scenario,
  );
  await writeJson(path.join(fixtureRoot, scenario.fixture), {
    scenarioId: scenario.id,
    observedAt: '2026-06-07T00:00:00.000Z',
    source: 'fixture',
    events: [{ kind: 'fixture.signal', signals: ['critical.present'] }],
  });

  return { scenarioRoot, fixtureRoot };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
