import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildObservation,
  collectRoleReplies,
  fillTemplate,
  parseGraderResponse,
} from './live-capture.js';
import type { EvalScenario, ScoreDimension } from './types.js';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const scenarioPath = path.resolve(
  moduleDirectory,
  '..',
  '..',
  '..',
  'eval',
  'scenarios',
  's-talk-pricing-launch.json',
);

async function loadTalkScenario(): Promise<EvalScenario> {
  return JSON.parse(await readFile(scenarioPath, 'utf8')) as EvalScenario;
}

const ALL_DIMENSIONS: ScoreDimension[] = [
  'roleAdherence',
  'nonDuplication',
  'evidenceDiscipline',
  'methodAdherence',
  'usefulness',
  'concision',
];

function verdicts(passed: boolean) {
  return ALL_DIMENSIONS.map((dimension) => ({
    dimension,
    score: passed ? 5 : 2,
    flags: [],
    explanation: 'test',
    threshold: 4,
    passed,
  }));
}

describe('parseGraderResponse', () => {
  it('parses a bare JSON object', () => {
    expect(
      parseGraderResponse('{"score": 4, "flags": ["x"], "explanation": "ok"}'),
    ).toEqual({ score: 4, flags: ['x'], explanation: 'ok' });
  });

  it('extracts JSON embedded in prose', () => {
    const content =
      'Here is my grading:\n{"score": 3, "flags": [], "explanation": "meh"}\nThanks!';
    expect(parseGraderResponse(content)?.score).toBe(3);
  });

  it('returns null without a numeric score', () => {
    expect(
      parseGraderResponse('{"flags": [], "explanation": "no score"}'),
    ).toBe(null);
    expect(parseGraderResponse('not json at all')).toBe(null);
  });

  it('rejects out-of-range scores instead of clamping them into a pass', () => {
    expect(
      parseGraderResponse('{"score": 6, "flags": [], "explanation": ""}'),
    ).toBe(null);
    expect(
      parseGraderResponse('{"score": 0, "flags": [], "explanation": ""}'),
    ).toBe(null);
    expect(
      parseGraderResponse('{"score": 100, "flags": [], "explanation": ""}'),
    ).toBe(null);
  });

  it('drops non-string flags', () => {
    expect(
      parseGraderResponse('{"score": 5, "flags": ["a", 7], "explanation": ""}')
        ?.flags,
    ).toEqual(['a']);
  });
});

describe('fillTemplate', () => {
  it('replaces known placeholders', () => {
    expect(
      fillTemplate('Role: {agentRole} Budget: {tokenBudget}', {
        agentRole: 'quant',
        tokenBudget: 'tight',
      }),
    ).toBe('Role: quant Budget: tight');
  });

  it('throws on unresolved placeholders so graders never see literal slots', () => {
    expect(() =>
      fillTemplate('Role: {agentRole} Missing: {toolManifest}', {
        agentRole: 'quant',
      }),
    ).toThrow(/unresolved placeholders: toolManifest/);
  });
});

describe('collectRoleReplies', () => {
  it('maps run role_keys to their persisted reply bodies', () => {
    const replies = collectRoleReplies(
      [
        {
          id: 'run-1',
          status: 'completed',
          sequence_index: 0,
          role_key: 'strategist',
          method: ['Thesis first.'],
        },
        {
          id: 'run-2',
          status: 'completed',
          sequence_index: 1,
          role_key: 'critic',
          method: null,
        },
      ],
      [
        { run_id: 'run-1', body: 'thesis text' },
        { run_id: 'run-2', body: 'critique text' },
      ],
    );
    expect(replies).toEqual([
      {
        role: 'strategist',
        runId: 'run-1',
        reply: 'thesis text',
        roleMethod: 'Thesis first.',
      },
      {
        role: 'critic',
        runId: 'run-2',
        reply: 'critique text',
        roleMethod: '',
      },
    ]);
  });
});

describe('buildObservation', () => {
  it('attaches mechanical and passed-dimension semantic signals', async () => {
    const scenario = await loadTalkScenario();
    const runRows = [
      {
        id: 'run-1',
        status: 'completed',
        sequence_index: 0,
        role_key: 'strategist',
        method: [],
      },
    ];
    const messageRows = [{ run_id: 'run-1', body: 'thesis' }];
    const replies = collectRoleReplies(runRows, messageRows);
    const observation = buildObservation({
      scenario,
      runRows,
      messageRows,
      replies,
      verdictsByRole: new Map([['strategist', verdicts(true)]]),
      audits: [
        {
          runId: 'run-1',
          scenarioId: scenario.id,
          agentRole: 'strategist',
          evaluatorVersion: 'live-capture-v1',
          scores: Object.fromEntries(
            ALL_DIMENSIONS.map((dimension) => [dimension, 5]),
          ) as Record<ScoreDimension, number>,
          flags: [],
          explanation: 'test',
          createdAt: new Date().toISOString(),
          passed: true,
        },
      ],
      auditArtifact: 's-talk-pricing-launch.audits.json',
    });

    expect(observation.source).toBe('live');
    const eventSignals = (observation.events ?? []).flatMap(
      (event) => (event.signals as string[] | undefined) ?? [],
    );
    expect(eventSignals).toContain('run.created');
    expect(eventSignals).toContain('run.status.completed');
    const recordSignals = (observation.records ?? []).flatMap(
      (record) => (record.signals as string[] | undefined) ?? [],
    );
    expect(recordSignals).toContain('messages.persisted');
    expect(recordSignals).toContain('audit.agent_results.persisted');

    const strategist = observation.agentReplies?.strategist;
    expect(strategist?.signals).toContain('agent.strategist.reply');
    const expectedSemantic = scenario.agentExpectations?.find(
      (entry) => entry.role === 'strategist',
    )?.dimensions.roleAdherence.requiredSignals[0];
    expect(expectedSemantic).toBeTruthy();
    expect(strategist?.signals).toContain(expectedSemantic);
  });

  it('withholds semantic signals for failed dimensions and incomplete runs', async () => {
    const scenario = await loadTalkScenario();
    const runRows = [
      {
        id: 'run-1',
        status: 'failed',
        sequence_index: 0,
        role_key: 'strategist',
        method: [],
      },
    ];
    const observation = buildObservation({
      scenario,
      runRows,
      messageRows: [],
      replies: [],
      verdictsByRole: new Map([['strategist', verdicts(false)]]),
      audits: [],
      auditArtifact: 's-talk-pricing-launch.audits.json',
    });
    const eventSignals = (observation.events ?? []).flatMap(
      (event) => (event.signals as string[] | undefined) ?? [],
    );
    expect(eventSignals).toContain('run.created');
    expect(eventSignals).not.toContain('run.status.completed');
    const recordSignals = (observation.records ?? []).flatMap(
      (record) => (record.signals as string[] | undefined) ?? [],
    );
    expect(recordSignals).not.toContain('messages.persisted');
    expect(recordSignals).not.toContain('audit.agent_results.persisted');
    expect(observation.agentReplies).toEqual({});
  });
});
