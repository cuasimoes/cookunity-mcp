/**
 * Is the configured token usable right now?
 *
 * Distinguishes the three states that look identical from a failing tool call: file missing,
 * locally expired, and accepted-locally-but-rejected-by-the-server (a revocation). Prints the
 * expiry and the call result only — never the token.
 *
 *   npm run verify:token
 */
import fs from "fs";
import { CookUnityAuth } from "../../src/services/auth.js";
import { CookUnityAPI } from "../../src/services/api.js";
import { getNextMonday } from "../../src/services/helpers.js";
import { resolveTokenPath } from "./_shared.mts";

const tokenFile = resolveTokenPath();

if (!fs.existsSync(tokenFile)) {
  console.log(`token file : ${tokenFile}`);
  console.log("\nSTATUS: MISSING — harvest a token and save it to that path (see README).");
  process.exit(2);
}

const stat = fs.statSync(tokenFile);
console.log(`token file : ${tokenFile}`);
console.log(`modified   : ${stat.mtime.toLocaleString()}`);
console.log(`mode       : ${(stat.mode & 0o777).toString(8)}${(stat.mode & 0o077) !== 0 ? "  <-- readable by other users, chmod 600" : ""}`);

const auth = new CookUnityAuth({ tokenFile });
try {
  await auth.getAccessToken();
} catch (error) {
  console.log(`\nSTATUS: UNUSABLE — ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const { expires_at: expiresAt } = (auth as unknown as { tokens: { expires_at: number } }).tokens;
const minutesLeft = Math.round((expiresAt - Date.now()) / 60000);
console.log(`expires    : ${new Date(expiresAt).toLocaleString()} (${minutesLeft} min from now)`);

// The local exp claim only proves the token has not aged out; the server can still refuse it.
const api = new CookUnityAPI({ tokenFile });
try {
  const menu = await api.getMenu(getNextMonday());
  console.log(`\nSTATUS: WORKING — live call returned ${menu.meals.length} meals`);
} catch (error) {
  console.log(`\nSTATUS: REJECTED BY SERVER — ${error instanceof Error ? error.message : String(error)}`);
  console.log("The exp claim is still in the future, so this is a revocation rather than expiry.");
  process.exit(3);
}
