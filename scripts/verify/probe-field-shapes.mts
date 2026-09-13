/**
 * What shapes is the menu API actually returning today?
 *
 * The GraphQL response is cast untyped, so types.ts can drift from reality without tsc
 * noticing — that drift is what broke search_meals, the diet filter and all markdown
 * rendering (PR #4). This probe reads the RAW response, before normalization, and reports
 * the runtime type of each field types.ts makes a claim about.
 *
 * Run it when something breaks for no apparent reason, or before trusting a field's shape.
 *
 *   npm run probe:fields
 */
import axios from "axios";
import type { AxiosResponse } from "axios";
import { MENU_SERVICE_URL } from "../../src/constants.js";
import { CookUnityAPI } from "../../src/services/api.js";
import { resolveDeliveryDay } from "../../src/services/delivery-dates.js";
import { loadToken, resolveTokenPath } from "./_shared.mts";

// Without an argument this needs a working delivery calendar and an editable delivery. This
// probe is for when the API has broken — if the calendar is what broke, pass a date.
const date = process.argv[2] ?? (await resolveDeliveryDay(new CookUnityAPI({ tokenFile: resolveTokenPath() }))).date;
const token = loadToken();

const query = `
  query getMenu($date: String!, $filters: MenuFilters!) {
    menu(date: $date, filters: $filters) {
      meals {
        name userRating
        searchBy { cuisines dietTags ingredients proteinTags }
        nutritionalFacts { calories fat carbs sodium fiber }
      }
    }
  }`;

// An AxiosError carries `config.headers.Authorization`, so letting one reach the default
// uncaught-exception handler prints the bearer token to stderr several times over. Token
// refresh is manual by design (#2), which makes an expired token the *expected* failure
// here — exactly the path that must never surface the error object itself.
let response: AxiosResponse<{ data?: { menu?: { meals?: RawMeal[] } }; errors?: { message?: string }[] }>;
try {
  response = await axios.post(
    MENU_SERVICE_URL,
    { query, variables: { date, filters: {} } },
    { headers: { Authorization: token, "Content-Type": "application/json" } }
  );
} catch (error) {
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`Menu request failed${status ? ` (HTTP ${status})` : ""}: ${detail}`);
  if (status === 401 || status === 403) console.error("Token rejected — run `npm run verify:token`.");
  process.exit(1);
}

const errors = response.data?.errors;
if (Array.isArray(errors) && errors.length > 0) {
  console.error(`GraphQL error: ${errors.map((e: { message?: string }) => e.message ?? "unknown").join("; ")}`);
  process.exit(1);
}

type RawMeal = {
  name: string;
  userRating: unknown;
  searchBy: Record<string, unknown>;
  nutritionalFacts: Record<string, unknown>;
};

const meals: RawMeal[] = response.data?.data?.menu?.meals ?? [];
if (meals.length === 0) {
  console.log(`No meals returned for ${date}. Pass a different YYYY-MM-DD as the first argument.`);
  process.exit(1);
}

const runtimeType = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const tally = (values: unknown[]) => {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(runtimeType(v), (counts.get(runtimeType(v)) ?? 0) + 1);
  return [...counts].map(([t, n]) => `${t}×${n}`).join(" ");
};

console.log(`menu ${date}: ${meals.length} meals\n`);
console.log("types.ts claims vs. what the API returns:\n");

const declared: Record<string, string> = {
  "searchBy.cuisines": "string[]",
  "searchBy.dietTags": "string[]",
  "searchBy.ingredients": "string[]",
  "searchBy.proteinTags": "string[]",
  "userRating": "number",
  "nutritionalFacts.calories": "number",
  "nutritionalFacts.fat": "number",
  "nutritionalFacts.carbs": "number",
  "nutritionalFacts.sodium": "number",
  "nutritionalFacts.fiber": "number",
};

const read = (m: RawMeal, key: string): unknown => {
  const [group, field] = key.split(".");
  if (!field) return (m as unknown as Record<string, unknown>)[group];
  return (m[group as "searchBy" | "nutritionalFacts"] ?? {})[field];
};

// Fields normalizeMeal already repairs. They still show as mismatched here because this probe
// reads the raw response — that is the point, it is how a future re-break stays visible.
const normalized = new Set([
  "searchBy.cuisines",
  "searchBy.dietTags",
  "searchBy.ingredients",
  "searchBy.proteinTags",
]);

let unhandled = 0;
for (const [key, claim] of Object.entries(declared)) {
  const values = meals.map((m) => read(m, key));
  const actual = tally(values);
  const expected = claim.endsWith("[]") ? "array" : claim;
  const matches = values.every((v) => runtimeType(v) === expected);
  const handled = normalized.has(key);
  if (!matches && !handled) unhandled += 1;
  const flag = matches ? "  " : handled ? "ok" : "!!";
  const note = !matches && handled ? "  (normalized in api.ts)" : "";
  console.log(`  ${flag} ${key.padEnd(28)} declared ${claim.padEnd(9)} actual ${actual}${note}`);
}

// Delimiter convention matters: splitting a field on the wrong separator invents entries that
// were never there. `ingredients` is the known trap — its commas sit inside single names.
console.log("\ndelimiters in string-valued searchBy fields:\n");
for (const field of ["cuisines", "dietTags", "ingredients", "proteinTags"]) {
  const strings = meals.map((m) => m.searchBy?.[field]).filter((v): v is string => typeof v === "string" && v.trim() !== "");
  if (strings.length === 0) continue;
  const withComma = strings.filter((s) => s.includes(",")).length;
  const pct = Math.round((withComma / strings.length) * 100);
  console.log(`  ${field.padEnd(13)} non-empty ${String(strings.length).padEnd(4)} with commas ${String(withComma).padEnd(4)} (${pct}%)`);
}

console.log(
  unhandled === 0
    ? "\nEvery mismatch is already normalized in api.ts. Nothing unhandled."
    : `\n${unhandled} field(s) mismatch types.ts and are NOT normalized — see issue #5.\n` +
        "A field marked !! reaches callers with the wrong runtime type."
);
