# cookunity-mcp Roadmap

Alex's fork of a third-party MCP server. Every issue traces to one use case: the weekly
AI-assisted meal selection the `/cookunity` skill runs against `~/hq/resources/cookunity/preferences.md`.

**Issue state lives on GitHub** — `gh issue list --repo cuasimoes/cookunity-mcp`. This file
holds the work order and the standing decisions, not a copy of the backlog.

## Next up

Ordered. Start from the top unless something else is on fire.

1. **#14** — Cart, confirm and skip tools accept dates you haven't scheduled. The unguarded
   half of #12: `add_to_cart` has no date check at all, and `confirm_order` / `skip` / `unskip`
   validate against all ~42 delivery slots instead of the ~6 scheduled ones. A cart built on an
   unbooked week carries inventory ids that attach to no order. Read tools now reject these
   dates, so the inconsistency is live. **Not fully AFK-suitable** — the accept path needs
   attended account writes; a container can only verify the rejections.
2. **#10** — `get_meal_details` fetches the whole menu to render one meal. Pure token waste,
   no correctness risk. Safe for AFK.
3. **#5** — Menu response types don't match runtime shapes (`nutritionalFacts` strings,
   `userRating` null on ~399/401 meals). Low urgency: `/cookunity` already ignores ratings and
   the skill documents the workaround.
4. **#8** — Typecheck `scripts/`. Blocked: not worth doing until the repo has CI.

## Settled — do not re-litigate

- **Delivery dates resolve against scheduled deliveries** (#12, PR #13, merged 2026-09-13).
  Default is the nearest scheduled, non-skipped, non-paused delivery that is still *editable* —
  not merely the nearest, since tomorrow's is usually locked. `services/delivery-dates.ts` is
  the single rule; `getNextMonday()` is deleted. `localToday()` uses the host timezone, which is
  correct while this runs on a Mac and would regress in a UTC container.
- **Token refresh stays manual** (#2). No unattended caller exists to justify automating it.
- **Menu caching rejected** (2026-08-15). `mealPublic` is cheaper and stateless; break-even is
  ~223 meals inspected per session, far past any real run.
- **Upstream is not a target.** Dormant since 2026-02-24. Don't wait on it, don't file there.
  Always pass `--repo cuasimoes/cookunity-mcp` to `gh` or it resolves to the parent.

## Verification

No unit tests and no CI. `scripts/verify/` runs against the live API; `npm run verify:dates`
is the date-resolution gate. Read-only scripts are safe; never let a script call the cart
mutation, confirm, or skip tools.
