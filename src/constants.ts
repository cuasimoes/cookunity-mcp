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
