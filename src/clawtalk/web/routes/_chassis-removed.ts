import type { ApiEnvelope } from '../types.js';

const GONE: ApiEnvelope<Record<string, unknown>> = {
  ok: false,
  error: {
    code: 'feature_removed',
    message:
      'This feature was removed with the ClawTalk chassis purge. Talk-only product is supported.',
  },
};

type ChassisRemovedResult = {
  body: ApiEnvelope<Record<string, unknown>>;
  statusCode: number;
  noStore?: boolean;
  // Permissive: server.ts route handlers branch on optional fields
  // (cancelledRunning, wakeTalk, wakeMain, workspace, etc.) that we never
  // produce. Leaving them on the return type as undefined keeps the call
  // sites compiling while always taking the no-op branch at runtime.
  cancelledRunning?: never[];
  wakeTalk?: false;
  wakeMain?: false;
  workspace?: undefined;
};

export function chassisRemovedRoute(..._args: unknown[]): ChassisRemovedResult {
  return { body: GONE, statusCode: 410, noStore: true };
}

export async function chassisRemovedRouteAsync(
  ..._args: unknown[]
): Promise<ChassisRemovedResult> {
  return { body: GONE, statusCode: 410, noStore: true };
}
