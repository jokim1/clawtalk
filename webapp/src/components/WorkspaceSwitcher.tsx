import { useEffect, useRef, useState } from 'react';

import type { SessionWorkspace } from '../lib/api';

type Props = {
  workspaces: SessionWorkspace[];
  currentWorkspaceId: string | undefined;
  onSwitchWorkspace: (workspaceId: string) => void | Promise<void>;
};

export function WorkspaceSwitcher({
  workspaces,
  currentWorkspaceId,
  onSwitchWorkspace,
}: Props): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  if (workspaces.length === 0) return null;

  // Display falls back to the first workspace when the session payload has no
  // currentWorkspaceId, but active/selection logic always trusts
  // currentWorkspaceId so a stale payload can neither mislabel the active
  // workspace nor lock the user out of switching to the real first one.
  const display =
    workspaces.find((workspace) => workspace.id === currentWorkspaceId) ??
    workspaces[0];
  const canSwitch = workspaces.length > 1;

  const handleSelect = async (workspaceId: string) => {
    setOpen(false);
    if (workspaceId === currentWorkspaceId || switching) return;
    setSwitching(true);
    setError(null);
    try {
      await onSwitchWorkspace(workspaceId);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to switch workspace',
      );
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className="clawtalk-sidebar-workspace" ref={containerRef}>
      <button
        type="button"
        ref={triggerRef}
        className="clawtalk-sidebar-workspace-trigger"
        aria-label="Switch workspace"
        aria-haspopup={canSwitch ? 'menu' : undefined}
        aria-expanded={canSwitch ? open : undefined}
        disabled={!canSwitch || switching}
        onClick={() => {
          if (!canSwitch) return;
          setOpen((value) => !value);
        }}
      >
        <span className="clawtalk-sidebar-workspace-initials" aria-hidden="true">
          {display.initials}
        </span>
        <span className="clawtalk-sidebar-workspace-name">{display.name}</span>
        {canSwitch ? (
          <span className="clawtalk-sidebar-workspace-caret" aria-hidden="true">
            ▾
          </span>
        ) : null}
      </button>

      {open && canSwitch ? (
        <div className="clawtalk-sidebar-workspace-menu" role="menu">
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              className={`clawtalk-sidebar-workspace-menu-item${
                workspace.id === currentWorkspaceId ? ' active' : ''
              }`}
              role="menuitemradio"
              aria-checked={workspace.id === currentWorkspaceId}
              onClick={() => void handleSelect(workspace.id)}
            >
              <span
                className="clawtalk-sidebar-workspace-initials"
                aria-hidden="true"
              >
                {workspace.initials}
              </span>
              <span className="clawtalk-sidebar-workspace-name">
                {workspace.name}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {error ? (
        <p className="clawtalk-sidebar-workspace-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
