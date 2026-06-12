import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';

export type TalkDetailTabKey =
  | 'talk'
  | 'documents'
  | 'agents'
  | 'context'
  | 'jobs'
  | 'runs';

export type TalkDetailTabLinks = {
  talkTabHref: string;
  documentsTabHref: string;
  agentsTabHref: string;
  contextTabHref: string;
  jobsTabHref: string;
  runsTabHref: string;
  manageAgentsHref: string;
};

export function getTabFromPath(
  pathname: string,
  talkId: string,
): TalkDetailTabKey {
  const base = `/app/talks/${talkId}`;
  if (pathname === `${base}/documents`) return 'documents';
  if (pathname === `${base}/agents`) return 'agents';
  if (pathname === `${base}/context`) return 'context';
  if (pathname === `${base}/jobs`) return 'jobs';
  if (pathname === `${base}/runs`) return 'runs';
  if (pathname === `${base}/connectors`) return 'talk';
  if (pathname === `${base}/tools`) return 'context';
  return 'talk';
}

export function buildTalkDetailHref(
  talkId: string,
  tab: TalkDetailTabKey = 'talk',
): string {
  return tab === 'talk'
    ? `/app/talks/${talkId}`
    : `/app/talks/${talkId}/${tab}`;
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
}): TalkDetailTabLinks {
  const { talkId } = input;

  return useMemo(() => {
    const talkTabHref = `/app/talks/${talkId}`;
    const documentsTabHref = buildTalkDetailHref(talkId, 'documents');
    const agentsTabHref = buildTalkDetailHref(talkId, 'agents');
    const contextTabHref = buildTalkDetailHref(talkId, 'context');
    const jobsTabHref = buildTalkDetailHref(talkId, 'jobs');
    const runsTabHref = buildTalkDetailHref(talkId, 'runs');
    const manageAgentsHref = `/app/settings?tab=agents&returnTo=${encodeURIComponent(
      talkTabHref,
    )}`;

    return {
      talkTabHref,
      documentsTabHref,
      agentsTabHref,
      contextTabHref,
      jobsTabHref,
      runsTabHref,
      manageAgentsHref,
    };
  }, [talkId]);
}
