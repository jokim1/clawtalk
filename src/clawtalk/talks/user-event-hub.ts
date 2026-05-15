// UserEventHub — per-user Durable Object that holds hibernating WebSocket
// connections and drains outbox notifies into live frames.
//
// U1 scaffold only — fetch routes /health to 200 and rejects everything
// else as 404. webSocketMessage / webSocketClose are no-ops. U3 fills in
// the upgrade path, hibernation attachment, /notify drain, and replay.

interface DurableObjectState {
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  storage: {
    get<T = unknown>(key: string): Promise<T | null>;
    put(key: string, value: unknown): Promise<void>;
    setAlarm(when: number | Date): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
}

export interface UserEventHubEnv {
  DB_EVENT_HUB_URL?: string;
}

export class UserEventHub {
  // U3 will use these; U1 keeps them to lock the constructor shape.
  private state: DurableObjectState;
  private env: UserEventHubEnv;

  constructor(state: DurableObjectState, env: UserEventHubEnv) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }

  async webSocketMessage(
    _ws: WebSocket,
    _message: string | ArrayBuffer,
  ): Promise<void> {}

  async webSocketClose(
    _ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {}
}
