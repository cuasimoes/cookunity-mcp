import fs from "fs";
import path from "path";
import {
  REFRESH_LOCK_POLL_MS,
  REFRESH_LOCK_STALE_MS,
  REFRESH_LOCK_WAIT_MS,
  REFRESH_TOKEN_MAX_LENGTH,
  REFRESH_TOKEN_MIN_LENGTH,
  REFRESH_TOKEN_PATTERN,
  SECRET_FILE_MODE,
} from "../constants.js";

/** True when `value` has the shape of an Auth0 refresh token. Never echoes the value. */
export function isRefreshTokenShape(value: string): boolean {
  return (
    value.length >= REFRESH_TOKEN_MIN_LENGTH &&
    value.length <= REFRESH_TOKEN_MAX_LENGTH &&
    REFRESH_TOKEN_PATTERN.test(value)
  );
}

/**
 * Loose check for a token we are about to store or re-read. A rotated token from the server
 * is saved whatever its shape: refusing it would discard the only valid link in the chain.
 */
export function isPlausibleRefreshToken(value: string): boolean {
  return value.length > 0 && value.length <= REFRESH_TOKEN_MAX_LENGTH && !/\s/.test(value);
}

/**
 * Read the refresh token, refusing anything that is not shaped like one.
 * Error messages name the file, never its contents.
 */
export function readRefreshToken(file: string): string {
  if (!fs.existsSync(file)) {
    throw new Error(
      `Refresh token file not found: ${file}. Copy the refresh token from the browser and run scripts/load-refresh-token.sh.`
    );
  }
  const value = fs.readFileSync(file, "utf-8").trim();
  if (!isPlausibleRefreshToken(value)) {
    throw new Error(
      `Refresh token file ${file} does not hold a refresh token (empty, too long or contains whitespace). Run scripts/load-refresh-token.sh.`
    );
  }
  return value;
}

/**
 * Replace `file` atomically with mode 600.
 *
 * Temp file in the same directory, then rename: a crash mid-write must never leave a
 * truncated token, and for the refresh token a lost update breaks the rotation chain.
 */
export function writeSecretFile(file: string, content: string): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    // "wx": never write through a stale file or a symlink planted at the temp path.
    fs.rmSync(tmp, { force: true });
    const fd = fs.openSync(tmp, "wx", SECRET_FILE_MODE);
    try {
      fs.writeSync(fd, content);
      // Without fsync a power loss can leave an empty file after the rename, which for the
      // refresh token ends the chain.
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // The open mode is masked by umask.
    fs.chmodSync(tmp, SECRET_FILE_MODE);
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`Could not write ${file}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` while holding an exclusive lockfile, so concurrent server processes (every Claude
 * session spawns its own) don't spend one rotating refresh token twice. A lock older than
 * REFRESH_LOCK_STALE_MS is assumed to belong to a crashed process and is taken over.
 */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + REFRESH_LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockPath, "wx", SECRET_FILE_MODE));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error(`Could not take refresh lock ${lockPath}: ${(error as Error).message}`);
      }
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > REFRESH_LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue; // lock vanished between open and stat: retry immediately
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for refresh lock ${lockPath}; delete it if no other server is running.`);
      }
      await sleep(REFRESH_LOCK_POLL_MS);
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}
