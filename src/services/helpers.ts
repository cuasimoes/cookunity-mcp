import type { Meal, FormattedMeal, UpcomingDay, DeliveryInfo } from "../types.js";

export function getNextMonday(): string {
  const today = new Date();
  const dayOfWeek = today.getDay();
  const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
  const nextMonday = new Date(today);
  nextMonday.setDate(today.getDate() + daysUntilMonday);
  return nextMonday.toISOString().split("T")[0];
}

/**
 * List-view projection of a meal.
 *
 * `structuredContent` is the agent's context cost, so this shape is the cost of browsing
 * a menu — measured at 940 chars/meal before trimming, ~95k tokens for a full scan
 * (`npm run probe:payload`). Two fields were dropped as pure payload: `searchBy.ingredients`
 * (264 chars/meal, 28% of the total — a single space-joined supplier blob that `searchMeals`
 * matches server-side and nothing downstream reads) and `image` (101 chars/meal, a URL no
 * agent can render). Full ingredients remain available per-meal via `get_meal_details`.
 */
export function formatMeal(meal: Meal): FormattedMeal {
  return {
    id: meal.id,
    name: meal.name,
    description: meal.shortDescription,
    chef: `${meal.chef.firstName} ${meal.chef.lastName}`,
    category: meal.category.title,
    price: meal.finalPrice,
    original_price: meal.price,
    rating: meal.userRating,
    inventory_id: meal.inventoryId,
    batch_id: meal.batchId,
    in_stock: meal.stock > 0,
    stock: meal.stock,
    is_new: meal.isNewMeal,
    nutrition: meal.nutritionalFacts,
    tags: {
      cuisines: meal.searchBy.cuisines,
      diet_tags: meal.searchBy.dietTags,
      protein_tags: meal.searchBy.proteinTags,
    },
    meat_type: meal.meatType,
  };
}

export function formatDelivery(day: UpcomingDay): DeliveryInfo {
  const status = !day.canEdit
    ? "locked"
    : day.skip
      ? "skipped"
      : day.isPaused
        ? "paused"
        : "active";

  const cartItems = (day.cart || []).map((c) => ({
    name: c.product?.name ?? "Unknown",
    inventory_id: c.product?.inventoryId ?? "",
    quantity: c.qty,
    price: c.product?.price_incl_tax ?? 0,
    chef: `${c.product?.chef_firstname ?? ""} ${c.product?.chef_lastname ?? ""}`.trim(),
  }));

  const orderInfo = day.order && day.order.items?.length > 0
    ? {
        id: day.order.id,
        status: day.order.orderStatus?.status ?? null,
        grand_total: day.order.grandTotal ?? 0,
        items: day.order.items.map((item) => ({
          name: item.product?.name ?? "Unknown",
          inventory_id: item.product?.inventoryId ?? "",
          quantity: item.qty,
          price: item.price?.price ?? 0,
          chef: `${item.product?.chef_firstname ?? ""} ${item.product?.chef_lastname ?? ""}`.trim(),
        })),
        item_count: day.order.items.reduce((sum, i) => sum + (i.qty || 0), 0),
      }
    : null;

  const recMeals = day.recommendation?.meals || [];
  const recommendationItems = recMeals.map((m) => ({
    name: m.name ?? "Unknown",
    inventory_id: m.inventoryId ?? "",
    quantity: m.qty ?? 1,
    price: 0,
    chef: `${m.chef_firstname ?? ""} ${m.chef_lastname ?? ""}`.trim(),
  }));

  return {
    date: day.displayDate,
    status,
    can_edit: day.canEdit,
    menu_available: day.menuAvailable,
    cutoff: day.cutoff?.time ?? null,
    cutoff_timezone: day.cutoff?.userTimeZone ?? null,
    cart_items: cartItems,
    cart_count: cartItems.reduce((sum, c) => sum + (c.quantity || 0), 0),
    order: orderInfo,
    recommendation_items: recommendationItems,
    recommendation_count: recommendationItems.reduce((sum, r) => sum + (r.quantity || 0), 0),
  };
}

export function formatMealMarkdown(m: FormattedMeal): string {
  const lines = [
    `### ${m.name}${m.is_new ? " 🆕" : ""}`,
    `**Chef**: ${m.chef} | **Category**: ${m.category}`,
    `**Price**: $${m.price.toFixed(2)}${m.price !== m.original_price ? ` (was $${m.original_price.toFixed(2)})` : ""} | **Rating**: ${m.rating}/5`,
    `**Stock**: ${m.in_stock ? m.stock : "Out of stock"} | **Inventory ID**: \`${m.inventory_id}\``,
    m.description,
    `🥩 ${m.meat_type} | ${m.nutrition.calories} cal`,
  ];
  if (m.tags.diet_tags.length > 0) lines.push(`🏷️ ${m.tags.diet_tags.join(", ")}`);
  return lines.join("\n");
}

// Type for tool call results compatible with MCP SDK
interface ToolResult {
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function handleError(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

export function toStructured(obj: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
}
