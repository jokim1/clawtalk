export type UserRole = 'owner' | 'admin' | 'member';
export type UserType = 'human' | 'system';
export type TalkAccessRole = 'viewer' | 'editor';
export type TalkMessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type TalkRunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_confirmation'
  | 'cancelled'
  | 'completed'
  | 'failed';
