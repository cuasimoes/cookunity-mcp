# Verification scripts

Ad-hoc checks that run against the **live** CookUnity API and the built server. They exist
because `tsc` cannot catch this repo's most common failure: the GraphQL responses are cast
untyped, so `types.ts` can describe shapes the API stopped returning, and the mismatch only
appears as a runtime `TypeError` in production.

These are not a test suite — they need a valid token and a network connection, and they
assert against whatever the menu returns today.

| Command | What it answers |
|---|---|
| `npm run verify:token` | Is the token usable? Distinguishes missing / expired / revoked. |
| `npm run probe:fields` | What shapes is the API returning? Flags drift from `types.ts`. |
| `npm run verify:menu` | Does `normalizeMeal` hold, and do the previously-throwing paths work? |
| `npm run verify:smoke` | Does the built server boot, authenticate, and serve tool calls? |

All four read the token from `COOKUNITY_TOKEN_FILE`, falling back to `.token` in the repo
root. Start with `verify:token` — the other three fail confusingly against a dead token.

## Handling the token

The token is a bearer credential: whoever holds it has full account access until it expires
(~24h). These scripts print expiry, file mode, and call results — never the token itself.

Keep that property when editing them. The specific trap: **never `JSON.parse` the token file
without checking its shape first.** A `SyntaxError` echoes part of the input it choked on, so
parsing a raw JWT puts credential material into the error message and any log that captures
it. `loadToken` in `_shared.mts` does this correctly — reuse it rather than re-reading the
file. `smoke-mcp.mts` also asserts that nothing JWT-shaped reaches stderr.

## When they earn their keep

`probe:fields` is the one to reach for when something breaks inexplicably. It reads the raw
response before normalization, so it will show you a field that changed from a list to a
delimited string — the exact regression that broke `search_meals`, the `diet` filter, and all
markdown rendering.

`verify:menu` also prints the per-meal payload size, which is the baseline for the token-cost
work in issue #1.
