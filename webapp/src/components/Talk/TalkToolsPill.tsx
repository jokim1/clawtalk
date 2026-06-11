// Read-only Tools pill for the Talk top bar (design: ToolsHeaderButton in
// docs/prototypes/prototype/screens.jsx). Shows the enabled-tool count and
// opens a Popover listing the Talk's tool families with their on/off state.
// Management stays in the composer chip bar (ToolChipsBar) — this surface
// only reflects it, so toggle failures and optimistic state live in one
// place. Refetches on `refreshKey` bumps (talk_tools_changed events), the
// same wiring ToolChipsBar uses, so the count tracks chip toggles.

import { useEffect, useRef, useState } from 'react';

import { getTalkTools, type TalkToolsState } from '../../lib/api';
import {
  TOOL_FAMILY_ORDER,
  TOOL_HINTS,
  TOOL_NAMES,
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
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    getTalkTools(talkId)
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch(() => {
        // Read-only affordance: on load failure render nothing rather than
        // a stale or broken pill. The chip bar surfaces tool errors.
        if (!cancelled) setState(null);
      });
    return () => {
      cancelled = true;
    };
  }, [talkId, refreshKey]);

  if (!state) return null;
  const availableSet = new Set(state.available);
  const families = TOOL_FAMILY_ORDER.filter((slug) => availableSet.has(slug));
  if (families.length === 0) return null;
  const enabledFamilies = families.filter(
    (family) => state.active[family] === true,
  );

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
        aria-label={`Tools, ${enabledFamilies.length} of ${families.length} on`}
        title={`${enabledFamilies.length} of ${families.length} tools on`}
      >
        <span className="talk-orchestration-trigger-icon" aria-hidden="true">
          <CTIcon name="bolt" size={13} strokeWidth={1.7} />
        </span>
        <span className="talk-orchestration-trigger-text">Tools</span>
        <span
          className={`talk-tab-badge${
            enabledFamilies.length > 0 ? ' talk-tab-badge-on' : ''
          }`}
          aria-hidden="true"
        >
          {enabledFamilies.length}
        </span>
      </button>
      {open ? (
        <Popover
          anchorRect={anchorRect}
          onClose={() => setOpen(false)}
          width={340}
          ariaLabel="Tools in this Talk"
        >
          <div className="talk-tools-popover">
            <header className="talk-tools-popover-header">
              <CTIcon name="bolt" size={13} stroke={salon.ink2} />
              <span className="talk-tools-popover-title">
                Tools in this Talk
              </span>
              <span className="talk-tools-popover-count">
                {enabledFamilies.length} of {families.length} on
              </span>
            </header>
            <ul className="talk-tools-popover-list">
              {families.map((family) => {
                const on = state.active[family] === true;
                return (
                  <li
                    key={family}
                    className={`talk-tools-popover-row${
                      on ? '' : ' talk-tools-popover-row-off'
                    }`}
                  >
                    <div className="talk-tools-popover-row-text">
                      <span className="talk-tools-popover-row-name">
                        {TOOL_NAMES[family] ?? family}
                      </span>
                      <span className="talk-tools-popover-row-hint">
                        {TOOL_HINTS[family] ?? ''}
                      </span>
                    </div>
                    <span
                      className={`talk-tools-popover-state${
                        on ? ' talk-tools-popover-state-on' : ''
                      }`}
                    >
                      {on ? 'On' : 'Off'}
                    </span>
                  </li>
                );
              })}
            </ul>
            <footer className="talk-tools-popover-footer">
              Turn tools on or off from the chips above the composer.
            </footer>
          </div>
        </Popover>
      ) : null}
    </>
  );
}
