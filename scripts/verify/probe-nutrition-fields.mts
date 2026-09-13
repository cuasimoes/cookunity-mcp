/**
 * Discover which fields the menu service actually exposes on its nutrition types.
 *
 * Why: getMenu/getMenuDetailed hardcode their `nutritionalFacts` selection sets
 * (src/services/api.ts). A nutrient absent from our output may be missing only
 * because we never asked for it. Server-side introspection is disabled (Apollo
 * returns INTROSPECTION_DISABLED), so we request one candidate field at a time
 * and classify the response.
 *
 * Reading the result: GraphQL validates a document before it authorizes it.
 * Only "Cannot query field X on type Y" means the field does not exist. Any
 * other error — notably the resolver's "Valid user needed." — means the
 * document passed validation, so the field IS real and we were merely refused.
 * Treating every error as absence produces false negatives on exactly the
 * fields worth finding.
 *
 * SAFETY: this script authenticates against production with a live bearer
 * token. An axios error object carries the full request config, including the
 * Authorization header, so the raw error must never be printed. A GraphQL
 * server also returns HTTP 200 with an `errors` array for resolver failures,
 * so the success path can carry server text too. Every printed string is
 * therefore routed through redact().
 */
import axios from "axios";
import { loadToken, looksLikeJwt, resolveTokenPath } from "./_shared.mts";
import { MENU_SERVICE_URL } from "../../src/constants.js";
import { CookUnityAPI } from "../../src/services/api.js";
import { resolveDeliveryDay } from "../../src/services/delivery-dates.js";

const token = loadToken();
const date = process.argv[2] ?? (await resolveDeliveryDay(new CookUnityAPI({ tokenFile: resolveTokenPath() }))).date;
const REQUEST_TIMEOUT_MS = 30_000;

/** A field known to exist, so a probe query fails only because of the candidate. */
const ANCHOR_FIELD = "calories";

/** Candidate scalar fields on the NutritionalFacts type. */
const CANDIDATES = [
  "saturatedFat",
  "cholesterol",
  "transFat",
  "servingSize",
  "potassium",
];

/** Candidate nutrition-bearing fields on the parent Meal type. */
const MEAL_CANDIDATES = [
  "nutrients",
  "nutritionalGroups",
  "nutritionalInfo",
  "macros",
];

/** Subfield shapes to probe on whichever Meal-level containers exist. */
const SUBFIELDS = ["name", "label", "key", "value", "amount", "unit", "dailyValue"];

/** Last line of defence: never emit anything JWT-shaped, whatever its source. */
function redact(text: string): string {
  return looksLikeJwt(text) ? "(redacted: output contained something JWT-shaped)" : text;
}

/** Server-supplied response body only — never the axios error, which holds the token. */
function serverBody(err: unknown): string {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  return redact(data === undefined ? "(no response body)" : JSON.stringify(data));
}

/**
 * ABSENT only for a validation error naming an unknown field. Everything else
 * (auth refusal, wrong selection shape) proves the field exists — see the
 * module comment.
 */
function classify(message: string): string {
  const clean = redact(message);
  if (/Cannot query field/i.test(clean)) return `ABSENT  — ${clean}`;
  return `EXISTS  — passed validation; ${clean}`;
}

async function probe(selection: string): Promise<string> {
  const query = `
    query ProbeField($date: String!, $filters: MenuFilters!) {
      menu(date: $date, filters: $filters) {
        meals { ${selection} }
      }
    }
  `;
  try {
    const res = await axios.post(
      MENU_SERVICE_URL,
      { query, variables: { date, filters: {} } },
      {
        headers: { Authorization: token, "Content-Type": "application/json" },
        timeout: REQUEST_TIMEOUT_MS,
      }
    );
    const errs = (res.data as { errors?: { message: string }[] }).errors;
    if (errs?.length) return classify(errs[0].message);
    return "EXISTS  — resolved";
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    const body = serverBody(err);
    if (status === 429) return `UNKNOWN — rate limited (429); re-run later`;
    const match = /Cannot query field[^"]*"[^"]*"[^"]*"[^"]*"/i.exec(body);
    return match ? `ABSENT  — ${match[0]}` : `UNKNOWN — HTTP ${status ?? "?"}: ${body}`;
  }
}

console.log(`menu date: ${date}\n`);

console.log("--- fields on NutritionalFacts ---");
for (const field of CANDIDATES) {
  console.log(`${field.padEnd(20)} ${await probe(`nutritionalFacts { ${ANCHOR_FIELD} ${field} }`)}`);
}

console.log("\n--- nutrition-bearing containers on Meal ---");
for (const field of MEAL_CANDIDATES) {
  console.log(`${field.padEnd(20)} ${await probe(`id ${field} { __typename }`)}`);
}

for (const parent of ["nutrients", "nutritionalGroups"]) {
  console.log(`\n--- subfields on Meal.${parent} ---`);
  for (const sub of SUBFIELDS) {
    console.log(`${sub.padEnd(20)} ${await probe(`id ${parent} { ${sub} }`)}`);
  }
}
