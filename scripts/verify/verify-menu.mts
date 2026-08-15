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
