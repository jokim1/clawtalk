import { useCallback, useEffect, useMemo, useState } from 'react';

import type { ContextStatusState } from '../components/TalkContextPanel';
import {
  getTalkContext,
  UnauthorizedError,
  type ContextGoal,
  type ContextRule,
  type ContextSource,
} from '../lib/api';
import type { TalkDetailTabKey } from './useTalkDetailTabs';

type PageKind = 'loading' | 'ready' | 'unavailable' | 'error';

type UseTalkContextControllerInput = {
  talkId: string;
  currentTab: TalkDetailTabKey;
  pageKind: PageKind;
  onUnauthorized: () => void;
};

export function useTalkContextController({
  talkId,
  currentTab,
  pageKind,
  onUnauthorized,
}: UseTalkContextControllerInput) {
  const [contextGoal, setContextGoal] = useState<ContextGoal | null>(null);
  const [contextRules, setContextRules] = useState<ContextRule[]>([]);
  const [contextSources, setContextSources] = useState<ContextSource[]>([]);
  const [contextLoaded, setContextLoaded] = useState(false);
  // Page-owned status shared with TalkContextPanel: drives the load gate and
  // goal/rule mutation feedback. Kept outside the tab-mounted panel so the
  // saving lockout and any in-flight mutation survive tab changes.
  const [contextStatus, setContextStatus] = useState<ContextStatusState>({
    status: 'idle',
  });
  // Goal/rule drafts are sparse in-progress overrides: null/missing means
  // render the live goal/rule prop. The panel clears them after save/no-op.
  const [goalDraft, setGoalDraft] = useState<string | null>(null);
  const [newRuleText, setNewRuleText] = useState('');
  const [ruleDrafts, setRuleDrafts] = useState<Record<string, string>>({});

  const activeRuleCount = useMemo(
    () => contextRules.filter((rule) => rule.isActive).length,
    [contextRules],
  );

  const refreshContext = useCallback(
    async (options?: { showLoading?: boolean }) => {
      if (options?.showLoading) {
        setContextStatus({ status: 'loading' });
      }
      const ctx = await getTalkContext(talkId);
      setContextGoal(ctx.goal);
      setContextRules(ctx.rules);
      setContextSources(ctx.sources);
      setContextLoaded(true);
      setContextStatus({ status: 'idle' });
    },
    [talkId],
  );

  useEffect(() => {
    setContextLoaded(false);
    setContextGoal(null);
    setContextRules([]);
    setContextSources([]);
    setContextStatus({ status: 'idle' });
    setGoalDraft(null);
    setNewRuleText('');
    setRuleDrafts({});
  }, [talkId]);

  // Load Talk context once so Rules badges and context surfaces stay hydrated.
  useEffect(() => {
    if (pageKind !== 'ready') return;
    if (contextLoaded) return;

    let cancelled = false;

    const loadContext = async () => {
      try {
        await refreshContext({
          showLoading: currentTab === 'context',
        });
        if (cancelled) return;
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        if (!cancelled) {
          setContextStatus({
            status: 'error',
            message:
              err instanceof Error ? err.message : 'Failed to load context.',
          });
        }
      }
    };

    void loadContext();
    return () => {
      cancelled = true;
    };
  }, [contextLoaded, currentTab, onUnauthorized, refreshContext, pageKind]);

  useEffect(() => {
    if (pageKind !== 'ready' || currentTab !== 'context' || !contextLoaded) {
      return;
    }
    if (!contextSources.some((source) => source.status === 'pending')) {
      return;
    }

    let cancelled = false;
    const interval = window.setInterval(() => {
      void refreshContext().catch((err) => {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setContextStatus({
          status: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Failed to refresh saved source status.',
        });
      });
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [
    contextLoaded,
    contextSources,
    currentTab,
    onUnauthorized,
    refreshContext,
    pageKind,
  ]);

  return {
    activeRuleCount,
    contextGoal,
    setContextGoal,
    contextRules,
    setContextRules,
    contextSources,
    setContextSources,
    contextStatus,
    setContextStatus,
    goalDraft,
    setGoalDraft,
    newRuleText,
    setNewRuleText,
    ruleDrafts,
    setRuleDrafts,
  };
}
