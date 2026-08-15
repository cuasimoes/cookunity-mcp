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
 * Coerce the raw `nutrients` array at the API boundary.
 *
 * Sibling field `nutritionalFacts` declares numbers and returns strings (see
 * issue #5). `nutrients.value` is a genuine number today; coercing here means a
 * drift to `"21"` degrades to a working number rather than to string
 * concatenation in any consumer doing arithmetic. Rows without a usable name or
 * value are dropped rather than surfaced as `NaN`.
 */
export function normalizeNutrients(raw: unknown): Nutrient[] {
  if (!Array.isArray(raw)) return [];
  const out: Nutrient[] = [];
  for (const entry of raw) {
    const row = entry as Record<string, unknown> | null | undefined;
    const name = String(row?.name ?? "").trim();
    const value = Number(row?.value);
    if (!name || !Number.isFinite(value)) continue;
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
