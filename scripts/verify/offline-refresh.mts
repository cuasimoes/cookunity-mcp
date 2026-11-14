/**
 * Offline check of the refresh logic: axios.post is stubbed, fake tokens only, no network,
 * no real token files. Covers the cases a live run can't reproduce on demand.
 *
 *   npm run verify:refresh-offline
 */
import fs from "fs";
import os from "os";
import path from "path";
import axios, { AxiosError } from "axios";
import { CookUnityAuth } from "../../src/services/auth.js";
import { CookUnityAPI } from "../../src/services/api.js";
import { makeCheck } from "./_shared.mts";

const { check, done } = makeCheck();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cu-refresh-"));
const tokenFile = path.join(dir, "token");
const refreshFile = path.join(dir, "refresh");
const OLD_RT = "v1." + "a".repeat(60);
const jwt = (expSec: number) => "h." + Buffer.from(JSON.stringify({ exp: expSec })).toString("base64url") + ".s";
const future = () => jwt(Math.floor(Date.now() / 1000) + 86400);
const read = (f: string) => fs.readFileSync(f, "utf8");

type Reply = { access_token?: string; refresh_token?: string } | Error;
let reply: Reply = {};
let calls = 0;
const post = async (url: string, body: Record<string, unknown>) => {
  if (url.endsWith("/oauth/token")) {
    calls += 1;
    await new Promise((r) => setTimeout(r, 20));
    if (reply instanceof Error) throw reply;
    return { data: reply };
  }
  return graphql(url, body);
};
let graphql: (url: string, body: Record<string, unknown>) => Promise<unknown> = async () => ({ data: { data: {} } });
(axios as unknown as { post: typeof post }).post = post;

function reset(access: string, refresh = OLD_RT) {
  fs.rmSync(`${refreshFile}.lock`, { force: true });
  fs.writeFileSync(tokenFile, access);
  fs.writeFileSync(refreshFile, refresh);
  calls = 0;
}
const mk = () => new CookUnityAuth({ tokenFile, refreshTokenFile: refreshFile });

// Rotation + single-flight + modes
reset(jwt(1));
const NEW_RT = "v1." + "n".repeat(60);
reply = { access_token: future(), refresh_token: NEW_RT };
const a = mk();
const [t1, t2] = await Promise.all([a.getAccessToken(), a.getAccessToken()]);
check("single-flight: one request for parallel calls", calls === 1 && t1 === t2);
check("rotated refresh token saved", read(refreshFile) === NEW_RT);
check("access token saved, files mode 600", read(tokenFile) === t1 && (fs.statSync(tokenFile).mode & 0o777) === 0o600 && (fs.statSync(refreshFile).mode & 0o777) === 0o600);
check("no temp or lock files left", fs.readdirSync(dir).sort().join() === "refresh,token");

// Blocker 1: access token undecodable, rotated refresh token must still be saved
reset(jwt(1));
reply = { access_token: "not-a-jwt", refresh_token: NEW_RT };
await mk().getAccessToken().then(() => check("undecodable access token throws", false), () => check("undecodable access token throws", true));
check("blocker 1: rotated refresh token saved despite decode failure", read(refreshFile) === NEW_RT);

// Blocker 2: unexpected-shaped rotated token is saved and reported as rotated
for (const odd of ["no-prefix-" + "x".repeat(50), "v2." + "y".repeat(60)]) {
  reset(jwt(1));
  reply = { access_token: future(), refresh_token: odd };
  const r = await mk().refresh({ force: true });
  check("blocker 2: odd-shaped rotated token saved + rotated=true", read(refreshFile) === odd && r.refreshTokenRotated);
}
reset(jwt(1));
reply = { access_token: future(), refresh_token: OLD_RT };
check("same token returned => rotated=false", !(await mk().refresh({ force: true })).refreshTokenRotated);
reply = { access_token: future() };
check("no refresh token returned => rotated=false, file untouched", !(await mk().refresh({ force: true })).refreshTokenRotated && read(refreshFile) === OLD_RT);

// Error message: OAuth code, no token
const err = Object.assign(new AxiosError("x"), { response: { status: 403, data: { error: "invalid_grant", error_description: "Unknown or invalid refresh token." } } });
reset(jwt(1));
reply = err;
const msg = await mk().getAccessToken().then(() => "", (e: Error) => e.message);
check("error carries OAuth code and loader hint", msg.includes("invalid_grant") && msg.includes("load-refresh-token") && !msg.includes(OLD_RT));

// Network / 5xx: no re-capture hint, and the saved refresh token is untouched
const netErr = Object.assign(new AxiosError("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
const fiveXx = Object.assign(new AxiosError("x"), { response: { status: 503, statusText: "Service Unavailable", data: "<html>down</html>" } });
for (const [label, e] of [["network error", netErr], ["5xx", fiveXx]] as const) {
  reset(jwt(1));
  reply = e;
  const m = await mk().getAccessToken().then(() => "", (x: Error) => x.message);
  check(`${label}: says retry later, no re-capture hint`, m.includes("Retry later") && !m.includes("load-refresh-token") && !m.includes("site data"));
  check(`${label}: refresh token file untouched`, read(refreshFile) === OLD_RT);
}

// Cross-process lock: two instances, one request; second sees the renewed file
reset(jwt(1));
reply = { access_token: future(), refresh_token: NEW_RT };
const [x, y] = await Promise.all([mk().getAccessToken(), mk().getAccessToken()]);
check("lock: two processes make one refresh request", calls === 1 && x === y);

// Expiry margin: token dying in 30s counts as expired
reset(jwt(Math.floor(Date.now() / 1000) + 30));
reply = { access_token: future() };
await mk().getAccessToken();
check("token inside 60s margin is refreshed", calls === 1);

// 401 on a valid-looking token: refresh and retry once
reset(future());
reply = { access_token: future() };
let gqlCalls = 0;
graphql = async () => {
  gqlCalls += 1;
  if (gqlCalls === 1) throw new AxiosError("x", "ERR", undefined, undefined, { status: 401 } as never);
  return { data: { data: { allOrders: [] } } };
};
const orders = await new CookUnityAPI({ tokenFile, refreshTokenFile: refreshFile }).getAllOrders();
check("401 => refresh + one retry", gqlCalls === 2 && calls === 1 && Array.isArray(orders));
graphql = async () => { throw new AxiosError("x", "ERR", undefined, undefined, { status: 401 } as never); };
reset(future());
await new CookUnityAPI({ tokenFile, refreshTokenFile: refreshFile }).getAllOrders().then(() => check("persistent 401 gives up", false), () => check("persistent 401 gives up after one retry", calls === 1));

fs.rmSync(dir, { recursive: true, force: true });
done();
