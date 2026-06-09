import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {
  createTalkJob,
  deleteTalkJob,
  getTalkJob,
  getTalkTools,
  listTalkJobRuns,
  listTalkJobs,
  patchTalkJob,
  pauseTalkJob,
  resumeTalkJob,
  runTalkJobNow,
  UnauthorizedError,
  type TalkJob,
  type TalkJobRunSummary,
  type TalkJobSchedule,
  type TalkJobScope,
  type TalkJobWeekday,
  type TalkToolsState,
} from '../lib/api';

export type TalkJobDraft = {
  title: string;
  prompt: string;
  targetAgentId: string;
  scheduleKind: TalkJobSchedule['kind'];
  everyHours: number;
  weekdays: TalkJobWeekday[];
  hour: number;
  minute: number;
  timezone: string;
  toolIds: string[];
  allowWeb: boolean;
};

// Page-owned status (idle/loading/saving/error/success). It is intentionally
// owned by TalkDetailPage and threaded in as a prop: this panel unmounts on
// every tab switch, and the 'saving' lockout must survive the remount so a
// late mutation response can't re-enable controls and allow a double-submit.
export type TalkJobsStatusState = {
  status: 'idle' | 'loading' | 'saving' | 'error' | 'success';
  message?: string;
};

// Load status for the read-only run-history fetch (and the self-fetched tool
// scope). No 'saving' — mutations drive the page-owned TalkJobsStatusState.
export type JobLoadStatus = {
  status: 'idle' | 'loading' | 'error';
  message?: string;
};

// Pre-built on the page (which owns `buildAgentLabel` + the agent roster) so
// this panel needs neither the TalkAgent type nor the label helper.
export type JobAgentOption = {
  id: string;
  label: string;
  isPrimary: boolean;
};

const JOB_WEEKDAY_ORDER: TalkJobWeekday[] = [
  'sun',
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
];

const JOB_WEEKDAY_LABELS: Record<TalkJobWeekday, string> = {
  sun: 'Sun',
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
};

const JOB_TOOL_SCOPE_OPTIONS: ReadonlyArray<{
  toolId: string;
  family: string;
  label: string;
}> = [
  { toolId: 'gdrive-read', family: 'google_read', label: 'Google Drive read' },
  { toolId: 'linear', family: 'connectors', label: 'Linear' },
  { toolId: 'github-read', family: 'connectors', label: 'GitHub read' },
  { toolId: 'notion-read', family: 'connectors', label: 'Notion read' },
];

const JOB_TOOL_LABEL_BY_ID = new Map(
  JOB_TOOL_SCOPE_OPTIONS.map((option) => [option.toolId, option.label]),
);

// Trivial pure formatter, kept local to keep this slice surgical (TalkDetailPage
// keeps its own copy for the Runs tab; promote to a shared util if a third
// caller appears).
function formatDateTime(value: string | null): string {
  if (!value) return 'Never';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return value;
  return parsed.toLocaleString();
}

function getDefaultJobTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function buildDefaultJobDraft(input?: {
  targetAgentId?: string;
  timezone?: string;
}): TalkJobDraft {
  return {
    title: '',
    prompt: '',
    targetAgentId: input?.targetAgentId ?? '',
    scheduleKind: 'weekly',
    everyHours: 24,
    weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'],
    hour: 9,
    minute: 0,
    timezone: input?.timezone ?? getDefaultJobTimezone(),
    toolIds: [],
    allowWeb: false,
  };
}

function buildJobDraftFromJob(job: TalkJob): TalkJobDraft {
  const clock =
    job.schedule.kind === 'hourly_interval'
      ? { hour: 9, minute: 0 }
      : { hour: job.schedule.hour, minute: job.schedule.minute };
  return {
    title: job.title,
    prompt: job.prompt,
    targetAgentId: job.targetAgentId ?? '',
    scheduleKind: job.schedule.kind,
    everyHours:
      job.schedule.kind === 'hourly_interval' ? job.schedule.everyHours : 24,
    weekdays:
      job.schedule.kind === 'weekly'
        ? [...job.schedule.weekdays]
        : ['mon', 'tue', 'wed', 'thu', 'fri'],
    hour: clock.hour,
    minute: clock.minute,
    timezone: job.timezone,
    toolIds: [...job.sourceScope.toolIds],
    allowWeb: job.sourceScope.allowWeb,
  };
}

function draftToTalkJobSchedule(draft: TalkJobDraft): TalkJobSchedule {
  if (draft.scheduleKind === 'hourly_interval') {
    return {
      kind: 'hourly_interval',
      everyHours: Math.max(1, Math.min(24, Math.trunc(draft.everyHours || 1))),
    };
  }
  if (draft.scheduleKind === 'daily') {
    return {
      kind: 'daily',
      hour: Math.max(0, Math.min(23, Math.trunc(draft.hour || 0))),
      minute: Math.max(0, Math.min(59, Math.trunc(draft.minute || 0))),
    };
  }
  return {
    kind: 'weekly',
    weekdays:
      draft.weekdays.length > 0
        ? draft.weekdays
        : ['mon', 'tue', 'wed', 'thu', 'fri'],
    hour: Math.max(0, Math.min(23, Math.trunc(draft.hour || 0))),
    minute: Math.max(0, Math.min(59, Math.trunc(draft.minute || 0))),
  };
}

function draftToTalkJobScope(draft: TalkJobDraft): TalkJobScope {
  return {
    toolIds: [...draft.toolIds],
    allowWeb: draft.allowWeb,
  };
}

function formatTalkJobSchedule(schedule: TalkJobSchedule): string {
  if (schedule.kind === 'hourly_interval') {
    return `Every ${schedule.everyHours} hour${schedule.everyHours === 1 ? '' : 's'}`;
  }
  if (schedule.kind === 'daily') {
    return `Daily at ${String(schedule.hour).padStart(2, '0')}:${String(
      schedule.minute,
    ).padStart(2, '0')}`;
  }
  const days = schedule.weekdays
    .map((day) => JOB_WEEKDAY_LABELS[day])
    .join(', ');
  return `${days} at ${String(schedule.hour).padStart(2, '0')}:${String(
    schedule.minute,
  ).padStart(2, '0')}`;
}

function formatJobToolId(toolId: string): string {
  return (
    JOB_TOOL_LABEL_BY_ID.get(toolId) ||
    toolId
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join(' ')
  );
}

function summarizeTalkJobScope(scope: TalkJobScope): string {
  const parts: string[] = [];
  if (scope.allowWeb) {
    parts.push('web access');
  }
  if (scope.toolIds.length > 0) {
    parts.push(scope.toolIds.map(formatJobToolId).join(', '));
  }
  return parts.length > 0 ? parts.join(' · ') : 'Default Talk context only.';
}

type TalkJobsPanelProps = {
  talkId: string;
  canEditJobs: boolean;
  agentOptions: JobAgentOption[];
  // This panel is presentational (cf. TalkContextPanel): every piece of Jobs
  // state that an async mutation writes — the list, the selection, the draft,
  // its runs, and the mutation status — is PAGE-owned and threaded in, because
  // the panel unmounts on every tab switch. A save/delete/pause/run that
  // resolves after unmount must still update the live page state (not an
  // orphaned panel-local copy), and the half-filled form must survive the
  // round-trip. The panel reads these and mutates them through the setters.
  // (Only the read-only job tool scope is self-fetched — it is never mutated.)
  jobDraft: TalkJobDraft;
  setJobDraft: Dispatch<SetStateAction<TalkJobDraft>>;
  creatingJob: boolean;
  setCreatingJob: Dispatch<SetStateAction<boolean>>;
  selectedJobId: string | null;
  setSelectedJobId: Dispatch<SetStateAction<string | null>>;
  talkJobs: TalkJob[];
  setTalkJobs: Dispatch<SetStateAction<TalkJob[]>>;
  talkJobsLoaded: boolean;
  setTalkJobsLoaded: Dispatch<SetStateAction<boolean>>;
  selectedJobRuns: TalkJobRunSummary[];
  setSelectedJobRuns: Dispatch<SetStateAction<TalkJobRunSummary[]>>;
  selectedJobRunsStatus: JobLoadStatus;
  setSelectedJobRunsStatus: Dispatch<SetStateAction<JobLoadStatus>>;
  status: TalkJobsStatusState;
  setStatus: Dispatch<SetStateAction<TalkJobsStatusState>>;
  onUnauthorized: () => void;
  // After a Run-Now settles, the page resyncs Talk timeline/runs.
  onJobRunSettled: () => void | Promise<void>;
};

export function TalkJobsPanel({
  talkId,
  canEditJobs,
  agentOptions,
  jobDraft,
  setJobDraft,
  creatingJob,
  setCreatingJob,
  selectedJobId,
  setSelectedJobId,
  talkJobs,
  setTalkJobs,
  talkJobsLoaded,
  setTalkJobsLoaded,
  selectedJobRuns,
  setSelectedJobRuns,
  selectedJobRunsStatus,
  setSelectedJobRunsStatus,
  status,
  setStatus,
  onUnauthorized,
  onJobRunSettled,
}: TalkJobsPanelProps): JSX.Element {
  // Self-fetched, read-only job tool scope (cf. TalkToolsPanel): never written
  // by a mutation, so it is safe to lose on unmount and re-fetch on remount.
  const [jobToolsState, setJobToolsState] = useState<TalkToolsState | null>(
    null,
  );
  const [jobToolsLoaded, setJobToolsLoaded] = useState(false);
  const [jobToolsStatus, setJobToolsStatus] = useState<JobLoadStatus>({
    status: 'idle',
  });

  const defaultAgentId = useMemo(
    () =>
      agentOptions.find((agent) => agent.isPrimary)?.id || agentOptions[0]?.id,
    [agentOptions],
  );

  const jobToolOptions = useMemo(
    () =>
      JOB_TOOL_SCOPE_OPTIONS.filter(
        (option) => jobToolsState?.available.includes(option.family) !== false,
      ),
    [jobToolsState],
  );
  const jobToolFamilyEnabled = useCallback(
    (family: string): boolean => jobToolsState?.active[family] === true,
    [jobToolsState],
  );
  const jobWebEnabled = jobToolFamilyEnabled('web');

  const selectedJob = useMemo(
    () => talkJobs.find((job) => job.id === selectedJobId) ?? null,
    [selectedJobId, talkJobs],
  );
  const hasUnsavedJobChanges = useMemo(() => {
    if (creatingJob) {
      return Boolean(jobDraft.title.trim() || jobDraft.prompt.trim());
    }
    if (!selectedJob) return false;
    const original = buildJobDraftFromJob(selectedJob);
    return JSON.stringify(original) !== JSON.stringify(jobDraft);
  }, [creatingJob, jobDraft, selectedJob]);

  const loadSelectedJobRuns = useCallback(
    async (jobId: string, options?: { showLoading?: boolean }) => {
      if (options?.showLoading) {
        setSelectedJobRunsStatus({ status: 'loading' });
      }
      const runs = await listTalkJobRuns({ talkId, jobId, limit: 20 });
      setSelectedJobRuns(runs);
      setSelectedJobRunsStatus({ status: 'idle' });
      return runs;
    },
    [talkId],
  );

  const refreshTalkJobs = useCallback(
    async (options?: {
      showLoading?: boolean;
      preserveSelection?: boolean;
      preferredJobId?: string | null;
    }) => {
      if (options?.showLoading) {
        setStatus({ status: 'loading' });
      }
      const jobs = await listTalkJobs(talkId);
      setTalkJobs(jobs);
      setTalkJobsLoaded(true);
      setStatus({ status: 'idle' });

      const nextSelectedId =
        (options?.preferredJobId &&
          jobs.some((job) => job.id === options.preferredJobId) &&
          options.preferredJobId) ||
        (options?.preserveSelection &&
          selectedJobId &&
          jobs.some((job) => job.id === selectedJobId) &&
          selectedJobId) ||
        jobs[0]?.id ||
        null;

      if (!nextSelectedId) {
        setSelectedJobId(null);
        setCreatingJob(false);
        setJobDraft(buildDefaultJobDraft({ targetAgentId: defaultAgentId }));
        setSelectedJobRuns([]);
        setSelectedJobRunsStatus({ status: 'idle' });
        return jobs;
      }

      const job = jobs.find((candidate) => candidate.id === nextSelectedId);
      if (!job) {
        return jobs;
      }

      setCreatingJob(false);
      setSelectedJobId(job.id);
      setJobDraft(buildJobDraftFromJob(job));
      await loadSelectedJobRuns(job.id, { showLoading: false });
      return jobs;
    },
    [
      defaultAgentId,
      loadSelectedJobRuns,
      selectedJobId,
      setCreatingJob,
      setJobDraft,
      setSelectedJobId,
      setSelectedJobRuns,
      setSelectedJobRunsStatus,
      setStatus,
      setTalkJobs,
      setTalkJobsLoaded,
      talkId,
    ],
  );

  const refreshJobTools = useCallback(
    async (options?: { showLoading?: boolean }) => {
      if (options?.showLoading) {
        setJobToolsStatus({ status: 'loading' });
      }
      try {
        const tools = await getTalkTools(talkId);
        setJobToolsState(tools);
        setJobToolsLoaded(true);
        setJobToolsStatus({ status: 'idle' });
        return tools;
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return null;
        }
        setJobToolsStatus({
          status: 'error',
          message:
            err instanceof Error ? err.message : 'Failed to load job tools.',
        });
        return null;
      }
    },
    [onUnauthorized, talkId],
  );

  const refreshSelectedJobExecutionState = useCallback(
    async (jobId: string) => {
      const [job, runs] = await Promise.all([
        getTalkJob({ talkId, jobId }),
        listTalkJobRuns({ talkId, jobId, limit: 20 }),
      ]);
      setTalkJobs((current) =>
        current.map((candidate) => (candidate.id === job.id ? job : candidate)),
      );
      if (selectedJobId === job.id) {
        setSelectedJobId(job.id);
        setJobDraft(buildJobDraftFromJob(job));
        setSelectedJobRuns(runs);
      }
      setSelectedJobRunsStatus({ status: 'idle' });
      return { job, runs };
    },
    [
      selectedJobId,
      setJobDraft,
      setSelectedJobId,
      setSelectedJobRuns,
      setSelectedJobRunsStatus,
      setTalkJobs,
      talkId,
    ],
  );

  // Load jobs + tool scope on first open. talkJobsLoaded is page-owned, so on a
  // tab-switch remount the list / selection / draft / runs persist and are NOT
  // re-fetched (no remount divergence); only the self-fetched tool scope — whose
  // panel-owned loaded flag resets on unmount — is re-fetched.
  useEffect(() => {
    if (!talkJobsLoaded) {
      void refreshTalkJobs({ showLoading: true }).catch((err) => {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setStatus({
          status: 'error',
          message: err instanceof Error ? err.message : 'Failed to load jobs.',
        });
      });
    }
    if (!jobToolsLoaded) {
      void refreshJobTools({ showLoading: true });
    }
  }, [
    jobToolsLoaded,
    onUnauthorized,
    refreshJobTools,
    refreshTalkJobs,
    setStatus,
    talkJobsLoaded,
  ]);

  const handleCreateJobDraft = useCallback(() => {
    setCreatingJob(true);
    setSelectedJobId(null);
    setSelectedJobRuns([]);
    setSelectedJobRunsStatus({ status: 'idle' });
    setStatus({ status: 'idle' });
    setJobDraft(buildDefaultJobDraft({ targetAgentId: defaultAgentId }));
  }, [
    defaultAgentId,
    setCreatingJob,
    setJobDraft,
    setSelectedJobId,
    setSelectedJobRuns,
    setSelectedJobRunsStatus,
    setStatus,
  ]);

  const handleSelectJob = useCallback(
    async (jobId: string) => {
      const job = talkJobs.find((candidate) => candidate.id === jobId);
      if (!job) return;
      setCreatingJob(false);
      setSelectedJobId(job.id);
      setJobDraft(buildJobDraftFromJob(job));
      try {
        await loadSelectedJobRuns(job.id, { showLoading: true });
        setStatus({ status: 'idle' });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setSelectedJobRunsStatus({
          status: 'error',
          message:
            err instanceof Error ? err.message : 'Failed to load job runs.',
        });
      }
    },
    [
      loadSelectedJobRuns,
      onUnauthorized,
      setCreatingJob,
      setJobDraft,
      setSelectedJobId,
      setSelectedJobRunsStatus,
      setStatus,
      talkJobs,
    ],
  );

  const handleToggleJobWeekday = useCallback(
    (weekday: TalkJobWeekday) => {
      setJobDraft((current) => {
        const exists = current.weekdays.includes(weekday);
        return {
          ...current,
          weekdays: exists
            ? current.weekdays.filter((value) => value !== weekday)
            : [...current.weekdays, weekday],
        };
      });
    },
    [setJobDraft],
  );

  const handleToggleJobTool = useCallback(
    (toolId: string) => {
      setJobDraft((current) => {
        const exists = current.toolIds.includes(toolId);
        return {
          ...current,
          toolIds: exists
            ? current.toolIds.filter((value) => value !== toolId)
            : [...current.toolIds, toolId],
        };
      });
    },
    [setJobDraft],
  );

  const handleSaveJob = useCallback(async () => {
    if (!canEditJobs) return;
    if (!creatingJob && !selectedJob) return;

    setStatus({ status: 'saving' });
    try {
      const sourceScope = draftToTalkJobScope(jobDraft);
      const schedule = draftToTalkJobSchedule(jobDraft);

      const saved = creatingJob
        ? await createTalkJob({
            talkId,
            title: jobDraft.title,
            prompt: jobDraft.prompt,
            targetAgentId: jobDraft.targetAgentId,
            schedule,
            timezone: jobDraft.timezone,
            sourceScope,
          })
        : await patchTalkJob({
            talkId,
            jobId: selectedJob!.id,
            title: jobDraft.title,
            prompt: jobDraft.prompt,
            targetAgentId: jobDraft.targetAgentId,
            schedule,
            timezone: jobDraft.timezone,
            sourceScope,
          });

      await refreshTalkJobs({
        preferredJobId: saved.id,
        preserveSelection: true,
      });
      setStatus({
        status: 'success',
        message: creatingJob ? 'Job created.' : 'Job saved.',
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setStatus({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to save job.',
      });
    }
  }, [
    canEditJobs,
    creatingJob,
    jobDraft,
    onUnauthorized,
    refreshTalkJobs,
    selectedJob,
    setStatus,
    talkId,
  ]);

  const handleDeleteJob = useCallback(async () => {
    if (!selectedJob || !canEditJobs) return;
    const confirmed = window.confirm(
      `Delete "${selectedJob.title}"? This cannot be undone.`,
    );
    if (!confirmed) return;

    setStatus({ status: 'saving' });
    try {
      await deleteTalkJob({ talkId, jobId: selectedJob.id });
      const remaining = talkJobs.filter((job) => job.id !== selectedJob.id);
      setTalkJobs(remaining);
      setTalkJobsLoaded(true);
      if (remaining.length > 0) {
        const next = remaining[0]!;
        setCreatingJob(false);
        setSelectedJobId(next.id);
        setJobDraft(buildJobDraftFromJob(next));
        await loadSelectedJobRuns(next.id, { showLoading: false });
      } else {
        setSelectedJobId(null);
        setSelectedJobRuns([]);
        setSelectedJobRunsStatus({ status: 'idle' });
        setCreatingJob(false);
        setJobDraft(buildDefaultJobDraft({ targetAgentId: defaultAgentId }));
      }
      setStatus({ status: 'success', message: 'Job deleted.' });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setStatus({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to delete job.',
      });
    }
  }, [
    canEditJobs,
    defaultAgentId,
    loadSelectedJobRuns,
    onUnauthorized,
    selectedJob,
    setCreatingJob,
    setJobDraft,
    setSelectedJobId,
    setSelectedJobRuns,
    setSelectedJobRunsStatus,
    setStatus,
    setTalkJobs,
    setTalkJobsLoaded,
    talkId,
    talkJobs,
  ]);

  const handlePauseJob = useCallback(async () => {
    if (!selectedJob || !canEditJobs) return;
    setStatus({ status: 'saving' });
    try {
      const paused = await pauseTalkJob({ talkId, jobId: selectedJob.id });
      setTalkJobs((current) =>
        current.map((job) => (job.id === paused.id ? paused : job)),
      );
      setStatus({ status: 'success', message: 'Job paused.' });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setStatus({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to pause job.',
      });
    }
  }, [canEditJobs, onUnauthorized, selectedJob, setStatus, talkId]);

  const handleResumeJob = useCallback(async () => {
    if (!selectedJob || !canEditJobs) return;
    setStatus({ status: 'saving' });
    try {
      const resumed = await resumeTalkJob({ talkId, jobId: selectedJob.id });
      setTalkJobs((current) =>
        current.map((job) => (job.id === resumed.id ? resumed : job)),
      );
      setStatus({ status: 'success', message: 'Job resumed.' });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setStatus({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to resume job.',
      });
    }
  }, [canEditJobs, onUnauthorized, selectedJob, setStatus, talkId]);

  const handleRunJobNow = useCallback(async () => {
    if (!selectedJob || !canEditJobs) return;
    setStatus({ status: 'saving' });
    try {
      const queued = await runTalkJobNow({ talkId, jobId: selectedJob.id });
      await refreshSelectedJobExecutionState(selectedJob.id);
      setStatus({ status: 'success', message: 'Job queued.' });

      void (async () => {
        const isTerminal = (runStatus: TalkJobRunSummary['status']) =>
          runStatus === 'completed' ||
          runStatus === 'failed' ||
          runStatus === 'cancelled';

        for (let attempt = 0; attempt < 15; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
          try {
            const { runs } = await refreshSelectedJobExecutionState(
              selectedJob.id,
            );
            const latest =
              runs.find((run) => run.id === queued.runId) ?? runs[0] ?? null;
            if (!latest || !isTerminal(latest.status)) {
              continue;
            }
            await onJobRunSettled();
            setStatus(
              latest.status === 'completed'
                ? { status: 'success', message: 'Job completed.' }
                : {
                    status: 'error',
                    message:
                      latest.errorMessage ||
                      latest.cancelReason ||
                      `Job ${latest.status}.`,
                  },
            );
            return;
          } catch (pollErr) {
            if (pollErr instanceof UnauthorizedError) {
              onUnauthorized();
            }
            return;
          }
        }
      })();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setStatus({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to queue job.',
      });
    }
  }, [
    canEditJobs,
    onJobRunSettled,
    onUnauthorized,
    refreshSelectedJobExecutionState,
    selectedJob,
    setStatus,
    talkId,
  ]);

  return (
    <section className="talk-tab-panel" aria-label="Talk jobs">
      <div className="agents-panel-header">
        <div>
          <h2>Jobs</h2>
          <p className="policy-muted">
            Schedule recurring Talk runs with a read-only tool scope.
          </p>
        </div>
        <div className="connector-attach-row">
          <button
            type="button"
            className="secondary-btn"
            onClick={() =>
              void refreshTalkJobs({ showLoading: true }).catch((err) => {
                if (err instanceof UnauthorizedError) {
                  onUnauthorized();
                  return;
                }
                setStatus({
                  status: 'error',
                  message:
                    err instanceof Error ? err.message : 'Failed to load jobs.',
                });
              })
            }
          >
            Refresh
          </button>
          <button
            type="button"
            className="secondary-btn"
            onClick={handleCreateJobDraft}
            disabled={!canEditJobs || status.status === 'saving'}
          >
            New Job
          </button>
        </div>
      </div>

      {status.status === 'loading' && !talkJobsLoaded ? (
        <p className="page-state">Loading jobs…</p>
      ) : (
        <div className="talk-llm-card-list">
          <article className="talk-llm-card">
            <div className="connector-card-header">
              <div>
                <h3>Scheduled jobs</h3>
                <p className="talk-llm-meta">{talkJobs.length} configured</p>
              </div>
            </div>
            {talkJobs.length > 0 ? (
              <div className="talk-rule-list">
                {talkJobs.map((job) => (
                  <button
                    key={job.id}
                    type="button"
                    className={`secondary-btn${
                      selectedJobId === job.id ? ' btn-primary' : ''
                    }`}
                    onClick={() => void handleSelectJob(job.id)}
                  >
                    {job.title}
                    <span className="talk-llm-meta">
                      {job.status} · {formatTalkJobSchedule(job.schedule)}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="page-state">No jobs yet.</p>
            )}
          </article>

          <form
            className="talk-llm-card"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSaveJob();
            }}
          >
            <div className="connector-card-header">
              <div>
                <h3>
                  {creatingJob
                    ? 'New job'
                    : selectedJob
                      ? selectedJob.title
                      : 'Job details'}
                </h3>
                <p className="talk-llm-meta">
                  {selectedJob
                    ? summarizeTalkJobScope(selectedJob.sourceScope)
                    : 'Create or select a job to edit.'}
                </p>
              </div>
              {selectedJob ? (
                <span className="talk-agent-chip">{selectedJob.status}</span>
              ) : null}
            </div>

            {creatingJob || selectedJob ? (
              <>
                <label>
                  <span>Title</span>
                  <input
                    type="text"
                    value={jobDraft.title}
                    onChange={(event) =>
                      setJobDraft((current) => ({
                        ...current,
                        title: event.target.value,
                      }))
                    }
                    disabled={!canEditJobs || status.status === 'saving'}
                  />
                </label>
                <label>
                  <span>Prompt</span>
                  <textarea
                    rows={5}
                    value={jobDraft.prompt}
                    onChange={(event) =>
                      setJobDraft((current) => ({
                        ...current,
                        prompt: event.target.value,
                      }))
                    }
                    disabled={!canEditJobs || status.status === 'saving'}
                  />
                </label>
                <div className="connector-attach-row">
                  <label>
                    <span>Agent</span>
                    <select
                      value={jobDraft.targetAgentId}
                      onChange={(event) =>
                        setJobDraft((current) => ({
                          ...current,
                          targetAgentId: event.target.value,
                        }))
                      }
                      disabled={!canEditJobs || status.status === 'saving'}
                    >
                      <option value="" disabled>
                        Choose an agent…
                      </option>
                      {agentOptions.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Schedule</span>
                    <select
                      value={jobDraft.scheduleKind}
                      onChange={(event) =>
                        setJobDraft((current) => ({
                          ...current,
                          scheduleKind: event.target
                            .value as TalkJobSchedule['kind'],
                        }))
                      }
                      disabled={!canEditJobs || status.status === 'saving'}
                    >
                      <option value="hourly_interval">Hourly</option>
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                    </select>
                  </label>
                </div>

                {jobDraft.scheduleKind === 'hourly_interval' ? (
                  <label>
                    <span>Every hours</span>
                    <input
                      type="number"
                      min={1}
                      max={24}
                      value={jobDraft.everyHours}
                      onChange={(event) =>
                        setJobDraft((current) => ({
                          ...current,
                          everyHours: Number(event.target.value),
                        }))
                      }
                      disabled={!canEditJobs || status.status === 'saving'}
                    />
                  </label>
                ) : (
                  <>
                    {jobDraft.scheduleKind === 'weekly' ? (
                      <div className="connector-attach-row">
                        {JOB_WEEKDAY_ORDER.map((weekday) => (
                          <label
                            key={weekday}
                            className="policy-primary-toggle"
                          >
                            <input
                              type="checkbox"
                              checked={jobDraft.weekdays.includes(weekday)}
                              onChange={() => handleToggleJobWeekday(weekday)}
                              disabled={
                                !canEditJobs || status.status === 'saving'
                              }
                            />
                            <span>{JOB_WEEKDAY_LABELS[weekday]}</span>
                          </label>
                        ))}
                      </div>
                    ) : null}
                    <div className="connector-attach-row">
                      <label>
                        <span>Hour</span>
                        <input
                          type="number"
                          min={0}
                          max={23}
                          value={jobDraft.hour}
                          onChange={(event) =>
                            setJobDraft((current) => ({
                              ...current,
                              hour: Number(event.target.value),
                            }))
                          }
                          disabled={!canEditJobs || status.status === 'saving'}
                        />
                      </label>
                      <label>
                        <span>Minute</span>
                        <input
                          type="number"
                          min={0}
                          max={59}
                          value={jobDraft.minute}
                          onChange={(event) =>
                            setJobDraft((current) => ({
                              ...current,
                              minute: Number(event.target.value),
                            }))
                          }
                          disabled={!canEditJobs || status.status === 'saving'}
                        />
                      </label>
                    </div>
                  </>
                )}

                <label>
                  <span>Timezone</span>
                  <input
                    type="text"
                    value={jobDraft.timezone}
                    onChange={(event) =>
                      setJobDraft((current) => ({
                        ...current,
                        timezone: event.target.value,
                      }))
                    }
                    disabled={!canEditJobs || status.status === 'saving'}
                  />
                </label>

                <div className="talk-llm-card-list talk-llm-card-list-compact">
                  <div>
                    <h4>Tool scope</h4>
                    {jobToolsStatus.status === 'loading' && !jobToolsLoaded ? (
                      <p className="talk-llm-meta">Loading job tools…</p>
                    ) : null}
                    {jobToolsStatus.status === 'error' ? (
                      <div
                        className="inline-banner inline-banner-error"
                        role="alert"
                      >
                        {jobToolsStatus.message}
                      </div>
                    ) : null}
                    <label
                      className="policy-primary-toggle"
                      title={
                        jobWebEnabled
                          ? undefined
                          : 'Web must be enabled in Talk tools.'
                      }
                    >
                      <input
                        type="checkbox"
                        checked={jobDraft.allowWeb}
                        onChange={(event) =>
                          setJobDraft((current) => ({
                            ...current,
                            allowWeb: event.target.checked,
                          }))
                        }
                        disabled={
                          !canEditJobs ||
                          status.status === 'saving' ||
                          !jobWebEnabled
                        }
                      />
                      <span>Allow web search</span>
                    </label>
                    {jobToolOptions.map((option) => {
                      const enabled = jobToolFamilyEnabled(option.family);
                      return (
                        <label
                          key={option.toolId}
                          className="policy-primary-toggle"
                          title={
                            enabled
                              ? undefined
                              : `${option.label} must be enabled in Talk tools.`
                          }
                        >
                          <input
                            type="checkbox"
                            checked={jobDraft.toolIds.includes(option.toolId)}
                            onChange={() => handleToggleJobTool(option.toolId)}
                            disabled={
                              !canEditJobs ||
                              status.status === 'saving' ||
                              !enabled
                            }
                          />
                          <span>{option.label}</span>
                        </label>
                      );
                    })}
                    {jobDraft.toolIds
                      .filter((toolId) => !JOB_TOOL_LABEL_BY_ID.has(toolId))
                      .map((toolId) => (
                        <label key={toolId} className="policy-primary-toggle">
                          <input type="checkbox" checked disabled />
                          <span>{formatJobToolId(toolId)}</span>
                        </label>
                      ))}
                  </div>
                  <div>
                    <h4>Recent runs</h4>
                    {selectedJobRunsStatus.status === 'loading' ? (
                      <p className="talk-llm-meta">Loading runs…</p>
                    ) : selectedJobRunsStatus.status === 'error' ? (
                      <div
                        className="inline-banner inline-banner-error"
                        role="alert"
                      >
                        {selectedJobRunsStatus.message}
                      </div>
                    ) : selectedJobRuns.length > 0 ? (
                      <ul className="talk-llm-card-list talk-llm-card-list-compact">
                        {selectedJobRuns.map((run) => (
                          <li key={run.id} className="talk-llm-meta">
                            {run.status} · {formatDateTime(run.createdAt)}
                            {run.responseExcerpt
                              ? ` · ${run.responseExcerpt}`
                              : ''}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="talk-llm-meta">No runs yet.</p>
                    )}
                  </div>
                </div>

                <p className="talk-llm-meta">
                  Scope:{' '}
                  {summarizeTalkJobScope({
                    toolIds: jobDraft.toolIds,
                    allowWeb: jobDraft.allowWeb,
                  })}
                </p>

                <div className="connector-attach-row">
                  <button
                    type="submit"
                    className="secondary-btn"
                    disabled={
                      !canEditJobs ||
                      status.status === 'saving' ||
                      !jobDraft.title.trim() ||
                      !jobDraft.prompt.trim() ||
                      !jobDraft.targetAgentId ||
                      (!creatingJob && !hasUnsavedJobChanges)
                    }
                  >
                    {status.status === 'saving' ? 'Saving…' : 'Save Job'}
                  </button>
                  {selectedJob ? (
                    <>
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={
                          selectedJob.status === 'paused'
                            ? handleResumeJob
                            : handlePauseJob
                        }
                        disabled={
                          !canEditJobs ||
                          status.status === 'saving' ||
                          selectedJob.status === 'blocked'
                        }
                      >
                        {selectedJob.status === 'paused' ? 'Resume' : 'Pause'}
                      </button>
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={handleRunJobNow}
                        disabled={
                          !canEditJobs ||
                          status.status === 'saving' ||
                          selectedJob.status !== 'active'
                        }
                      >
                        Run Now
                      </button>
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={handleDeleteJob}
                        disabled={!canEditJobs || status.status === 'saving'}
                      >
                        Delete
                      </button>
                    </>
                  ) : null}
                </div>
              </>
            ) : (
              <p className="page-state">Select or create a job.</p>
            )}

            {status.status === 'error' ? (
              <div className="inline-banner inline-banner-error" role="alert">
                {status.message}
              </div>
            ) : null}
            {status.status === 'success' ? (
              <div
                className="inline-banner inline-banner-success"
                role="status"
              >
                {status.message}
              </div>
            ) : null}
          </form>
        </div>
      )}
    </section>
  );
}
