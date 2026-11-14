import fs from "fs";
import path from "path";
import {
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
  if (!isRefreshTokenShape(value)) {
    throw new Error(
      `Refresh token file ${file} does not hold a refresh token (expected a v1.-prefixed string). Run scripts/load-refresh-token.sh.`
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
    fs.writeFileSync(tmp, content, { mode: SECRET_FILE_MODE });
    // writeFileSync's mode is masked by umask and ignored if the file existed.
    fs.chmodSync(tmp, SECRET_FILE_MODE);
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`Could not write ${file}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}
