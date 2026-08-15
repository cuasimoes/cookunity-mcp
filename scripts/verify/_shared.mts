import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(HERE, "../..");

export function resolveTokenPath(): string {
  return process.env.COOKUNITY_TOKEN_FILE ?? path.join(REPO_ROOT, ".token");
}

/**
 * Read the access token from disk.
 *
 * Never parse-then-rethrow here: a JSON SyntaxError echoes part of the input it choked on,
 * and the input is a live bearer credential. Check the shape first, and replace any parse
 * failure with a message that names the file instead of quoting its contents.
 */
export function loadToken(tokenPath: string = resolveTokenPath()): string {
  const raw = fs.readFileSync(tokenPath, "utf8").trim();
  if (!raw) throw new Error(`Token file is empty: ${tokenPath}`);
  if (!raw.startsWith("{")) return raw.replace(/^bearer\s+/i, "").trim();
  let parsed: { access_token?: string; accessToken?: string; tokens?: { access_token?: string } };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Token file at ${tokenPath} looks like JSON but could not be parsed`);
  }
  const token = parsed.access_token ?? parsed.tokens?.access_token ?? parsed.accessToken;
  if (typeof token !== "string" || !token) {
    throw new Error(`Token file at ${tokenPath} parsed but contains no access_token`);
  }
  return token;
}

/** Fails the run if a token ever reaches stdout/stderr through some path we did not anticipate. */
export function looksLikeJwt(text: string): boolean {
  return /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(text);
}

export function makeCheck() {
  let failures = 0;
  const check = (label: string, ok: boolean, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures += 1;
  };
  const done = (): never => {
    console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
    process.exit(failures === 0 ? 0 : 1);
  };
  return { check, done };
}
