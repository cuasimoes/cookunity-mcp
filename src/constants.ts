export const MENU_SERVICE_URL = "https://subscription.cookunity.com/menu-service/graphql";
export const SUBSCRIPTION_URL = "https://subscription.cookunity.com/subscription-back/graphql/user";

export const AUTH_BASE_URL = "https://auth.cookunity.com";
export const AUTH_CLIENT_ID = "E3AWy6rDb3S3ErYliO64fnY171Ec1xhf";
export const AUTH_REALM = "cookunity";

export const DEFAULT_PAGE_SIZE = 20;

/**
 * Deliberately larger than any real menu (~404 meals as of 2026-08).
 *
 * Paging here is client-side `Array.slice` — every page re-fetches the whole menu from
 * the API — so a low cap makes scanning strictly more expensive, not less. One large
 * response also spills to a file in MCP clients that do so, which is far cheaper for an
 * agent than the same data inline across nine pages.
 */
export const MAX_PAGE_SIZE = 1000;

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

/** Origin the web app sends to Auth0; the token endpoint may check it, so we mirror it. */
export const AUTH_ORIGIN = "https://www.cookunity.com";
export const AUTH_TOKEN_TIMEOUT_MS = 30000;

/** Auth0 refresh tokens from this tenant are `v1.`-prefixed opaque strings. */
export const REFRESH_TOKEN_PATTERN = /^v1\.[A-Za-z0-9._-]+$/;
export const REFRESH_TOKEN_MIN_LENGTH = 40;
export const REFRESH_TOKEN_MAX_LENGTH = 1024;

/** Token files hold bearer credentials: owner read/write only. */
export const SECRET_FILE_MODE = 0o600;
