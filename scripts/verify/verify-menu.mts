/**
 * Does normalizeMeal hold against today's live menu?
 *
 * Regression coverage for PR #4: every searchBy list field must be a real array by the time
 * it leaves the API layer, `ingredients` must stay whole, and the four call paths that used
 * to throw TypeError must all succeed.
 *
 *   npm run verify:menu
 */
import { CookUnityAPI } from "../../src/services/api.js";
import { formatMeal, formatMealMarkdown, toStructured } from "../../src/services/helpers.js";
import { resolveDeliveryDay } from "../../src/services/delivery-dates.js";
import { nutrientsByName } from "../../src/services/nutrition.js";
import { resolveTokenPath, makeCheck } from "./_shared.mts";

const api = new CookUnityAPI({ tokenFile: resolveTokenPath() });
const date = process.argv[2] ?? (await resolveDeliveryDay(api)).date;
const { check, done } = makeCheck();

const menu = await api.getMenu(date);
console.log(`menu ${date}: ${menu.meals.length} meals\n`);
check("menu is non-empty", menu.meals.length > 0);

const listFields = ["cuisines", "dietTags", "ingredients", "proteinTags"] as const;
for (const field of listFields) {
  const allArrays = menu.meals.every((m) => Array.isArray(m.searchBy[field]));
  check(`${field} is always an array`, allArrays);
}

const untrimmed = menu.meals.filter((m) =>
  [...m.searchBy.dietTags, ...m.searchBy.cuisines, ...m.searchBy.proteinTags].some(
    (entry) => entry !== entry.trim() || entry.length === 0
  )
);
check("no empty or untrimmed entries", untrimmed.length === 0, `${untrimmed.length} meals affected`);

// Commas inside `ingredients` sit within a single supplier-style name ("Veg, Tomatoes, Whole,
// Canned, Italian" is one ingredient). Splitting it fabricates entries, so it must stay whole.
const fragmented = menu.meals.filter((m) => m.searchBy.ingredients.length > 1);
check("ingredients never fragmented", fragmented.length === 0, `${fragmented.length} meals split`);

const chefIntact = menu.meals.every(
  (m) => typeof m.searchBy.chefFirstName === "string" && !m.searchBy.chefFirstName.includes("undefined")
);
check("chef name fields preserved", chefIntact);

// The four paths that threw before normalization landed.
// Assert on the counts, not merely on "did not throw". If normalization regressed to
// returning [] for every list field, each shape check above still passes ([] is an array,
// nothing to iterate, 0 > 1 is false) while diet filtering silently matches nothing.
try {
  const vegan = menu.meals.filter((m) => m.searchBy.dietTags.some((t) => t.toLowerCase().includes("vegan")));
  check("diet filter", vegan.length > 0, `${vegan.length} vegan meals`);
} catch (error) {
  check("diet filter", false, String(error));
}

try {
  const hits = await api.searchMeals("salmon", date);
  check("searchMeals", hits.length > 0, `${hits.length} hits for "salmon"`);
} catch (error) {
  check("searchMeals", false, String(error));
}

try {
  const markdown = formatMealMarkdown(formatMeal(menu.meals[0]));
  check("markdown rendering", markdown.includes("###"), `${markdown.split("\n").length} lines`);
} catch (error) {
  check("markdown rendering", false, String(error));
}

try {
  const detailed = await api.getMenuDetailed(date);
  const normalized = detailed.every((m) => Array.isArray(m.searchBy.dietTags));
  check("getMenuDetailed normalized", normalized, `${detailed.length} meals`);

  // The nutrition label is the reason getMenuDetailed exists for %DV work, and it arrives
  // through the same untyped cast as everything else here. A rename upstream would empty
  // these silently — the tool would still render, just without cholesterol.
  // The `detailed.length > 0` guard belongs here, on the first nutrient assertion: on an
  // empty menu every check below passes vacuously, so one of them has to refuse to.
  const withNutrients = detailed.filter((m) => m.nutrients.length > 0);
  check(
    "nutrients present",
    detailed.length > 0 && withNutrients.length === detailed.length,
    `${withNutrients.length}/${detailed.length} meals`
  );

  // Nutrients a label must always carry. This is a presence check, not a policy: nothing here
  // or in src/ knows about thresholds, and no consumer should read a limit into this list.
  // Named individually rather than counted — "7 nutrients found" would still pass if
  // cholesterol vanished and some other nutrient appeared twice.
  //
  // This is also the net under normalizeNutrients' silent drops. A value drifting to a shape
  // it rejects ("28 g") removes the row entirely, and the only way that surfaces is a
  // nutrient going missing here. So the list is every nutrient the API returns, not just the
  // ones carrying a daily value — a shorter list would leave the rest able to vanish with
  // every check green. All 16 are on 404/404 meals as of 2026-08-17.
  //
  // carbon_footprint is deliberately excluded: it is not a nutrient, it appears on only ~60%
  // of meals, and it is the one key whose spelling the API is inconsistent about.
  const REQUIRED_NUTRIENTS = [
    "calories",
    "totalfat",
    "saturatedfat",
    "transfat",
    "cholesterol",
    "sodium",
    "totalcarbohydrate",
    "dietaryfiber",
    "totalsugars",
    "addedsugar",
    "protein",
    "vitamind",
    "calcium",
    "iron",
    "potassium",
    "phosphorus",
  ];
  // Checked against `detailed`, not `withNutrients`: a meal with no nutrients at all must
  // fail here too. Filtering first would make every assertion below vacuously true on the
  // exact regression they exist to catch — an empty array satisfies both some() and every().
  const missing = REQUIRED_NUTRIENTS.filter((key) =>
    detailed.some((meal) => !nutrientsByName(meal.nutrients).has(key))
  );
  check(
    "required nutrients on every meal",
    missing.length === 0,
    missing.length === 0 ? REQUIRED_NUTRIENTS.join(", ") : `missing on some meals: ${missing.join(", ")}`
  );

  // dailyValue is what makes this worth querying over nutritionalFacts. It is "" for
  // nutrients with no established DV, so assert on one that must always carry a percentage.
  const cholesterolDV = detailed.every((meal) => {
    const row = nutrientsByName(meal.nutrients).get("cholesterol");
    return row !== undefined && /^\d+(\.\d+)?%$/.test(row.dailyValue);
  });
  check("cholesterol carries a % daily value", cholesterolDV);

  // Deliberately NOT asserting that every value is a finite number: normalizeNutrients drops
  // any row that is not, so such a check is a post-condition of the function under test and
  // cannot fail for any API response. Value drift is covered by the presence check above —
  // a rejected value removes the row, which shows up there as a missing nutrient.
  //
  // `unit` is the field with no such guard: it is coerced with String(x ?? ""), so an empty
  // or dropped unit survives normalization and renders as "Sodium | 940 |" with no mg.
  const unitless = detailed.flatMap((meal) =>
    meal.nutrients.filter((n) => n.unit.trim() === "").map((n) => n.name)
  );
  check(
    "every nutrient carries a unit",
    unitless.length === 0,
    unitless.length === 0 ? undefined : `missing unit: ${[...new Set(unitless)].join(", ")}`
  );
} catch (error) {
  check("getMenuDetailed normalized", false, String(error));
}

// The list-view field contract (#1).
//
// formatMeal is a projection, and this trimmed two fields out of it. That makes the
// projection a place where a field can go missing without anything throwing — the tool
// still renders, the cart call just fails later with an empty inventory_id. So assert
// both directions: what must survive, and what must stay gone.
const listView = menu.meals.map(formatMeal);

const cartable = listView.filter(
  (m) => typeof m.inventory_id === "string" && m.inventory_id.length > 0 && Number.isFinite(m.batch_id)
);
check(
  "every meal is addable to a cart",
  listView.length > 0 && cartable.length === listView.length,
  `${cartable.length}/${listView.length} carry inventory_id + batch_id`
);

// The only signal for new-this-week meals — there is no category or filter for them.
// A passthrough, not a coercion, so an upstream rename lands here as null.
const flagged = listView.filter((m) => typeof m.is_new === "boolean");
check(
  "is_new is a boolean on every meal",
  flagged.length === listView.length,
  `${listView.filter((m) => m.is_new).length} new this week`
);

// 404/404 meals carry a cuisine, so the assertion is that none lack one. An earlier
// version allowed any non-zero count, which passed with 1 meal of 404 tagged — a 99.75%
// loss reading as green. When the data supports an exact bound, use it.
const noCuisine = listView.filter((m) => m.tags.cuisines.length === 0);
check(
  "cuisine survives the projection",
  listView.length > 0 && noCuisine.length === 0,
  `${listView.length - noCuisine.length}/${listView.length} meals tagged`
);

// The projection's exact key set, asserted in both directions at once.
//
// A ceiling only ever catches growth: gutting six fields drops the payload to 366
// chars/meal and sails under any budget. Naming the two removed fields only catches those
// two. Exact equality is the one assertion that nets the whole class — every field that
// vanishes and every field that comes back, without enumerating failure modes.
//
// `formatMeal` returns an object literal, so every meal shares a key set; checking the
// first is sufficient.
const EXPECTED_KEYS = [
  "id", "name", "description", "chef", "category", "price", "original_price", "rating",
  "inventory_id", "batch_id", "in_stock", "stock", "is_new", "nutrition", "tags", "meat_type",
];
const EXPECTED_TAG_KEYS = ["cuisines", "diet_tags", "protein_tags"];

const keyDiff = (expected: string[], actual: string[]) => [
  ...expected.filter((k) => !actual.includes(k)).map((k) => `-${k}`),
  ...actual.filter((k) => !expected.includes(k)).map((k) => `+${k}`),
];
const drift = [
  ...keyDiff(EXPECTED_KEYS, Object.keys(listView[0] ?? {})),
  ...keyDiff(EXPECTED_TAG_KEYS, Object.keys(listView[0]?.tags ?? {})).map((k) => `tags.${k}`),
];
check(
  "list-view key set is exact",
  listView.length > 0 && drift.length === 0,
  drift.length === 0 ? `${EXPECTED_KEYS.length} fields, ${EXPECTED_TAG_KEYS.length} tags` : drift.join(" ")
);

// Key presence does not catch a field that is present but emptied or wired to the wrong
// source. diet_tags is the field most worth guarding that way: it is the largest surviving
// one, and it is what makes a diet-filtered result explainable — without it you get matches
// with no way to see why they matched.
//
// Asserted as passthrough fidelity against the source rather than as a coverage floor:
// 403/404 meals carry diet tags, so any percentage bound would be arbitrary, and one that
// tolerated the natural gap would also tolerate real loss.
const dietDrift = listView.filter(
  (m, i) => m.tags.diet_tags.length !== menu.meals[i].searchBy.dietTags.length
);
check(
  "diet_tags passes through intact",
  dietDrift.length === 0,
  `${listView.filter((m) => m.tags.diet_tags.length > 0).length}/${listView.length} meals tagged`
);

// The scalar fields a proposal is built from. All are 404/404 on the live menu, so an
// empty one means the projection broke, not that the menu is sparse. `description` and
// `meat_type` are deliberately absent — both have real gaps upstream (397 and 395 of 404).
const emptyScalar = listView.filter(
  (m) =>
    m.name.trim() === "" ||
    m.chef.trim() === "" ||
    m.category.trim() === "" ||
    m.nutrition?.calories == null
);
check(
  "core scalar fields are populated",
  listView.length > 0 && emptyScalar.length === 0,
  `${listView.length - emptyScalar.length}/${listView.length} meals with name, chef, category, calories`
);

// Payload sizing — the baseline issue #1 is measured against.
//
// Measure the real `output` object that cookunity_get_menu builds, not a bare array of
// formatted meals: `structuredContent` is `toStructured(output)`, so that object is the cost.
//
// The two numbers are NOT additive for Claude Code, which renders `structuredContent` and
// discards `content`. structuredContent is therefore the agent-context figure and the one #1
// is optimising; the content-text line is wire cost only, reported so the distinction stays
// visible and nobody re-derives it from a single conflated number.
const formattedAll = listView;
const output = {
  date,
  total: formattedAll.length,
  count: formattedAll.length,
  offset: 0,
  has_more: false,
  categories: menu.categories.map((c) => ({ id: c.id, title: c.title })),
  meals: formattedAll,
};

const structuredChars = JSON.stringify(toStructured(output)).length;
const textChars = JSON.stringify(output, null, 2).length;
const perMeal = Math.round(structuredChars / menu.meals.length);

console.log(
  `\nstructuredContent (agent context): ~${perMeal} chars/meal, ` +
    `~${Math.round(structuredChars / 1000)}k chars for the full menu`
);
console.log(
  `content text (pretty, discarded by Claude Code): ` +
    `~${Math.round(textChars / menu.meals.length)} chars/meal, ~${Math.round(textChars / 1000)}k chars`
);

// A budget, not a target. 576 chars/meal measured on the 2026-08-17 menu after the trim,
// against 940 before it.
//
// This catches unbounded growth *within* the existing fields — a description or tag list
// that balloons upstream — which the key-set check above cannot see. It is deliberately not
// the guard for new or removed fields: a reintroduced `image` lands at 677 and passes here,
// so exact key equality is what carries that case.
const PER_MEAL_BUDGET = 700;
check(
  "list-view payload within budget",
  perMeal <= PER_MEAL_BUDGET,
  `${perMeal} chars/meal (budget ${PER_MEAL_BUDGET})`
);

done();
