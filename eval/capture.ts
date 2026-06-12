import { runLiveCaptureCli } from '../src/clawtalk/eval/live-capture.js';

try {
  const exitCode = await runLiveCaptureCli(process.argv.slice(2));
  process.exit(exitCode);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
