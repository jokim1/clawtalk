/**
 * DeadlineBudget — the single run-scoped deadline primitive for the Talk
 * runtime (docs/13-talk-runtime-v2.md §P1-c). It absorbs the ad-hoc 20s
 * web_search fetch timer (#608) and the 30s tool-call deadline (#609) so the
 * runtime has one place that owns "how long may an external await run".
 *
 * RAIL (10c): `bound()` NEVER uses `Promise.race`. Racing a timer against a
 * promise and abandoning the loser is the #609 COMMIT-wedge trap: a postgres.js
 * BEGIN/SELECT/COMMIT is not cancellable, so abandoning it leaks the run's
 * max:1 connection. Instead `bound()` arms ONE AbortController + setTimeout
 * (the only deadline timer allowed in talks/ outside the queue watchdog),
 * threads the signal into the work, and `await`s it directly:
 *   - Abortable I/O (provider fetch) honors the signal and rejects cleanly.
 *   - DB-owning work cannot honor the signal. A RUNNING query self-bounds via
 *     the tx's statement_timeout; a wedged CONNECTION ACQUISITION (db.begin on
 *     a dead pooled connection — not a running statement, so statement_timeout
 *     does not cover it) is left to the queue-consumer 10-min run watchdog (the
 *     sanctioned, unabsorbed escape hatch). `bound()` never abandons either, so
 *     it can never wedge on a COMMIT.
 */

/**
 * Run-scoped wall-clock ceiling for a single Talk run's external awaits. It is
 * the GRACEFUL ceiling: a tool-loop step boundary or a budget-bounded tool leg
 * that trips it surfaces a labeled tool error (or a clean deadline failure) and
 * the run finishes on its own connection. It MUST stay strictly below the
 * queue-consumer run watchdog (DEFAULT_RUN_WATCHDOG_MS, 10 min) so the graceful
 * path wins there before the watchdog's hard, detached-connection fail. Note it
 * bounds tool legs and round transitions, NOT a single in-flight LLM generation
 * (that is still the watchdog's job). Generous on purpose — a real run spends
 * seconds of external-await time, so this only ever catches a wedged/dead run.
 */
export const DEADLINE_BUDGET_TOTAL_MS = 9 * 60 * 1000;

/** Thrown by `bound()` when the budget deadline (not an upstream cancel) fired. */
export class DeadlineBudgetExceededError extends Error {
  readonly label: string;
  readonly kind: 'step' | 'total';
  readonly deadlineMs: number;

  constructor(label: string, kind: 'step' | 'total', deadlineMs: number) {
    super(
      `${label} exceeded its ${kind} deadline of ${Math.round(deadlineMs)}ms`,
    );
    this.name = 'DeadlineBudgetExceededError';
    this.label = label;
    this.kind = kind;
    this.deadlineMs = deadlineMs;
  }
}

export interface DeadlineBudgetOptions {
  /** Run-scoped wall-clock ceiling shared across every bound()/lease in a run. */
  totalMs: number;
  /** Per-step cap applied when a caller omits its own. */
  defaultStepMs: number;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}

export interface BoundOptions {
  /** Per-step cap for THIS leg; falls back to defaultStepMs. */
  stepMs?: number;
  /**
   * Run/cancel signal. Combined (AbortSignal.any) with the budget's deadline
   * signal so a user cancel still aborts the work and takes precedence over a
   * deadline in the error classification.
   */
  signal?: AbortSignal;
}

export class DeadlineBudget {
  private readonly totalMs: number;
  private readonly defaultStepMs: number;
  private readonly now: () => number;
  private readonly startedAt: number;

  constructor(options: DeadlineBudgetOptions) {
    this.totalMs = options.totalMs;
    this.defaultStepMs = options.defaultStepMs;
    this.now = options.now ?? (() => Date.now());
    this.startedAt = this.now();
  }

  /** Milliseconds left on the run-scoped total (never negative). */
  remainingMs(): number {
    return Math.max(0, this.totalMs - (this.now() - this.startedAt));
  }

  /**
   * Run `work(signal)` under a deadline of `min(stepMs, remainingMs())`.
   * NEVER races: `work` must honor `signal` (abortable I/O) or self-bound
   * (DB statement_timeout). Throws DeadlineBudgetExceededError when the budget
   * deadline fired; rethrows the upstream-cancel reason unchanged when the
   * caller's signal won the race to abort (cancel takes precedence).
   */
  async bound<T>(
    label: string,
    work: (signal: AbortSignal) => Promise<T>,
    opts: BoundOptions = {},
  ): Promise<T> {
    const armed = this.armStep(opts.stepMs ?? this.defaultStepMs, opts.signal);
    // Exhausted budget: never even START the work. The deadline timer fires
    // next-tick, but work() runs synchronously up to its first await — long
    // enough to open a credential tx / queue a fetch the deadline can't unwind.
    // Fail synchronously instead (relevant inside a T5 parallel tool batch,
    // where there is no per-call step-boundary guard above this).
    if (armed.deadlineMs <= 0) {
      armed.dispose();
      // Cancel still wins on an exhausted budget: a user who already cancelled
      // gets their cancel reason, not a deadline error.
      if (opts.signal?.aborted) {
        throw opts.signal.reason;
      }
      throw new DeadlineBudgetExceededError(
        label,
        armed.kind,
        armed.deadlineMs,
      );
    }
    try {
      return await work(armed.signal);
    } catch (err) {
      // Cancel wins: a user cancel is never a budget deadline, so propagate
      // its reason unchanged (checked first, before the deadline branch, so a
      // same-tick deadline/cancel tie can't misreport a cancel as a deadline).
      if (opts.signal?.aborted) {
        throw err;
      }
      // Relabel ONLY when the rejection IS our deadline abort — not merely
      // "our timer fired at some point". A leg that ignored the signal and
      // then failed for another reason (e.g. a real DB statement_timeout) must
      // keep its own identity, never get masked as a budget timeout.
      if (
        armed.controller.signal.aborted &&
        err === armed.controller.signal.reason
      ) {
        throw new DeadlineBudgetExceededError(
          label,
          armed.kind,
          armed.deadlineMs,
        );
      }
      throw err;
    } finally {
      armed.dispose();
    }
  }

  /**
   * Arm one AbortController + setTimeout for `min(stepMs, remainingMs())`,
   * combined with `upstream`. This is the ONLY deadline setTimeout in talks/
   * outside the sanctioned queue-consumer run watchdog.
   */
  private armStep(
    stepMs: number,
    upstream?: AbortSignal,
  ): {
    signal: AbortSignal;
    controller: AbortController;
    kind: 'step' | 'total';
    deadlineMs: number;
    dispose: () => void;
  } {
    const remaining = this.remainingMs();
    // The run-scoped total wins when it is the tighter ceiling.
    const kind: 'step' | 'total' = remaining <= stepMs ? 'total' : 'step';
    const deadlineMs = Math.max(0, Math.min(stepMs, remaining));
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(
        new DOMException(
          `deadline of ${Math.round(deadlineMs)}ms exceeded`,
          'TimeoutError',
        ),
      );
    }, deadlineMs);
    const signal = upstream
      ? AbortSignal.any([upstream, controller.signal])
      : controller.signal;
    return {
      signal,
      controller,
      kind,
      deadlineMs,
      dispose: () => clearTimeout(timer),
    };
  }
}
