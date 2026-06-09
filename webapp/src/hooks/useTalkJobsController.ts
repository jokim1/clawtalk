import { useCallback, useEffect, useState } from 'react';

import {
  buildDefaultJobDraft,
  type JobLoadStatus,
  type TalkJobDraft,
  type TalkJobsStatusState,
} from '../components/TalkJobsPanel';
import type { TalkJob, TalkJobRunSummary } from '../lib/api';

type UseTalkJobsControllerInput = {
  talkId: string;
  resyncTalkState: (options?: { refreshThreads?: boolean }) => Promise<void>;
};

export function useTalkJobsController({
  talkId,
  resyncTalkState,
}: UseTalkJobsControllerInput) {
  // Page-owned Jobs state. TalkJobsPanel self-fetches only the read-only tool
  // scope; every async mutation target lives here across tab unmount/remount.
  const [talkJobs, setTalkJobs] = useState<TalkJob[]>([]);
  const [talkJobsLoaded, setTalkJobsLoaded] = useState(false);
  const [talkJobsStatus, setTalkJobsStatus] = useState<TalkJobsStatusState>({
    status: 'idle',
  });
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [creatingJob, setCreatingJob] = useState(false);
  const [jobDraft, setJobDraft] = useState<TalkJobDraft>(() =>
    buildDefaultJobDraft(),
  );
  const [selectedJobRuns, setSelectedJobRuns] = useState<TalkJobRunSummary[]>(
    [],
  );
  const [selectedJobRunsStatus, setSelectedJobRunsStatus] =
    useState<JobLoadStatus>({ status: 'idle' });

  useEffect(() => {
    setTalkJobs([]);
    setTalkJobsLoaded(false);
    setTalkJobsStatus({ status: 'idle' });
    setSelectedJobId(null);
    setCreatingJob(false);
    setJobDraft(buildDefaultJobDraft());
    setSelectedJobRuns([]);
    setSelectedJobRunsStatus({ status: 'idle' });
  }, [talkId]);

  // After a Run-Now settles in TalkJobsPanel, resync the Talk timeline and runs.
  const handleJobRunSettled = useCallback(async () => {
    await resyncTalkState({ refreshThreads: true });
  }, [resyncTalkState]);

  return {
    talkJobs,
    setTalkJobs,
    talkJobsLoaded,
    setTalkJobsLoaded,
    talkJobsStatus,
    setTalkJobsStatus,
    selectedJobId,
    setSelectedJobId,
    creatingJob,
    setCreatingJob,
    jobDraft,
    setJobDraft,
    selectedJobRuns,
    setSelectedJobRuns,
    selectedJobRunsStatus,
    setSelectedJobRunsStatus,
    handleJobRunSettled,
  };
}
