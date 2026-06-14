import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeadlineBudget, DEADLINE_BUDGET_TOTAL_MS } from './deadline-budget.js';

// Work that only settles when its signal aborts — mirrors an abortable fetch
// that hangs until the deadline (or an upstream cancel) cuts it off.
function hangUntilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason));
  });
}

describe('DeadlineBudget', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves a fast call to its value without arming a lasting timer', async () => {
    const budget = new DeadlineBudget({
      totalMs: 60_000,
      defaultStepMs: 20_000,
    });
    await expect(budget.bound('x', () => Promise.resolve(42))).resolves.toBe(
      42,
    );
  });

  it('remainingMs decreases with the clock and floors at zero', () => {
    let clock = 0;
    const budget = new DeadlineBudget({
      totalMs: 100,
      defaultStepMs: 20,
      now: () => clock,
    });
    expect(budget.remainingMs()).toBe(100);
    clock = 40;
    expect(budget.remainingMs()).toBe(60);
    clock = 250;
    expect(budget.remainingMs()).toBe(0);
  });

  it('throws DeadlineBudgetExceededError carrying the label when a step deadline fires', async () => {
    vi.useFakeTimers();
    const budget = new DeadlineBudget({
      totalMs: 60_000,
      defaultStepMs: 20_000,
    });
    // Attach the rejection handler BEFORE advancing timers, or the rejection
    // surfaces as an unhandled error during the timer flush.
    const assertion = expect(
      budget.bound('web_search', hangUntilAborted, { stepMs: 30 }),
    ).rejects.toMatchObject({
      name: 'DeadlineBudgetExceededError',
      label: 'web_search',
      kind: 'step',
      deadlineMs: 30,
    });
    await vi.advanceTimersByTimeAsync(30);
    await assertion;
  });

  it('caps a step at the remaining run total and reports kind="total"', async () => {
    vi.useFakeTimers();
    let clock = 0;
    const budget = new DeadlineBudget({
      totalMs: 100,
      defaultStepMs: 20_000,
      now: () => clock,
    });
    clock = 95; // 95ms consumed → 5ms left on the run total
    // stepMs (20s) is far larger than the 5ms remaining, so the total wins.
    const assertion = expect(
      budget.bound('llm', hangUntilAborted, { stepMs: 20_000 }),
    ).rejects.toMatchObject({ kind: 'total', deadlineMs: 5 });
    await vi.advanceTimersByTimeAsync(5);
    await assertion;
  });

  it('rethrows the upstream cancel reason (not a budget error) when the caller aborts first', async () => {
    const budget = new DeadlineBudget({
      totalMs: 60_000,
      defaultStepMs: 20_000,
    });
    const controller = new AbortController();
    // 'cancelled' (a plain string) is distinct from DeadlineBudgetExceededError,
    // so toBe also proves cancel precedence over the budget deadline.
    const assertion = expect(
      budget.bound('web_search', hangUntilAborted, {
        stepMs: 20_000,
        signal: controller.signal,
      }),
    ).rejects.toBe('cancelled');
    controller.abort('cancelled');
    await assertion;
  });

  it('propagates a non-deadline rejection unchanged', async () => {
    const budget = new DeadlineBudget({
      totalMs: 60_000,
      defaultStepMs: 20_000,
    });
    await expect(
      budget.bound('x', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
  });

  it('keeps the real error identity when a non-deadline rejection arrives after the timer armed', async () => {
    vi.useFakeTimers();
    const budget = new DeadlineBudget({
      totalMs: 60_000,
      defaultStepMs: 20_000,
    });
    // Work that IGNORES the deadline signal (like a non-cancellable postgres
    // query) and then rejects with its OWN error AFTER the budget timer fired.
    // bound() must not mask it as a DeadlineBudgetExceededError.
    const work = () =>
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('real db statement_timeout')), 50);
      });
    const assertion = expect(
      budget.bound('db_read', work, { stepMs: 10 }),
    ).rejects.toThrow('real db statement_timeout');
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it('fails synchronously WITHOUT starting work when the budget is already exhausted', async () => {
    // remainingMs() === 0 → deadlineMs 0. The next-tick abort would otherwise
    // let work() open a DB tx / queue a fetch first (reachable inside a T5
    // parallel tool batch). bound() must reject before ever calling work().
    const budget = new DeadlineBudget({ totalMs: 0, defaultStepMs: 20_000 });
    const work = vi.fn(() => Promise.resolve('ran'));
    await expect(
      budget.bound('web_search', work, { stepMs: 20_000 }),
    ).rejects.toMatchObject({
      name: 'DeadlineBudgetExceededError',
      kind: 'total',
    });
    expect(work).not.toHaveBeenCalled();
  });

  it('lets cancel win even when the budget is also exhausted', async () => {
    const budget = new DeadlineBudget({ totalMs: 0, defaultStepMs: 20_000 });
    const controller = new AbortController();
    controller.abort('cancelled');
    const work = vi.fn(() => Promise.resolve('ran'));
    await expect(
      budget.bound('web_search', work, {
        stepMs: 20_000,
        signal: controller.signal,
      }),
    ).rejects.toBe('cancelled');
    expect(work).not.toHaveBeenCalled();
  });

  it('hands work a signal that aborts on the deadline', async () => {
    vi.useFakeTimers();
    const budget = new DeadlineBudget({
      totalMs: 60_000,
      defaultStepMs: 20_000,
    });
    let captured: AbortSignal | undefined;
    const promise = budget
      .bound(
        'x',
        (signal) => {
          captured = signal;
          return hangUntilAborted(signal);
        },
        { stepMs: 30 },
      )
      .catch(() => 'rejected');
    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(30);
    expect(captured?.aborted).toBe(true);
    await expect(promise).resolves.toBe('rejected');
  });

  it('exports a run total below the queue watchdog (10 min) so the graceful path wins', () => {
    expect(DEADLINE_BUDGET_TOTAL_MS).toBeLessThan(10 * 60 * 1000);
  });
});

describe('deadline timer grep gate', () => {
  it('keeps every deadline setTimeout inside the DeadlineBudget primitive (run watchdog excepted)', () => {
    const talksDir = path.dirname(fileURLToPath(import.meta.url));
    // Expected code-line `setTimeout(` count per file. Every entry is a
    // NON-deadline timer (debounce, source-fetch abort, mock sleep, DO RPC
    // timeout, teardown join) or the sanctioned run watchdog. The #608/#609
    // homes — new-executor.ts and greenfield-executor.ts — must hold ZERO, and
    // deadline-budget.ts holds exactly ONE (the primitive's armed timer). A
    // re-introduced bare deadline timer pushes a file off its count and fails.
    const ALLOWED: Record<string, number> = {
      'deadline-budget.ts': 1, // the ONLY deadline timer in talks/
      'queue-consumer.ts': 3, // run watchdog (sanctioned) + poller join + sleepUntil
      'streaming-notify.ts': 1, // debounce
      'source-ingestion.ts': 2, // source-fetch abort timers
      'mock-executor.ts': 1, // mock sleep
      'user-event-hub.ts': 1, // DO RPC timeout
      // PR-B: bounded-retry BACKOFF sleep for the write-behind terminal flush —
      // a delay between retries, NOT a deadline race over DB-owning work (the
      // #608/#609 trap). The terminal persist's bound is the alarm/retry budget.
      'talk-runner-write-behind.ts': 1,
    };

    const offenders: string[] = [];
    // Recursive so a deadline timer can't hide in a future talks/ subdir; the
    // regex tolerates `setTimeout (` whitespace and matches `globalThis.setTimeout(`.
    const entries = readdirSync(talksDir, { recursive: true }) as string[];
    for (const entry of entries) {
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
      const codeLines = readFileSync(path.join(talksDir, entry), 'utf8')
        .split('\n')
        .filter((line) => {
          const trimmed = line.trim();
          // Skip whole-line comments so prose mentions of setTimeout don't count.
          return (
            !trimmed.startsWith('//') &&
            !trimmed.startsWith('*') &&
            !trimmed.startsWith('/*')
          );
        })
        .join('\n');
      const count = (codeLines.match(/setTimeout\s*\(/g) ?? []).length;
      const expected = ALLOWED[path.basename(entry)] ?? 0;
      if (count !== expected) {
        offenders.push(
          `${entry}: ${count} setTimeout( call(s), expected ${expected}`,
        );
      }
    }

    expect(
      offenders,
      `Deadline timers belong in deadline-budget.ts via budget.bound(); only the queue run watchdog is exempt.\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
