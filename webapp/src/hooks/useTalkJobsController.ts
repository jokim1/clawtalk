import { useCallback, useEffect, useState, type MutableRefObject } from 'react';

import {
  buildDefaultJobDraft,
  type JobLoadStatus,
  type TalkJobDraft,
  type TalkJobsStatusState,
} from '../components/TalkJobsPanel';
import type { TalkJob, TalkJobRunSummary } from '../lib/api';

type UseTalkJobsControllerInput = {
  talkId: string;
  activeThreadIdRef: MutableRefObject<string | null>;
  resyncTalkState: (options?: { refreshThreads?: boolean }) => Promise<void>;
};

export function useTalkJobsController({
  talkId,
  activeThreadIdRef,
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

  // After a Run-Now settles in TalkJobsPanel: if the job's thread is the active
  // thread, resync the thread/run views. Encapsulates the page-private
  // activeThreadIdRef + resyncTalkState so the panel needs neither.
  const handleJobRunSettled = useCallback(
    async (jobThreadId: string | null) => {
      if (jobThreadId === activeThreadIdRef.current) {
        await resyncTalkState({ refreshThreads: true });
      }
    },
    [activeThreadIdRef, resyncTalkState],
  );

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
