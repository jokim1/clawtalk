import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useMemo,
} from 'react';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';

import {
  createTalkContextRule,
  deleteTalkContextRule,
  patchTalkContextRule,
  setTalkGoal,
  UnauthorizedError,
  type ContextGoal,
  type ContextRule,
} from '../lib/api';
import { Button, Chip, Textarea } from '../salon';

function sortRulesByOrder(rules: ContextRule[]): ContextRule[] {
  return [...rules].sort((left, right) => {
    const delta = left.sortOrder - right.sortOrder;
    if (delta !== 0) return delta;
    return left.createdAt.localeCompare(right.createdAt);
  });
}

function reorderRules(
  rules: ContextRule[],
  activeId: string,
  overId: string,
): ContextRule[] {
  const ordered = sortRulesByOrder(rules);
  const fromIndex = ordered.findIndex((rule) => rule.id === activeId);
  const toIndex = ordered.findIndex((rule) => rule.id === overId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
    return ordered;
  }

  const next = [...ordered];
  const [moved] = next.splice(fromIndex, 1);
  if (!moved) return ordered;
  next.splice(toIndex, 0, moved);
  return next.map((rule, index) => ({ ...rule, sortOrder: index }));
}

function RuleRow({
  ruleId,
  disabled,
  label,
  children,
}: {
  ruleId: string;
  disabled: boolean;
  label: string;
  children: ReactNode;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: ruleId,
      disabled,
    });
  const { isOver, setNodeRef: setDropNodeRef } = useDroppable({
    id: ruleId,
    disabled,
  });

  return (
    <div
      ref={(node) => {
        setNodeRef(node);
        setDropNodeRef(node);
      }}
      className={`talk-rule-row${isDragging ? ' talk-rule-row-dragging' : ''}${
        isOver && !disabled ? ' talk-rule-row-over' : ''
      }`}
      style={{
        transform: transform ? CSS.Translate.toString(transform) : undefined,
      }}
    >
      <button
        type="button"
        className="talk-rule-handle"
        aria-label={`Reorder ${label}`}
        disabled={disabled}
        {...attributes}
        {...listeners}
      >
        <span aria-hidden="true">⋮⋮</span>
      </button>
      <div className="talk-rule-row-body">{children}</div>
    </div>
  );
}

// Shared by the page: one status drives the Context tab's load gate AND the
// goal/rule mutation feedback. Keeping it page-owned (rather than local to this
// tab-mounted panel) means the 'saving' lockout and in-flight mutation survive
// the user leaving and re-entering the Context tab — so controls can't re-enable
// mid-save and let a late response clobber a newer edit.
export type ContextStatusState = {
  status: 'idle' | 'loading' | 'saving' | 'error' | 'success';
  message?: string;
};

type TalkContextPanelProps = {
  talkId: string;
  goal: ContextGoal | null;
  rules: ContextRule[];
  setGoal: Dispatch<SetStateAction<ContextGoal | null>>;
  setRules: Dispatch<SetStateAction<ContextRule[]>>;
  status: ContextStatusState;
  setStatus: Dispatch<SetStateAction<ContextStatusState>>;
  // Sparse in-progress draft *overrides* of the server values, owned by the page
  // (so they survive leaving/re-entering the Context tab, like the other tabs'
  // drafts). goalDraft === null / a missing ruleDrafts entry means "no override
  // — render the live prop"; overrides are cleared on a successful save. See the
  // declarations in TalkDetailPage for the full rationale.
  goalDraft: string | null;
  setGoalDraft: Dispatch<SetStateAction<string | null>>;
  newRuleText: string;
  setNewRuleText: Dispatch<SetStateAction<string>>;
  ruleDrafts: Record<string, string>;
  setRuleDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  canEdit: boolean;
  onUnauthorized: () => void;
};

export function TalkContextPanel({
  talkId,
  goal,
  rules,
  setGoal,
  setRules,
  status,
  setStatus,
  goalDraft,
  setGoalDraft,
  newRuleText,
  setNewRuleText,
  ruleDrafts,
  setRuleDrafts,
  canEdit,
  onUnauthorized,
}: TalkContextPanelProps): JSX.Element {
  const ruleSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );
  const orderedContextRules = useMemo(() => sortRulesByOrder(rules), [rules]);

  const handleSaveGoal = async () => {
    setStatus({ status: 'saving' });
    try {
      const result = await setTalkGoal({
        talkId,
        goalText: goalDraft ?? goal?.goalText ?? '',
      });
      setGoal(result.goal);
      // Leave goalDraft as-is (matches the pre-refactor behavior): it already
      // holds the saved text and is reset on talk switch. Clearing it here is
      // not talk-safe the way the id-keyed rule-draft clears are — a goal save
      // that resolves after a talk switch must not touch the new talk's draft.
      setStatus({ status: 'success', message: 'Goal saved.' });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setStatus({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to save goal.',
      });
    }
  };

  const handleAddRule = async () => {
    if (!newRuleText.trim()) return;
    setStatus({ status: 'saving' });
    try {
      const rule = await createTalkContextRule({
        talkId,
        ruleText: newRuleText.trim(),
      });
      setRules((prev) => sortRulesByOrder([...prev, rule]));
      setNewRuleText('');
      setStatus({ status: 'idle' });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setStatus({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to add rule.',
      });
    }
  };

  const handleToggleRule = async (rule: ContextRule) => {
    try {
      const updated = await patchTalkContextRule({
        talkId,
        ruleId: rule.id,
        isActive: !rule.isActive,
      });
      setRules((prev) =>
        sortRulesByOrder(prev.map((r) => (r.id === updated.id ? updated : r))),
      );
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setStatus({
        status: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to update rule state.',
      });
    }
  };

  const handleSaveRuleText = async (rule: ContextRule) => {
    const draft = (ruleDrafts[rule.id] ?? rule.ruleText).trim();
    if (!draft) {
      setRuleDrafts((prev) => {
        const next = { ...prev };
        delete next[rule.id];
        return next;
      });
      setStatus({
        status: 'error',
        message: 'Rule text is required.',
      });
      return;
    }
    if (draft === rule.ruleText) {
      // No real change (e.g. whitespace-only) — drop the override so the row
      // tracks the live prop instead of masking a later server update.
      setRuleDrafts((prev) => {
        const next = { ...prev };
        delete next[rule.id];
        return next;
      });
      return;
    }

    setStatus({ status: 'saving' });
    try {
      const updated = await patchTalkContextRule({
        talkId,
        ruleId: rule.id,
        ruleText: draft,
      });
      setRules((prev) =>
        sortRulesByOrder(
          prev.map((current) =>
            current.id === updated.id ? updated : current,
          ),
        ),
      );
      setRuleDrafts((prev) => {
        const next = { ...prev };
        delete next[rule.id];
        return next;
      });
      setStatus({ status: 'success', message: 'Rule updated.' });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setStatus({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to update rule.',
      });
    }
  };

  const handleDeleteRule = async (ruleId: string) => {
    try {
      await deleteTalkContextRule({ talkId, ruleId });
      setRules((prev) => prev.filter((r) => r.id !== ruleId));
      setRuleDrafts((prev) => {
        const next = { ...prev };
        delete next[ruleId];
        return next;
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setStatus({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to delete rule.',
      });
    }
  };

  const handleRuleReorder = async (event: DragEndEvent) => {
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    if (!overId || activeId === overId) {
      return;
    }

    const previousRules = orderedContextRules;
    const nextRules = reorderRules(previousRules, activeId, overId);
    if (nextRules === previousRules) {
      return;
    }

    const changedRules = nextRules.filter((rule, index) => {
      const previous = previousRules.find(
        (candidate) => candidate.id === rule.id,
      );
      return previous?.sortOrder !== index;
    });

    setRules(nextRules);
    setStatus({ status: 'saving' });

    try {
      await Promise.all(
        changedRules.map((rule) =>
          patchTalkContextRule({
            talkId,
            ruleId: rule.id,
            sortOrder: rule.sortOrder,
          }),
        ),
      );
      setStatus({ status: 'success', message: 'Rule order updated.' });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setRules(previousRules);
      setStatus({
        status: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to reorder rules.',
      });
    }
  };

  return (
    <>
      {/* Goal */}
      <section className="talk-context-card">
        <div className="talk-context-card-header">
          <div>
            <h3>Goal</h3>
            <p className="talk-context-card-copy">
              What is this talk for? Describe the overall objective so agents
              share a frame for every discussion.
            </p>
          </div>
        </div>
        {canEdit ? (
          <>
            <label className="talk-context-field">
              <span className="sr-only">Talk goal</span>
              <Textarea
                maxLength={1000}
                rows={4}
                value={goalDraft ?? goal?.goalText ?? ''}
                onChange={(e) => setGoalDraft(e.target.value)}
                placeholder="e.g. Track and discuss Cal Football news each week — scores, key plays, injury reports, and how the team is trending toward bowl eligibility."
                disabled={status.status === 'saving'}
                className="talk-context-textarea talk-context-goal-textarea"
              />
            </label>
            <div className="talk-context-card-footer">
              <p className="talk-context-count">
                {(goalDraft ?? goal?.goalText ?? '').length}/1000
              </p>
              <Button
                variant="secondary"
                onClick={() => void handleSaveGoal()}
                disabled={status.status === 'saving'}
              >
                Save
              </Button>
            </div>
          </>
        ) : (
          <p className="talk-context-readonly">
            {goal?.goalText || <em>No goal set.</em>}
          </p>
        )}
      </section>

      {/* Rules */}
      <section className="talk-context-card">
        <div className="talk-context-card-header">
          <div>
            <h3>Rules</h3>
            <p className="talk-context-card-copy">
              Specific formats and constraints — e.g. an output shape to follow,
              or sources to avoid. Up to 8 active rules, applied in order.
              Inactive rules stay editable without affecting prompt injection.
            </p>
          </div>
        </div>
        {orderedContextRules.length > 0 ? (
          <DndContext
            sensors={ruleSensors}
            collisionDetection={closestCenter}
            onDragEnd={(event) => void handleRuleReorder(event)}
          >
            <div className="talk-rule-list">
              {orderedContextRules.map((rule) => {
                const draft = ruleDrafts[rule.id] ?? rule.ruleText;
                const hasTextChange =
                  draft.trim().length > 0 && draft.trim() !== rule.ruleText;
                return (
                  <RuleRow
                    key={rule.id}
                    ruleId={rule.id}
                    disabled={!canEdit}
                    label={rule.ruleText}
                  >
                    <div
                      className={`talk-rule-card${
                        rule.isActive ? '' : ' talk-rule-card-inactive'
                      }`}
                    >
                      <div className="talk-rule-card-top">
                        <Chip
                          tone={rule.isActive ? 'paper' : 'ghost'}
                          active={rule.isActive}
                        >
                          {rule.isActive ? 'Active' : 'Inactive'}
                        </Chip>
                        <span className="talk-context-rule-position">
                          Position {rule.sortOrder + 1}
                        </span>
                      </div>
                      {canEdit ? (
                        <>
                          <label className="talk-rule-edit-field">
                            <span className="sr-only">Rule text</span>
                            <Textarea
                              maxLength={800}
                              rows={2}
                              value={draft}
                              onChange={(event) =>
                                setRuleDrafts((prev) => ({
                                  ...prev,
                                  [rule.id]: event.target.value,
                                }))
                              }
                              onBlur={() => void handleSaveRuleText(rule)}
                              disabled={status.status === 'saving'}
                              className="talk-context-textarea talk-context-rule-textarea"
                            />
                          </label>
                          <div className="talk-rule-actions">
                            <Button
                              variant="secondary"
                              onClick={() => void handleToggleRule(rule)}
                            >
                              {rule.isActive ? 'Pause' : 'Activate'}
                            </Button>
                            <Button
                              variant="secondary"
                              onClick={() => void handleSaveRuleText(rule)}
                              disabled={
                                status.status === 'saving' || !hasTextChange
                              }
                            >
                              Save
                            </Button>
                            <Button
                              variant="danger"
                              onClick={() => void handleDeleteRule(rule.id)}
                            >
                              Delete
                            </Button>
                          </div>
                        </>
                      ) : (
                        <p className="talk-rule-readonly">{rule.ruleText}</p>
                      )}
                    </div>
                  </RuleRow>
                );
              })}
            </div>
          </DndContext>
        ) : (
          <p className="talk-context-empty">No rules yet.</p>
        )}
        {canEdit ? (
          <div className="talk-rule-create-row">
            <label className="talk-context-field talk-context-field-fill">
              <span className="sr-only">New rule text</span>
              <Textarea
                maxLength={800}
                rows={2}
                value={newRuleText}
                onChange={(e) => setNewRuleText(e.target.value)}
                placeholder="e.g. When summarizing Cal Football news, use: ⟨headline⟩ — ⟨score⟩ — three bullets of key plays."
                disabled={status.status === 'saving'}
                className="talk-context-textarea talk-context-rule-textarea"
              />
            </label>
            <Button
              variant="secondary"
              onClick={() => void handleAddRule()}
              disabled={status.status === 'saving' || !newRuleText.trim()}
            >
              Add Rule
            </Button>
          </div>
        ) : null}
      </section>
    </>
  );
}
