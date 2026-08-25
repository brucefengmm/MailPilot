/**
 * Factory for creating background interval checkers.
 * Provides consistent start/stop/error handling for periodic tasks.
 */
import { isBulkWriteMode } from "./db/bulkWrite";

export interface BackgroundChecker {
  start(): void;
  stop(): void;
}

export function createBackgroundChecker(
  name: string,
  checkFn: () => Promise<void>,
  intervalMs: number = 60_000,
): BackgroundChecker {
  let interval: ReturnType<typeof setInterval> | null = null;

  const run = async () => {
    if (isBulkWriteMode()) return;
    try {
      await checkFn();
    } catch (err) {
      console.error(`[${name}] check failed:`, err);
    }
  };

  return {
    start() {
      if (interval) return;
      run();
      interval = setInterval(run, intervalMs);
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },
  };
}
