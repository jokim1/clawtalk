import path from 'path';

const PROJECT_ROOT = process.cwd();

export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');

export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
