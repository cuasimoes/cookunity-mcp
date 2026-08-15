/**
 * Does the built server actually work as an MCP server?
 *
 * Boots dist/index.js over stdio with token-file auth and drives it as a real client would:
 * initialize, list tools, call them. Catches everything tsc cannot — startup crashes, auth
 * wiring, tool registration, and whether a credential escapes to stderr.
 *
 * Requires a build first; `npm run verify:smoke` does both.
 */
import path from "path";
import { spawn } from "child_process";
import { REPO_ROOT, resolveTokenPath, makeCheck, looksLikeJwt } from "./_shared.mts";

const { check, done } = makeCheck();

const server = spawn("node", [path.join(REPO_ROOT, "dist/index.js")], {
  env: { ...process.env, COOKUNITY_TOKEN_FILE: resolveTokenPath(), TRANSPORT: "stdio" },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
server.stderr.on("data", (chunk) => (stderr += chunk.toString()));

// Attach at spawn, await in `finally`. Attaching the listener inside `finally` instead would
// never fire when the child has already closed — Node does not replay events — and the
// stderr assertions below would be skipped entirely on exactly the startup-crash path they
// exist to police. Guarding on `exitCode` does not help: it is set on `exit`, before `close`.
const closed = new Promise((resolve) => server.once("close", resolve));

const pending = new Map<number, (msg: Record<string, any>) => void>();
let buffer = "";
server.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    } catch {
      // Non-JSON on stdout is not fatal here; the stderr assertions below cover leakage.
    }
  }
});

let nextId = 1;
const send = (method: string, params: unknown): Promise<Record<string, any>> =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 30000);
  });

// `total` off a json-format tool response; -1 when it cannot be read, so callers fail loudly.
const totalOf = (text: string): number => {
  try {
    const total = JSON.parse(text)?.total;
    return typeof total === "number" ? total : -1;
  } catch {
    return -1;
  }
};

const callTool = async (name: string, args: Record<string, unknown>) => {
  const response = await send("tools/call", { name, arguments: args });
  return {
    failed: response.result?.isError === true,
    text: (response.result?.content?.[0]?.text ?? "") as string,
  };
};

try {
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  check("server initializes", Boolean(init.result?.serverInfo), init.result?.serverInfo?.name);

  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const tools = await send("tools/list", {});
  const names: string[] = (tools.result?.tools ?? []).map((t: { name: string }) => t.name);
  check("tools registered", names.length > 0, `${names.length} tools`);

  // Exercises token load, Bearer strip, exp decode, and a live authenticated request.
  const menu = await callTool("cookunity_get_menu", { limit: 1, response_format: "json" });
  check("authenticated tool call", !menu.failed && menu.text.includes("meals"), menu.failed ? menu.text.slice(0, 120) : `${menu.text.length} chars`);

  // The three surfaces that were entirely broken before PR #4.
  // `total > 0`, not just "no error" — a filter that silently matches nothing returns a
  // perfectly well-formed empty result, which is the regression most worth catching.
  const search = await callTool("cookunity_search_meals", { query: "salmon", limit: 2, response_format: "json" });
  check("search_meals", !search.failed && totalOf(search.text) > 0, search.failed ? search.text.slice(0, 90) : `${totalOf(search.text)} hits`);

  const diet = await callTool("cookunity_get_menu", { diet: "vegan", limit: 2, response_format: "json" });
  check("diet filter", !diet.failed && totalOf(diet.text) > 0, diet.failed ? diet.text.slice(0, 90) : `${totalOf(diet.text)} vegan meals`);

  const markdown = await callTool("cookunity_get_menu", { limit: 2, response_format: "markdown" });
  check("markdown menu", !markdown.failed && markdown.text.includes("###"), markdown.failed ? markdown.text.slice(0, 90) : `${markdown.text.split("\n").length} lines`);

  // get_meal_details is the only tool that renders the nutrition label, and the label is the
  // reason it queries Meal.nutrients at all. Asserting on a named nutrient rather than on the
  // table header: a renderer that emitted headers and no rows would satisfy a header check
  // while losing every number, which is the failure worth catching.
  const first = JSON.parse(menu.text)?.meals?.[0];
  const inventoryId = first?.inventory_id;
  if (typeof inventoryId !== "string") {
    check("meal details — nutrition label", false, "could not read an inventory_id from get_menu");
  } else {
    const details = await callTool("cookunity_get_meal_details", {
      inventory_id: inventoryId,
      response_format: "markdown",
    });
    const hasLabel =
      !details.failed &&
      details.text.includes("% Daily Value") &&
      /\|\s*Cholesterol\s*\|/.test(details.text);
    check("meal details — nutrition label", hasLabel, details.failed ? details.text.slice(0, 90) : first.name);

    // The JSON view is a separate code path from the markdown table.
    const detailsJson = await callTool("cookunity_get_meal_details", {
      inventory_id: inventoryId,
      response_format: "json",
    });
    const label = detailsJson.failed ? null : JSON.parse(detailsJson.text)?.nutrition_label;
    const hasCholesterol =
      Array.isArray(label) &&
      label.some((n: { name?: string; daily_value?: string }) => n?.name === "cholesterol" && typeof n.daily_value === "string");
    check("meal details — nutrition_label[] json", hasCholesterol, Array.isArray(label) ? `${label.length} rows` : "no nutrition_label array");
  }
} catch (error) {
  check("smoke run", false, error instanceof Error ? error.message : String(error));
} finally {
  // Await `close`, not just `kill()`. The stdout handler that resolves the last request runs
  // before pending stderr `data` events are delivered, so asserting straight after kill()
  // reads a buffer that has not been filled yet — the leak check below would report PASS on
  // a credential that was in fact written.
  server.kill();
  await closed;
}

check("startup banner on stderr", stderr.includes("running via stdio"), JSON.stringify(stderr.trim().slice(0, 60)));
check("no credential on stderr", !looksLikeJwt(stderr));

done();
