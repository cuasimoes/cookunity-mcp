/**
 * Do date-taking tools resolve against the account's scheduled deliveries? (issue #12)
 *
 * The failure this guards is silent: the menu API serves a complete, plausible menu for any
 * real delivery slot, including the ~6 in 7 days the user has not scheduled. So "no error" is
 * not evidence of anything — each check asserts which date a tool resolved to, or that it
 * refused one.
 *
 * Handlers are driven in-process through a capturing stand-in for McpServer, with args parsed
 * by each tool's own zod schema so defaults apply as they would over MCP. Read-only: the only
 * non-query call is get_price_breakdown, which prices meals without touching the cart.
 *
 *   npm run verify:dates
 */
import { CookUnityAPI } from "../../src/services/api.js";
import { registerMenuTools } from "../../src/tools/menu.js";
import { registerDeliveryTools } from "../../src/tools/deliveries.js";
import { registerPricingTools } from "../../src/tools/pricing.js";
import { localToday, selectDeliveryDay as select } from "../../src/services/delivery-dates.js";
import { formatDelivery } from "../../src/services/helpers.js";
import type { UpcomingDay } from "../../src/types.js";
import { resolveTokenPath, makeCheck } from "./_shared.mts";

type ToolResult = { isError?: boolean; content: { text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

const api = new CookUnityAPI({ tokenFile: resolveTokenPath() });
const { check, done } = makeCheck();

const handlers = new Map<string, Handler>();
const capture = {
  registerTool: (name: string, config: { inputSchema: { parse: (a: unknown) => any } }, handler: (p: any) => Promise<ToolResult>) => {
    handlers.set(name, (args) => handler(config.inputSchema.parse(args)));
  },
};
for (const register of [registerMenuTools, registerDeliveryTools, registerPricingTools]) {
  register(capture as never, api);
}

const call = async (name: string, args: Record<string, unknown>) => {
  const result = await handlers.get(name)!({ ...args, response_format: "json" });
  const text = result.content[0]?.text ?? "";
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { failed: result.isError === true, text: body ? text.replace(/\s+/g, " ") : text, body };
};

// ── Pure selection rule, on synthetic days (states the live account can't be put in) ──

{
  const day = (date: string, over: Partial<UpcomingDay> = {}): UpcomingDay =>
    ({ id: date, date, displayDate: date, scheduled: true, skip: false, isPaused: false, canEdit: true, available: true, menuAvailable: true, cutoff: null, cart: [], order: null, recommendation: null, ...over }) as UpcomingDay;
  const throws = (fn: () => unknown) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };

  const fixture = [
    day("2026-01-03", { canEdit: false }), // past
    day("2026-01-10", { canEdit: false }), // today, locked
    day("2026-01-11", { scheduled: false }), // unscheduled slot
    day("2026-01-12", { skip: true }), // skipped
    day("2026-01-14", { isPaused: true }), // paused
    day("2026-01-17"), // first editable, received
    day("2026-01-24"),
  ];
  const T = "2026-01-10";
  const message = (fn: () => unknown) => {
    try {
      fn();
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  check("default skips locked, unscheduled, skipped and paused days", select(fixture, undefined, T).date === "2026-01-17");
  check("default is order-independent", select([...fixture].reverse(), undefined, T).date === "2026-01-17");
  check("default never returns a past day", throws(() => select([day("2026-01-03")], undefined, T)));
  check("explicit skipped day is accepted", select(fixture, "2026-01-12", T).date === "2026-01-12");
  check("explicit locked day is accepted", select(fixture, "2026-01-10", T).date === "2026-01-10");
  check("explicit unscheduled slot is rejected", throws(() => select(fixture, "2026-01-11", T)));
  check("explicit date outside the window is rejected", throws(() => select(fixture, "2026-03-01", T)));
  check("no editable delivery throws rather than guessing", throws(() => select([day("2026-01-10", { canEdit: false })], undefined, T)));
  check("matches date, not displayDate", throws(() => select([day("2026-01-17", { displayDate: "2026-01-18" })], "2026-01-18", T)));
  // The other half of that contract: list_deliveries must hand out the field the resolver reads.
  // Live slots never diverge, so only a synthetic day can make this fail.
  check("formatDelivery emits date, not displayDate", formatDelivery(day("2026-01-17", { displayDate: "2026-01-18" })).date === "2026-01-17");

  const rejection = message(() => select(fixture, "2026-01-11", T));
  check("rejection lists upcoming dates, not past ones", rejection.includes("2026-01-17") && !rejection.includes("2026-01-03"), rejection.slice(0, 100));

  // localToday must read the local calendar. 07:30 UTC on the 11th is still the evening of the
  // 10th in Los Angeles; toISOString() would say the 11th. Node honours a runtime TZ change.
  const savedTz = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    check("localToday uses the local calendar, not UTC", localToday(new Date("2026-01-11T07:30:00Z")) === "2026-01-10");
  } finally {
    // The live checks below compute "today" locally; a leaked TZ would skew them.
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  }
}

// ── Live tools ──

// The rule itself is proven by the synthetic section above; the live section proves the tools
// are wired to it. So the expectation comes from the rule rather than a second copy of it.
const today = localToday();
const days = await api.getUpcomingDays();
let expected: UpcomingDay | undefined;
try {
  expected = select(days, undefined, today);
} catch {
  expected = undefined;
}
// Editable, with a menu: the slot a caller could actually build a doomed cart against.
const unbooked = days.find((d) => !d.scheduled && d.menuAvailable && d.canEdit && d.date >= today);

console.log(`\nlive: expected default ${expected?.date ?? "(none)"}, unbooked probe ${unbooked?.date ?? "(none)"}\n`);
if (!expected || !unbooked) {
  check("live account has an editable delivery and an unbooked slot to probe", false);
  done();
}

// Defaults: each tool must report the date it resolved to.
const menu = await call("cookunity_get_menu", { limit: 1 });
check("get_menu {} → next editable delivery", !menu.failed && menu.body?.date === expected!.date, menu.failed ? menu.text.slice(0, 120) : `got ${menu.body?.date}`);

const search = await call("cookunity_search_meals", { query: "chicken", limit: 1 });
check("search_meals {} → next editable delivery", !search.failed && search.body?.date === expected!.date, search.failed ? search.text.slice(0, 120) : `got ${search.body?.date}`);

const cart = await call("cookunity_get_cart", {});
check("get_cart {} → next editable delivery", !cart.failed && cart.body?.date === expected!.date, cart.failed ? cart.text.slice(0, 120) : `got ${cart.body?.date}`);

// A meal from the resolved week, so the lookups below have something real to find.
const bookedMenu = await call("cookunity_get_menu", { date: expected!.date, limit: 1 });
const meal = bookedMenu.body?.meals?.[0];
check("get_menu accepts a scheduled date", !bookedMenu.failed && bookedMenu.body?.total > 0, bookedMenu.failed ? bookedMenu.text.slice(0, 120) : `${bookedMenu.body?.total} meals`);

const priceMeals = meal ? [{ entityId: meal.id, quantity: 1, inventoryId: meal.inventory_id }] : [];

if (meal) {
  const details = await call("cookunity_get_meal_details", { inventory_id: meal.inventory_id });
  check("get_meal_details {} → next editable delivery", !details.failed && details.body?.date === expected!.date, details.failed ? details.text.slice(0, 120) : `got ${details.body?.date}`);

  const price = await call("cookunity_get_price_breakdown", { meals: priceMeals });
  check("get_price_breakdown {} → next editable delivery", !price.failed && price.body?.date === expected!.date, price.failed ? price.text.slice(0, 120) : `got ${price.body?.date}`);
} else {
  check("read a meal from the scheduled week", false);
}

// Round-trip: every date list_deliveries hands out must be accepted back. The tool descriptions
// tell callers to copy these, so a field mismatch here rejects exactly the dates we advertise.
const listed = await call("cookunity_list_deliveries", {});
const listedDates: string[] = (listed.body?.deliveries ?? []).map((d: { date: string }) => d.date);
const refused: string[] = [];
for (const date of listedDates) {
  if ((await call("cookunity_get_cart", { date })).failed) refused.push(date);
}
check("every list_deliveries date is accepted by get_cart", listedDates.length > 0 && refused.length === 0, refused.length ? `refused ${refused.join(", ")}` : `${listedDates.length} dates`);

// Past deliveries stay valid to request, so a caller taking the first listed date would read
// last week's menu without error. The list must start at today.
const past = listedDates.filter((d) => d < today);
check("list_deliveries omits past deliveries", past.length === 0, past.length ? `listed ${past.join(", ")}` : `first ${listedDates[0]}`);

// Rejections: an unbooked slot must fail loudly and point at a real date. Asserting the error
// names a scheduled date, not just isError — a generic API failure would also set isError.
const rejects = (label: string, r: { failed: boolean; text: string }) =>
  check(`${label} rejects unbooked ${unbooked!.date}`, r.failed && r.text.includes(expected!.date), r.text.slice(0, 120));

rejects("get_menu", await call("cookunity_get_menu", { date: unbooked!.date, limit: 1 }));
rejects("search_meals", await call("cookunity_search_meals", { query: "chicken", date: unbooked!.date, limit: 1 }));
rejects("get_cart", await call("cookunity_get_cart", { date: unbooked!.date }));
rejects("get_meal_details", await call("cookunity_get_meal_details", { inventory_id: meal?.inventory_id ?? "ii-0", date: unbooked!.date }));
rejects("get_price_breakdown", await call("cookunity_get_price_breakdown", { date: unbooked!.date, meals: priceMeals }));

done();
