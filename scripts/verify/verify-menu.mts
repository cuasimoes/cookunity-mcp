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
import { formatMeal, formatMealMarkdown, getNextMonday } from "../../src/services/helpers.js";
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
try {
  const vegan = menu.meals.filter((m) => m.searchBy.dietTags.some((t) => t.toLowerCase().includes("vegan")));
  check("diet filter", true, `${vegan.length} vegan meals`);
} catch (error) {
  check("diet filter", false, String(error));
}

try {
  const hits = await api.searchMeals("salmon", date);
  check("searchMeals", true, `${hits.length} hits for "salmon"`);
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
const perMeal = Math.round(JSON.stringify(menu.meals.map(formatMeal)).length / menu.meals.length);
console.log(`\npayload: ~${perMeal} chars/meal, ~${Math.round((perMeal * menu.meals.length) / 1000)}k chars for the full menu`);

done();
