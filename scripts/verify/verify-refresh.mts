/**
 * Does the stored refresh token still mint access tokens?
 *
 * Performs ONE real refresh, which spends the refresh token: if CookUnity rotates them, the
 * response carries a new one and it is saved immediately. Prints derived facts only
 * (success, new expiry, whether rotation happened, file modes) — never a token value.
 * Read-only against the account; the only writes are the two local token files.
 *
 *   COOKUNITY_REFRESH_TOKEN_FILE=... npm run verify:refresh
 */
import fs from "fs";
import { CookUnityAuth } from "../../src/services/auth.js";
import { CookUnityAPI } from "../../src/services/api.js";
import { isPlausibleRefreshToken } from "../../src/services/token-store.js";
import { looksLikeJwt } from "./_shared.mts";

// No .token fallback: a refresh writes a live access token, and the fallback is inside the repo.
const tokenFile = process.env.COOKUNITY_TOKEN_FILE;
const refreshTokenFile = process.env.COOKUNITY_REFRESH_TOKEN_FILE;

function describeFile(label: string, file: string): void {
  const stat = fs.statSync(file);
  const mode = stat.mode & 0o777;
  console.log(`${label.padEnd(14)}: ${file} (mode ${mode.toString(8)}${(mode & 0o077) !== 0 ? " <-- chmod 600" : ""}, modified ${stat.mtime.toLocaleString()})`);
}

if (!tokenFile) {
  console.log("STATUS: NOT CONFIGURED — set COOKUNITY_TOKEN_FILE (outside the repo; renewed access tokens are written there).");
  process.exit(2);
}
if (!refreshTokenFile) {
  console.log("STATUS: NOT CONFIGURED — set COOKUNITY_REFRESH_TOKEN_FILE (load it with scripts/load-refresh-token.sh).");
  process.exit(2);
}
if (!fs.existsSync(refreshTokenFile)) {
  console.log(`STATUS: MISSING — ${refreshTokenFile} does not exist. Run scripts/load-refresh-token.sh.`);
  process.exit(2);
}
// Shape check on the raw bytes, without printing them.
const shapeOk = isPlausibleRefreshToken(fs.readFileSync(refreshTokenFile, "utf8").trim());
describeFile("refresh file", refreshTokenFile);
console.log(`shape plausible: ${shapeOk}`);
if (!shapeOk) {
  console.log("STATUS: BAD SHAPE — file does not hold a v1. refresh token. Run scripts/load-refresh-token.sh.");
  process.exit(2);
}

const auth = new CookUnityAuth({ tokenFile, refreshTokenFile });
let result;
try {
  result = await auth.refresh({ force: true });
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown error";
  console.log(`\nSTATUS: REFRESH FAILED — ${looksLikeJwt(message) ? "(message withheld: looked like a token)" : message}`);
  process.exit(3);
}

const minutes = Math.round((result.expiresAt - Date.now()) / 60000);
console.log(`new expiry    : ${new Date(result.expiresAt).toLocaleString()} (${minutes} min from now)`);
console.log(`rotated       : ${result.refreshTokenRotated ? "yes — a different refresh token came back and was saved" : "no — the server returned no new refresh token, or the same one"}`);
describeFile("refresh file", refreshTokenFile);
describeFile("token file", tokenFile);

// Prove the new access token is accepted, not just minted. Read-only call.
try {
  const days = await new CookUnityAPI({ tokenFile, refreshTokenFile }).getUpcomingDays();
  console.log(`\nSTATUS: WORKING — refreshed token accepted, ${days.length} delivery slots`);
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown error";
  console.log(`\nSTATUS: MINTED BUT REJECTED — ${looksLikeJwt(message) ? "(message withheld: looked like a token)" : message}`);
  process.exit(3);
}
