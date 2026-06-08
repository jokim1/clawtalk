import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';

export type TalkDetailTabKey =
  | 'talk'
  | 'agents'
  | 'context'
  | 'connectors'
  | 'jobs'
  | 'runs';

export type TalkDetailTabLinks = {
  threadAwareTalkTabHref: string;
  agentsTabHref: string;
  contextTabHref: string;
  workspaceConnectorsTabHref: string;
  jobsTabHref: string;
  runsTabHref: string;
  manageAgentsHref: string;
};

export function getTabFromPath(
  pathname: string,
  talkId: string,
): TalkDetailTabKey {
  const base = `/app/talks/${talkId}`;
  if (pathname === `${base}/agents`) return 'agents';
  if (pathname === `${base}/context`) return 'context';
  if (
    pathname === `${base}/connectors` ||
    pathname === `${base}/channels` ||
    pathname === `${base}/data-connectors`
  ) {
    return 'connectors';
  }
  if (pathname === `${base}/jobs`) return 'jobs';
  if (pathname === `${base}/runs`) return 'runs';
  if (pathname === `${base}/tools`) return 'context';
  return 'talk';
}

export function buildThreadHref(
  talkId: string,
  threadId: string,
  tab: TalkDetailTabKey = 'talk',
): string {
  const path =
    tab === 'talk' ? `/app/talks/${talkId}` : `/app/talks/${talkId}/${tab}`;
  return `${path}?thread=${encodeURIComponent(threadId)}`;
}

export function useTalkDetailRouteState(talkId: string): {
  currentTab: TalkDetailTabKey;
  locationParams: URLSearchParams;
} {
  const location = useLocation();
  const currentTab = getTabFromPath(location.pathname, talkId);
  const locationParams = useMemo(
    () => new URLSearchParams(location.search),
    [location.search],
  );

  return { currentTab, locationParams };
}

export function useTalkDetailTabLinks(input: {
  talkId: string;
  activeThreadId: string | null;
}): TalkDetailTabLinks {
  const { talkId, activeThreadId } = input;

  return useMemo(() => {
    const talkTabHref = `/app/talks/${talkId}`;
    const threadAwareTalkTabHref = activeThreadId
      ? buildThreadHref(talkId, activeThreadId)
      : talkTabHref;
    const agentsTabHref = activeThreadId
      ? buildThreadHref(talkId, activeThreadId, 'agents')
      : `/app/talks/${talkId}/agents`;
    const contextTabHref = activeThreadId
      ? buildThreadHref(talkId, activeThreadId, 'context')
      : `/app/talks/${talkId}/context`;
    const workspaceConnectorsTabHref = activeThreadId
      ? buildThreadHref(talkId, activeThreadId, 'connectors')
      : `/app/talks/${talkId}/connectors`;
    const jobsTabHref = activeThreadId
      ? buildThreadHref(talkId, activeThreadId, 'jobs')
      : `/app/talks/${talkId}/jobs`;
    const runsTabHref = activeThreadId
      ? buildThreadHref(talkId, activeThreadId, 'runs')
      : `/app/talks/${talkId}/runs`;
    const manageAgentsHref = `/app/settings?tab=agents&returnTo=${encodeURIComponent(
      threadAwareTalkTabHref,
    )}`;

    return {
      threadAwareTalkTabHref,
      agentsTabHref,
      contextTabHref,
      workspaceConnectorsTabHref,
      jobsTabHref,
      runsTabHref,
      manageAgentsHref,
    };
  }, [activeThreadId, talkId]);
}
