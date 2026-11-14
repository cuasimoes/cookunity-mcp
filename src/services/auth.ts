import fs from "fs";
import axios from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import { AuthTokens } from "../types.js";
import {
  AUTH_BASE_URL,
  AUTH_CLIENT_ID,
  AUTH_ORIGIN,
  AUTH_REALM,
  AUTH_TOKEN_TIMEOUT_MS,
  TOKEN_EXPIRY_MARGIN_MS,
} from "../constants.js";
import { readRefreshToken, isPlausibleRefreshToken, withFileLock, writeSecretFile } from "./token-store.js";

const REDIRECT_URI = "https://www.cookunity.com";

export interface AuthOptions {
  email?: string;
  password?: string;
  tokenFile?: string;
  /** Needs `tokenFile`: renewed access tokens are written there. */
  refreshTokenFile?: string;
}

export interface RefreshResult {
  expiresAt: number;
  /** Whether the refresh token the server returned differs from the one we sent. */
  refreshTokenRotated: boolean;
  /** True when another process had already renewed the token, so no request was made. */
  skipped?: boolean;
}

export interface RefreshOptions {
  /** Refresh even if the token file already holds a usable token (verify scripts). */
  force?: boolean;
  /** A token the server just rejected: a file holding the same one is not a renewal. */
  rejectedToken?: string;
}

export class CookUnityAuth {
  private email?: string;
  private password?: string;
  private tokenFile?: string;
  private refreshTokenFile?: string;
  private tokens: AuthTokens | null = null;
  // Shared by concurrent callers: a rotating refresh token can be spent only once, so two
  // parallel refreshes would make the loser look like token reuse and revoke the chain.
  private inflightRefresh: Promise<RefreshResult> | null = null;

  constructor(opts: AuthOptions) {
    this.refreshTokenFile = opts.refreshTokenFile;
    this.email = opts.email;
    this.password = opts.password;
    this.tokenFile = opts.tokenFile;
  }

  async getAccessToken(): Promise<string> {
    if (this.tokens && this.isTokenValid(this.tokens)) {
      return this.tokens.access_token;
    }
    if (this.tokenFile) {
      try {
        this.loadTokenFromFile();
      } catch (error) {
        if (!this.refreshTokenFile) throw error;
        // Missing or expired access token: renew it rather than asking for a devtools copy.
        await this.refresh();
      }
      return this.tokens!.access_token;
    }
    if (!this.email || !this.password) {
      throw new Error("No credentials configured: set COOKUNITY_TOKEN_FILE or both COOKUNITY_EMAIL and COOKUNITY_PASSWORD.");
    }
    await this.authenticate();
    return this.tokens!.access_token;
  }

  /**
   * Exchange the stored refresh token for a new access token and persist both.
   * Concurrent calls share one request.
   */
  refresh(opts: RefreshOptions = {}): Promise<RefreshResult> {
    this.inflightRefresh ??= this.doRefresh(opts).finally(() => {
      this.inflightRefresh = null;
    });
    return this.inflightRefresh;
  }

  hasRefreshToken(): boolean {
    return !!this.refreshTokenFile && !!this.tokenFile;
  }

  /** The server rejected the cached token (revoked before `exp`): drop it and renew. */
  async refreshAfterRejection(rejectedToken: string): Promise<void> {
    this.tokens = null;
    await this.refresh({ rejectedToken });
  }

  private async doRefresh(opts: RefreshOptions): Promise<RefreshResult> {
    if (!this.refreshTokenFile || !this.tokenFile) {
      throw new Error("Refresh needs both COOKUNITY_REFRESH_TOKEN_FILE and COOKUNITY_TOKEN_FILE.");
    }
    const refreshFile = this.refreshTokenFile;
    // Every Claude session runs its own server process; the lock keeps them from spending one
    // rotating refresh token twice.
    return withFileLock(`${refreshFile}.lock`, async () => {
      if (!opts.force) {
        // Another process may have renewed while we waited for the lock.
        try {
          this.loadTokenFromFile();
          if (this.tokens!.access_token !== opts.rejectedToken) {
            return { expiresAt: this.tokens!.expires_at, refreshTokenRotated: false, skipped: true };
          }
        } catch {
          // still missing or expired: refresh below
        }
      }
      return this.requestNewTokens(refreshFile);
    });
  }

  private async requestNewTokens(refreshFile: string): Promise<RefreshResult> {
    const tokenFile = this.tokenFile!;
    const refreshToken = readRefreshToken(refreshFile);

    let data: { access_token?: string; refresh_token?: string };
    try {
      // Messages are rebuilt from error_description/status only: an Axios error carries the
      // request body (the refresh token) in its config.
      const r = await axios.post(
        `${AUTH_BASE_URL}/oauth/token`,
        { grant_type: "refresh_token", client_id: AUTH_CLIENT_ID, refresh_token: refreshToken },
        { headers: { "Content-Type": "application/json", Origin: AUTH_ORIGIN }, timeout: AUTH_TOKEN_TIMEOUT_MS }
      );
      data = r.data as typeof data;
    } catch (error) {
      throw new Error(this.describeRefreshFailure(error));
    }
    if (!data?.access_token) throw new Error("Refresh response had no access token.");

    // Save any rotated refresh token before touching the access token: the server has already
    // spent the old one, so a decode or write failure below must not lose the new one.
    const newRefresh = data.refresh_token;
    const rotated = typeof newRefresh === "string" && isPlausibleRefreshToken(newRefresh) && newRefresh !== refreshToken;
    if (rotated) writeSecretFile(refreshFile, newRefresh!);

    const expiresAt = this.decodeJwtExpiry(data.access_token);
    writeSecretFile(tokenFile, data.access_token);

    this.tokens = { access_token: data.access_token, expires_at: expiresAt };
    return { expiresAt, refreshTokenRotated: rotated };
  }

  private isTokenValid(tokens: AuthTokens): boolean {
    return Date.now() < tokens.expires_at - TOKEN_EXPIRY_MARGIN_MS;
  }

  private loadTokenFromFile(): void {
    const path = this.tokenFile!;
    if (!fs.existsSync(path)) {
      throw new Error(
        `Token file not found: ${path}. Harvest a fresh token from Chrome DevTools (Network → any GraphQL request → Authorization header) and save it to that path.`
      );
    }
    const raw = fs.readFileSync(path, "utf-8").trim();
    if (!raw) throw new Error(`Token file is empty: ${path}`);
    // Case-insensitive: a "bearer eyJ..." paste would otherwise survive the strip, still
    // decode a valid exp, and fail later as an opaque 401 with nothing pointing back here.
    const token = raw.replace(/^bearer\s+/i, "").trim();
    const expiresAt = this.decodeJwtExpiry(token);
    if (Date.now() >= expiresAt - TOKEN_EXPIRY_MARGIN_MS) {
      throw new Error(
        `Token in ${path} has expired. Harvest a fresh one from Chrome DevTools.`
      );
    }
    this.tokens = { access_token: token, expires_at: expiresAt };
  }

  private decodeJwtExpiry(token: string): number {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Token is not a valid JWT (expected 3 dot-separated segments)");
    let payload: { exp?: number };
    try {
      payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")) as { exp?: number };
    } catch {
      // Replace the SyntaxError rather than rethrowing it. V8 echoes the first 10 characters
      // of the input in its "Unexpected token" message — for a decoded JWT payload that is
      // just the opening claim key, not credential material, so this is hygiene rather than
      // a fix for a live leak. The real benefit is an actionable message: V8's alternative
      // is "Expected ',' or '}' after property value in JSON at position 66", which tells a
      // user nothing about which file to go re-harvest.
      throw new Error("Token payload is not valid JSON. The token file may be truncated or not a JWT.");
    }
    if (typeof payload.exp !== "number") throw new Error("JWT payload has no `exp` claim");
    return payload.exp * 1000;
  }

  private async authenticate(): Promise<void> {
    try {
      // Create a session with cookie jar (Auth0 requires cookies across requests)
      const jar = new CookieJar();
      const client = wrapper(axios.create({ jar, timeout: 30000 }));

      // Step 1: Get login ticket
      const r1 = await client.post(`${AUTH_BASE_URL}/co/authenticate`, {
        client_id: AUTH_CLIENT_ID,
        credential_type: "http://auth0.com/oauth/grant-type/password-realm",
        username: this.email,
        password: this.password,
        realm: AUTH_REALM,
      }, {
        headers: { "Content-Type": "application/json", "Origin": "https://www.cookunity.com" },
      });

      const loginTicket = r1.data?.login_ticket as string | undefined;
      if (!loginTicket) throw new Error("Failed to get login ticket");

      // Step 2: Authorize — follow redirects to get the auth code
      const params = new URLSearchParams({
        client_id: AUTH_CLIENT_ID,
        response_type: "code",
        redirect_uri: REDIRECT_URI,
        scope: "openid profile email",
        realm: AUTH_REALM,
        login_ticket: loginTicket,
      });

      // Follow redirects until we get a code in the callback URL
      let currentUrl = `${AUTH_BASE_URL}/authorize?${params}`;
      let code: string | null = null;
      for (let i = 0; i < 5; i++) {
        const r = await client.get(currentUrl, {
          maxRedirects: 0,
          validateStatus: (status) => status === 302,
        });
        const loc = r.headers.location as string | undefined;
        if (!loc) throw new Error("No redirect location in authorize flow");
        const resolved = loc.startsWith("http") ? loc : `${AUTH_BASE_URL}${loc}`;
        const parsed = new URL(resolved);
        code = parsed.searchParams.get("code");
        if (code) break;
        currentUrl = resolved;
      }
      if (!code) throw new Error("Failed to obtain authorization code");

      // Step 3: Exchange code for tokens
      const r4 = await client.post(`${AUTH_BASE_URL}/oauth/token`, {
        client_id: AUTH_CLIENT_ID,
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }, {
        headers: { "Content-Type": "application/json" },
      });

      const tokenData = r4.data as { access_token?: string; refresh_token?: string; expires_in?: number };
      if (!tokenData.access_token) throw new Error("Failed to get access token");

      this.tokens = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: Date.now() + (tokenData.expires_in ?? 86400) * 1000,
      };
    } catch (error) {
      throw new Error(`Authentication failed: ${this.getErrorMessage(error)}`);
    }
  }

  /**
   * Only an OAuth `error` code (e.g. invalid_grant) means Auth0 rejected the token, so only
   * then is re-capturing it the fix. Network errors and 5xx leave the saved token untouched
   * and valid; sending the user to re-capture during an outage would be wasted work.
   */
  private describeRefreshFailure(error: unknown): string {
    const message = this.getErrorMessage(error).replace(/\.$/, "");
    const code = axios.isAxiosError(error) ? (error.response?.data as Record<string, unknown> | undefined)?.error : undefined;
    if (typeof code === "string") {
      return `Refresh failed: ${code}: ${message}. The refresh token was rejected; copy a new one from the browser, run scripts/load-refresh-token.sh, then clear cookunity.com site data in Chrome and log in again.`;
    }
    return `Refresh failed: could not get a response from Auth0 (${message}). Retry later; the saved refresh token is untouched.`;
  }

  private getErrorMessage(error: unknown): string {
    if (axios.isAxiosError(error)) {
      const data = error.response?.data as Record<string, unknown> | undefined;
      if (data?.error_description) return String(data.error_description);
      if (data?.message) return String(data.message);
      if (error.response?.status) return `HTTP ${error.response.status}: ${error.response.statusText}`;
    }
    return error instanceof Error ? error.message : "Unknown error";
  }
}
