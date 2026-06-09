export const SCORE_DIMENSIONS = [
  'roleAdherence',
  'nonDuplication',
  'evidenceDiscipline',
  'methodAdherence',
  'usefulness',
  'concision',
] as const;

export const DEFAULT_AGENT_ROLES = [
  'strategist',
  'critic',
  'researcher',
  'editor',
  'quant',
] as const;

export const EVAL_SCENARIO_CATEGORIES = [
  'talk',
  'documents',
  'jobs',
  'home',
  'permissions',
] as const;

export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];
export type DefaultAgentRole = (typeof DEFAULT_AGENT_ROLES)[number];
export type EvalMode = 'dry-run' | 'live';
export type EvalStatus = 'pass' | 'fail' | 'blocked';
export type EvalScenarioCategory = (typeof EVAL_SCENARIO_CATEGORIES)[number];
export type EvalObservationSource = 'fixture' | 'live';

export interface SignalExpectation {
  requiredSignals: string[];
  threshold?: number;
  notes?: string;
}

export interface EvalCheck extends SignalExpectation {
  id: string;
  area: EvalScenarioCategory | string;
  description: string;
  launchCritical: boolean;
}

export interface AgentExpectation {
  role: DefaultAgentRole;
  dimensions: Record<ScoreDimension, SignalExpectation>;
}

export interface EvalScenario {
  id: string;
  title: string;
  description: string;
  category: EvalScenarioCategory;
  team: 'default' | string;
  mode: 'ordered' | 'parallel';
  roundsLimit: number;
  userPrompt: string;
  expectedDynamics: string;
  threshold: number;
  fixture: string;
  checks: EvalCheck[];
  agentExpectations?: AgentExpectation[];
}

export interface DryRunObservation {
  signals?: string[];
  [key: string]: unknown;
}

export interface EvalObservationFixture {
  scenarioId: string;
  observedAt: string;
  source: EvalObservationSource;
  transcript?: string[];
  agentReplies?: Partial<
    Record<
      DefaultAgentRole,
      {
        reply: string;
        roleMethod: string;
        tokenBudget: string;
        toolManifest?: string[];
        signals?: string[];
      }
    >
  >;
  events?: DryRunObservation[];
  records?: DryRunObservation[];
}

export interface GraderPrompt {
  dimension: ScoreDimension;
  scale: 'numeric_1_to_5';
  thresholdDefault: number;
  systemPrompt: string;
  userTemplate: string;
  outputSchema: {
    score: 'number';
    flags: 'string[]';
    explanation: 'string';
  };
}

export interface SignalScore {
  score: number;
  matchedSignals: string[];
  missingSignals: string[];
  threshold: number;
  passed: boolean;
}

export interface EvalCheckResult extends SignalScore {
  id: string;
  area: string;
  description: string;
  launchCritical: boolean;
}

export interface AgentAuditResult {
  runId: string;
  scenarioId: string;
  agentRole: DefaultAgentRole;
  evaluatorVersion: string;
  scores: Record<ScoreDimension, number>;
  flags: string[];
  explanation: string;
  createdAt: string;
  passed: boolean;
}

export interface EvalScenarioReport {
  id: string;
  title: string;
  category: EvalScenarioCategory;
  status: EvalStatus;
  threshold: number;
  meanScore: number;
  checkResults: EvalCheckResult[];
  agentAudits: AgentAuditResult[];
  blockedReason?: string;
}

export interface EvalReport {
  suite: 'clawtalk-mvp-eval';
  evaluatorVersion: string;
  mode: EvalMode;
  status: EvalStatus;
  generatedAt: string;
  threshold: number;
  summary: {
    scenarioCount: number;
    passedScenarioCount: number;
    checkCount: number;
    failedCriticalCheckCount: number;
    agentAuditCount: number;
    failedAgentAuditCount: number;
  };
  scenarios: EvalScenarioReport[];
  blockedReason?: string;
}
