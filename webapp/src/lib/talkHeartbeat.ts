// Keep PING/PONG in sync with src/clawtalk/talks/user-event-hub.ts.
export const TALK_HEARTBEAT_PING = 'clawtalk:ping';
export const TALK_HEARTBEAT_PONG = 'clawtalk:pong';

export const HEARTBEAT_INTERVAL_MS = 20_000;
export const HEARTBEAT_TIMEOUT_MS = 50_000;
