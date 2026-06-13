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
    };
  }
  interface TestDoStub {
    fetch(input: string, init?: RequestInit): Promise<Response>;
  }
  interface TestDoNamespace {
    idFromName(name: string): unknown;
    get(id: unknown): TestDoStub;
  }

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
