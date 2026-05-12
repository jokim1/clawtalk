import { UserRole } from '../types.js';

export interface ApiErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiFailure {
  ok: false;
  error: ApiErrorPayload;
}

export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;

export interface AuthContext {
  sessionId: string;
  userId: string;
  role: UserRole;
  authType: 'cookie' | 'bearer';
}

export interface RequestContext {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  bodyText: string;
}
