# cookunity-mcp Roadmap

Alex's fork of a third-party MCP server. Every issue traces to one use case: the weekly
AI-assisted meal selection the `/cookunity` skill runs against `~/hq/resources/cookunity/preferences.md`.

**Issue state lives on GitHub** — `gh issue list --repo cuasimoes/cookunity-mcp`. This file
holds the work order and the standing decisions, not a copy of the backlog.

## Next up

Ordered. Start from the top unless something else is on fire.

1. **#10** — `get_meal_details` fetches the whole menu to render one meal. Pure token waste,
   no correctness risk. Safe for AFK.
2. **#5** — Menu response types don't match runtime shapes (`nutritionalFacts` strings,
   `userRating` null on ~399/401 meals). Low urgency: `/cookunity` already ignores ratings and
   the skill documents the workaround.
3. **#8** — Typecheck `scripts/`. Blocked: not worth doing until the repo has CI.

## Settled — do not re-litigate

- **Delivery dates resolve against scheduled deliveries** (#12, PR #13, merged 2026-09-13).
  Default is the nearest scheduled, non-skipped, non-paused delivery that is still *editable* —
  not merely the nearest, since tomorrow's is usually locked. `services/delivery-dates.ts` is
  the single rule; `getNextMonday()` is deleted. `localToday()` uses the host timezone, which is
  correct while this runs on a Mac and would regress in a UTC container.
- **Write tools use the same rule** (#14, PR #15, merged 2026-10-24). Cart, confirm, skip and
  unskip call `resolveDeliveryDay` *before* writing — sequential, never in parallel like
  `fetchForDelivery`. A skipped week keeps `scheduled: true` (checked live on 2026-11-22: skip,
  probe, unskip), so unskip needs no special case. Paused weeks are still unverified live.
- **Token refresh stays manual** (#2). No unattended caller exists to justify automating it.
- **Menu caching rejected** (2026-08-15). `mealPublic` is cheaper and stateless; break-even is
  ~223 meals inspected per session, far past any real run.
- **Upstream is not a target.** Dormant since 2026-02-24. Don't wait on it, don't file there.
  Always pass `--repo cuasimoes/cookunity-mcp` to `gh` or it resolves to the parent.

## Verification

No unit tests and no CI. `scripts/verify/` runs against the live API; `npm run verify:dates`
is the date-resolution gate. Read-only scripts are safe; never let a script make a cart,
confirm, or skip write. Write *tools* may be driven only against the fenced API in
`verify-dates.mts` (see `scripts/verify/README.md`).
