// Replacing a file by renaming a finished copy over it, so a reader sees the old content or the new, never part.
import { renameSync } from "node:fs";

const BUSY = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * Renames `from` over `to`. Windows refuses while another process has `to` open, as a hook reading the same
 * state can for a moment, so a busy target is retried for up to about a second before the error is thrown.
 */
export function renameOver(
  from: string,
  to: string,
  platform: NodeJS.Platform = process.platform,
): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      if (
        platform !== "win32" ||
        attempt >= 20 ||
        !BUSY.has((error as NodeJS.ErrnoException).code ?? "")
      ) {
        throw error;
      }
      Bun.sleepSync(50);
    }
  }
}
