// Tools pill for the Talk top bar (design: ToolsHeaderButton +
// ToolsPopover in docs/prototypes/prototype). Shows the enabled-tool count
// and opens the grouped per-tool menu from the mock. Refetches on
// `refreshKey` bumps (talk_tools_changed events), the same wiring
// ToolChipsBar uses, so the count tracks external toggles.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  ApiError,
  getTalkTools,
  updateTalkTool,
  type TalkToolsState,
} from '../../lib/api';
import {
  TALK_TOOL_MENU_GROUPS,
  TALK_TOOL_MENU_ITEMS,
  type TalkToolMenuGroup,
  type TalkToolMenuItem,
} from '../../lib/tool-catalog';
import { CTIcon, Popover, salon } from '../../salon';

export interface TalkToolsPillProps {
  talkId: string;
  refreshKey?: number;
}

export function TalkToolsPill({
  talkId,
  refreshKey,
}: TalkToolsPillProps): JSX.Element | null {
  const [state, setState] = useState<TalkToolsState | null>(null);
  const [pendingToolIds, setPendingToolIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    getTalkTools(talkId)
      .then((next) => {
        if (!cancelled) {
          setState(next);
          setError(null);
        }
      })
      .catch(() => {
        if (!cancelled) setState(null);
      });
    return () => {
      cancelled = true;
    };
  }, [talkId, refreshKey]);

  const groups = useMemo(
    () => groupsForAvailableFamilies(state?.available ?? []),
    [state?.available],
  );
  const visibleItems = useMemo(
    () => groups.flatMap((group) => group.items),
    [groups],
  );
  const visibleToolIds = useMemo(
    () => new Set(visibleItems.map((item) => item.toolId)),
    [visibleItems],
  );
  const enabledToolIds = useMemo(
    () => enabledToolIdSet(state, visibleItems),
    [state, visibleItems],
  );
  const enabledCount = [...enabledToolIds].filter((toolId) =>
    visibleToolIds.has(toolId),
  ).length;

  const applyOptimisticToolState = useCallback(
    (toolId: string, enabled: boolean) => {
      setState((prev) =>
        prev ? withToolEnabled(prev, visibleItems, toolId, enabled) : prev,
      );
    },
    [visibleItems],
  );

  const onToggleTool = useCallback(
    async (item: TalkToolMenuItem) => {
      if (!state || pendingToolIds.has(item.toolId)) return;
      const prevEnabled = enabledToolIds.has(item.toolId);
      const nextEnabled = !prevEnabled;

      setError(null);
      applyOptimisticToolState(item.toolId, nextEnabled);
      setPendingToolIds((prev) => {
        const next = new Set(prev);
        next.add(item.toolId);
        return next;
      });

      try {
        const updated = await updateTalkTool({
          talkId,
          toolId: item.toolId,
          enabled: nextEnabled,
        });
        setState(updated);
      } catch (err) {
        applyOptimisticToolState(item.toolId, prevEnabled);
        setError(
          err instanceof ApiError || err instanceof Error
            ? err.message
            : 'Failed to update tool toggle',
        );
      } finally {
        setPendingToolIds((prev) => {
          const next = new Set(prev);
          next.delete(item.toolId);
          return next;
        });
      }
    },
    [applyOptimisticToolState, enabledToolIds, pendingToolIds, state, talkId],
  );

  if (!state) return null;
  if (visibleItems.length === 0) return null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`talk-orchestration-trigger talk-tools-pill${
          open ? ' talk-orchestration-trigger-open' : ''
        }`}
        onClick={() => {
          setAnchorRect(triggerRef.current?.getBoundingClientRect() ?? null);
          setOpen((current) => !current);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Tools, ${enabledCount} of ${visibleItems.length} on`}
        title={`${enabledCount} of ${visibleItems.length} tools on`}
      >
        <span className="talk-orchestration-trigger-icon" aria-hidden="true">
          <CTIcon name="bolt" size={13} strokeWidth={1.7} />
        </span>
        <span className="talk-orchestration-trigger-text">Tools</span>
        <span
          className={`talk-tab-badge${
            enabledCount > 0 ? ' talk-tab-badge-on' : ''
          }`}
          aria-hidden="true"
        >
          {enabledCount}
        </span>
        <span className="talk-orchestration-trigger-chevron" aria-hidden="true">
          <CTIcon name="chevron-d" size={11} strokeWidth={1.8} />
        </span>
      </button>
      {open ? (
        <Popover
          anchorRect={anchorRect}
          onClose={() => setOpen(false)}
          width={380}
          ariaLabel="Tools in this Talk"
        >
          <div className="talk-tools-popover">
            <header className="talk-tools-popover-header">
              <div className="talk-tools-popover-title-row">
                <CTIcon name="sparkle" size={13} stroke={salon.ink2} />
                <span className="talk-tools-popover-title">
                  Tools in this Talk
                </span>
                <span className="talk-tools-popover-count">
                  {enabledCount} of {visibleItems.length} on
                </span>
              </div>
              <p className="talk-tools-popover-copy">
                Agents in this room can use the tools you turn on here. Settings
                apply to every agent in the Talk and persist across rounds.
              </p>
            </header>
            {error ? (
              <div className="talk-tools-popover-error" role="alert">
                {error}
              </div>
            ) : null}
            <div className="talk-tools-popover-scroll ct-thin-scroll">
              {groups.map((group) => (
                <section className="talk-tools-popover-group" key={group.id}>
                  <div className="talk-tools-popover-group-title">
                    {group.title}
                  </div>
                  {group.items.map((item) => {
                    const on = enabledToolIds.has(item.toolId);
                    const pending = pendingToolIds.has(item.toolId);
                    return (
                      <button
                        type="button"
                        key={item.toolId}
                        className="talk-tools-popover-row"
                        aria-pressed={on}
                        disabled={pending}
                        onClick={() => {
                          void onToggleTool(item);
                        }}
                      >
                        <span
                          className={`talk-tools-popover-row-icon${
                            on ? ' talk-tools-popover-row-icon-on' : ''
                          }`}
                          aria-hidden="true"
                        >
                          <CTIcon
                            name={item.icon}
                            size={13}
                            strokeWidth={1.8}
                          />
                        </span>
                        <span className="talk-tools-popover-row-text">
                          <span className="talk-tools-popover-row-name">
                            {item.label}
                          </span>
                          <span className="talk-tools-popover-row-hint">
                            {item.description}
                          </span>
                        </span>
                        <span
                          className={`talk-tools-popover-switch${
                            on ? ' talk-tools-popover-switch-on' : ''
                          }`}
                          aria-hidden="true"
                        >
                          <span className="talk-tools-popover-switch-thumb" />
                        </span>
                      </button>
                    );
                  })}
                </section>
              ))}
            </div>
            <footer className="talk-tools-popover-footer">
              <span>
                Tool calls will appear in the thread as{' '}
                <span className="talk-tools-popover-footnote">· tool</span>{' '}
                footnotes.
              </span>
              <button
                type="button"
                className="talk-tools-popover-done"
                onClick={() => setOpen(false)}
              >
                Done
              </button>
            </footer>
          </div>
        </Popover>
      ) : null}
    </>
  );
}

function groupsForAvailableFamilies(available: string[]): TalkToolMenuGroup[] {
  const availableSet = new Set(available);
  return TALK_TOOL_MENU_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => availableSet.has(item.family)),
  })).filter((group) => group.items.length > 0);
}

function enabledToolIdSet(
  state: TalkToolsState | null,
  visibleItems: TalkToolMenuItem[],
): Set<string> {
  if (!state) return new Set();
  if (Array.isArray(state.activeToolIds)) {
    return new Set(state.activeToolIds);
  }
  return new Set(
    visibleItems
      .filter((item) => state.active[item.family] === true)
      .map((item) => item.toolId),
  );
}

function activeMapFromToolIds(
  visibleItems: TalkToolMenuItem[],
  activeToolIds: Set<string>,
): Record<string, boolean> {
  const active: Record<string, boolean> = {};
  for (const item of visibleItems) {
    active[item.family] =
      active[item.family] === true || activeToolIds.has(item.toolId);
  }
  return active;
}

function withToolEnabled(
  state: TalkToolsState,
  visibleItems: TalkToolMenuItem[],
  toolId: string,
  enabled: boolean,
): TalkToolsState {
  const activeToolIds = enabledToolIdSet(state, visibleItems);
  if (enabled) {
    activeToolIds.add(toolId);
  } else {
    activeToolIds.delete(toolId);
  }

  return {
    ...state,
    active: {
      ...state.active,
      ...activeMapFromToolIds(visibleItems, activeToolIds),
    },
    activeToolIds: TALK_TOOL_MENU_ITEMS.filter((item) =>
      activeToolIds.has(item.toolId),
    ).map((item) => item.toolId),
  };
}
