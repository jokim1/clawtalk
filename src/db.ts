import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { STORE_DIR } from './config.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized');
  }
  return db;
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'clawtalk.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
}

export function _initTestDatabase(): void {
  db = new Database(':memory:');
}

export function isDatabaseHealthy(): boolean {
  if (!db) return false;
  try {
    const row = db.prepare('SELECT 1 AS ok').get() as { ok: number };
    return row.ok === 1;
  } catch {
    return false;
  }
}
