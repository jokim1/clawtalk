import {
  _initTestDatabase as _initCoreTestDatabase,
  isDatabaseHealthy,
} from '../../db.js';
import { _initClawtalkTestSchema } from './init.js';

export { _initClawtalkTestSchema, initClawtalkSchema } from './init.js';
export * from './accessors.js';
export * from './agent-accessors.js';
export * from './context-accessors.js';
export * from './job-accessors.js';
export * from './output-accessors.js';
export * from './talk-tools-accessors.js';
export { isDatabaseHealthy };

/** @internal - for tests only. Initializes core + clawtalk schemas. */
export function _initTestDatabase(): void {
  _initCoreTestDatabase();
  _initClawtalkTestSchema();
}
