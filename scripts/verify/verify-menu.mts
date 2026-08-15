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
import { formatMeal, formatMealMarkdown, getNextMonday, toStructured } from "../../src/services/helpers.js";
import { nutrientsByName } from "../../src/services/nutrition.js";
import { resolveTokenPath, makeCheck } from "./_shared.mts";

const date = process.argv[2] ?? getNextMonday();
const api = new CookUnityAPI({ tokenFile: resolveTokenPath() });
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
  const withNutrients = detailed.filter((m) => m.nutrients.length > 0);
  check(
    "nutrients present",
    withNutrients.length === detailed.length,
    `${withNutrients.length}/${detailed.length} meals`
  );

  // The macronutrients carrying a % daily value. This is a presence check on the label, not
  // a policy: nothing here or in src/ knows about thresholds, and no consumer should read a
  // limit into this list. Named individually rather than counted — "5 nutrients found" would
  // still pass if cholesterol vanished and some other nutrient appeared twice.
  const LABELLED_MACROS = ["totalfat", "saturatedfat", "cholesterol", "sodium", "totalcarbohydrate"];
  // Checked against `detailed`, not `withNutrients`: a meal with no nutrients at all must
  // fail here too. Filtering first would make every assertion below vacuously true on the
  // exact regression they exist to catch — an empty array satisfies both some() and every().
  const missing = LABELLED_MACROS.filter((key) =>
    detailed.some((meal) => !nutrientsByName(meal.nutrients).has(key))
  );
  check(
    "labelled macros on every meal",
    missing.length === 0,
    missing.length === 0 ? LABELLED_MACROS.join(", ") : `missing on some meals: ${missing.join(", ")}`
  );

  // dailyValue is what makes this worth querying over nutritionalFacts. It is "" for
  // nutrients with no established DV, so assert on one that must always carry a percentage.
  const cholesterolDV = detailed.every((meal) => {
    const row = nutrientsByName(meal.nutrients).get("cholesterol");
    return row !== undefined && /^\d+(\.\d+)?%$/.test(row.dailyValue);
  });
  check("cholesterol carries a % daily value", cholesterolDV);

  // nutritionalFacts returns strings where types.ts declares numbers (issue #5). nutrients
  // does not — and normalizeNutrients coerces regardless. Assert the coercion holds.
  const numericValues =
    detailed.length > 0 &&
    detailed.every(
      (meal) =>
        meal.nutrients.length > 0 &&
        meal.nutrients.every((n) => typeof n.value === "number" && Number.isFinite(n.value))
    );
  check("nutrient values are finite numbers", numericValues);
} catch (error) {
  check("getMenuDetailed normalized", false, String(error));
}

// Payload sizing — the baseline issue #1 is measured against.
//
// Measure the real `output` object that cookunity_get_menu builds, not a bare array of
// formatted meals: `structuredContent` is `toStructured(output)`, so that object is the cost.
//
// The two numbers are NOT additive for Claude Code, which renders `structuredContent` and
// discards `content`. structuredContent is therefore the agent-context figure and the one #1
// is optimising; the content-text line is wire cost only, reported so the distinction stays
// visible and nobody re-derives it from a single conflated number.
const formattedAll = menu.meals.map(formatMeal);
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

done();
