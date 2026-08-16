/**
 * What does a menu payload actually cost, field by field?
 *
 * `structuredContent` is what Claude Code puts in the agent's context — it renders the
 * structured object and discards `content` — so the size of `formatMeal`'s output *is*
 * the context cost of browsing a menu. This ranks the fields by how much of that they
 * account for, so trimming decisions are measured rather than guessed (issue #1).
 *
 *   npm run probe:payload
 *   npm run probe:payload -- 2026-09-13
 */
import { CookUnityAPI } from "../../src/services/api.js";
import { formatMeal, getNextMonday } from "../../src/services/helpers.js";
import { resolveTokenPath } from "./_shared.mts";

const date = process.argv[2] ?? getNextMonday();
const api = new CookUnityAPI({ tokenFile: resolveTokenPath() });

const menu = await api.getMenu(date);
const formatted = menu.meals.map(formatMeal);
console.log(`menu ${date}: ${formatted.length} meals\n`);

/** Bytes this field contributes to the serialized object, key included. */
function fieldCost(key: string, value: unknown): number {
  return JSON.stringify(key).length + 1 + JSON.stringify(value ?? null).length + 1;
}

const totals = new Map<string, number>();
const add = (key: string, bytes: number) => totals.set(key, (totals.get(key) ?? 0) + bytes);

for (const meal of formatted) {
  for (const [key, value] of Object.entries(meal)) {
    if (key === "tags") {
      for (const [tagKey, tagValue] of Object.entries(value as Record<string, unknown>)) {
        add(`tags.${tagKey}`, fieldCost(tagKey, tagValue));
      }
      continue;
    }
    add(key, fieldCost(key, value));
  }
}

const grand = JSON.stringify(formatted).length;

// Per-meal `{}`, the `"tags":{}` wrapper, and the array's brackets and separators. Small,
// but attributing it keeps the table exhaustive — otherwise the rows sum to ~97% and the
// TOTAL row silently absorbs the difference.
const attributed = [...totals.values()].reduce((sum, n) => sum + n, 0);
add("(structural overhead)", grand - attributed);

const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);

console.log("field                bytes      %     per meal");
console.log("-------------------- ---------- ----- --------");
for (const [field, bytes] of ranked) {
  const pct = ((bytes / grand) * 100).toFixed(1).padStart(5);
  const perMeal = (bytes / formatted.length).toFixed(0).padStart(8);
  console.log(`${field.padEnd(20)} ${String(bytes).padStart(10)} ${pct} ${perMeal}`);
}

const summed = [...totals.values()].reduce((sum, n) => sum + n, 0);
console.log("-------------------- ---------- ----- --------");
console.log(
  `${"TOTAL".padEnd(20)} ${String(grand).padStart(10)} ` +
    `${((summed / grand) * 100).toFixed(1).padStart(5)} ${(grand / formatted.length).toFixed(0).padStart(8)}`
);
console.log(`\n~${Math.round(grand / 4 / 1000)}k tokens for a full-menu scan (4 chars/token).`);
