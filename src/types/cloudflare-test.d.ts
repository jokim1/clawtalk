// Compile-time shim for the `cloudflare:test` module that
// @cloudflare/vitest-pool-workers injects at runtime in workerd. Repo
// convention is local CF type shims (see user-event-hub.ts) rather than
// pulling @cloudflare/workers-types repo-wide; this declares only the surface
// the TalkRunner workers smoke test uses. The real implementation is provided
// by the pool at test runtime — these types are never executed.
declare module 'cloudflare:test' {
  interface TestSqlCursor {
    toArray(): Array<Record<string, unknown>>;
    one(): Record<string, unknown>;
    readonly rowsWritten: number;
    readonly rowsRead: number;
  }
  interface TestDurableObjectState {
    storage: {
      sql: {
        exec(query: string, ...bindings: unknown[]): TestSqlCursor;
      };
      // Alarm API (A2): the workers pool backs these with real workerd storage,
      // so a test can assert the armed alarm == min(deadline) and fire it.
      getAlarm(): Promise<number | null>;
      setAlarm(when: number | Date): Promise<void>;
      deleteAlarm(): Promise<void>;
    };
  }
  interface TestDoStub {
    fetch(input: string, init?: RequestInit): Promise<Response>;
  }
  interface TestDoNamespace {
    idFromName(name: string): unknown;
    get(id: unknown): TestDoStub;
  }

  // Immediately runs (and removes) the DO's scheduled alarm if one is set,
  // invoking its alarm() handler. Returns whether an alarm ran. Used to drive
  // the 1A watchdog without waiting real wall-clock for a deadline to pass.
  export function runDurableObjectAlarm(stub: TestDoStub): Promise<boolean>;

  // Bindings from the test worker (vitest.workers.config.ts).
  export const env: {
    TALK_RUNNER: TestDoNamespace;
    [key: string]: unknown;
  };

  // Runs `callback` inside the DO's isolate with direct access to the live
  // instance and its storage. Inline import() keeps this file a pure ambient
  // declaration (no top-level import → no module augmentation surprises).
  export function runInDurableObject<R>(
    stub: unknown,
    callback: (
      instance: import('../clawtalk/talks/talk-runner.js').TalkRunner,
      state: TestDurableObjectState,
    ) => R | Promise<R>,
  ): Promise<R>;
}
