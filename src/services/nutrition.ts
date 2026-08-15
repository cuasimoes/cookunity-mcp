import { Nutrient } from "../types.js";

/**
 * Fold an API nutrient name to a stable lookup key.
 *
 * The menu service mixes conventions within a single response — `saturatedFat`
 * and `totalFat` next to `added_sugar` and `total_carbohydrate` — and is not
 * even self-consistent: on the 2026-09-13 menu, 244 meals returned
 * `carbon_footprint` and one returned `carbonFootprint`. Lowercasing and
 * dropping separators collapses both spellings onto one key, so a rename from
 * snake to camel (or back) cannot silently drop a nutrient from output.
 */
export function canonicalNutrientName(name: string): string {
  return name.toLowerCase().replace(/[_\s-]/g, "");
}

/**
 * Index a meal's nutrients by canonical name.
 *
 * Later duplicates lose to earlier ones. That only matters if the API ever
 * returns both spellings of the same nutrient on one meal, which it does not
 * today — but silently summing or overwriting would be worse than picking one.
 */
export function nutrientsByName(nutrients: Nutrient[]): Map<string, Nutrient> {
  const index = new Map<string, Nutrient>();
  for (const nutrient of nutrients) {
    const key = canonicalNutrientName(nutrient.name);
    if (!index.has(key)) index.set(key, nutrient);
  }
  return index;
}

/**
 * Parse a nutrient amount, or null if the API did not supply a real one.
 *
 * `Number()` alone is not a usable guard here: `Number(null)`, `Number("")`,
 * `Number(false)` and `Number([])` are all a finite 0. A null column — the most
 * likely drift shape — would therefore render as "Cholesterol 0 mg", a claim
 * about food that the API never made, and one this module explicitly refuses to
 * make for `dailyValue` a few lines down. Absent must stay absent.
 *
 * Accepts a number, or a decimal string (nutritionalFacts already returns its
 * numbers as strings, so `nutrients` drifting the same way is plausible).
 * Rejects everything else, including hex and single-element arrays, which
 * `Number()` would otherwise coerce to a confident wrong answer.
 */
export function parseNutrientValue(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Coerce the raw `nutrients` array at the API boundary.
 *
 * Sibling field `nutritionalFacts` declares numbers and returns strings (see
 * issue #5). `nutrients.value` is a genuine number today; accepting a decimal
 * string here means a drift to `"21"` degrades to a working number rather than
 * to string concatenation in any consumer doing arithmetic.
 *
 * A row whose name or value is unusable is dropped, not guessed at. Dropping is
 * itself a silent failure mode, so `verify-menu.mts` asserts that the nutrients
 * a label must always carry are still present — a drop shows up there as a
 * missing nutrient rather than as a wrong number in the output.
 */
export function normalizeNutrients(raw: unknown): Nutrient[] {
  if (!Array.isArray(raw)) return [];
  const out: Nutrient[] = [];
  for (const entry of raw) {
    const row = entry as Record<string, unknown> | null | undefined;
    const name = String(row?.name ?? "").trim();
    const value = parseNutrientValue(row?.value);
    if (!name || value === null) continue;
    out.push({
      name,
      value,
      unit: String(row?.unit ?? ""),
      // "" is the API's own "no established DV" marker — preserve it, do not
      // invent a 0%.
      dailyValue: String(row?.dailyValue ?? ""),
    });
  }
  return out;
}
