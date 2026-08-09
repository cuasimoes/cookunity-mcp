import axios, { AxiosError } from "axios";
import { CookUnityAuth, AuthOptions } from "./auth.js";
import { MENU_SERVICE_URL, SUBSCRIPTION_URL } from "../constants.js";
import type {
  Menu,
  Meal,
  MealSearchBy,
  DetailedMeal,
  UserInfo,
  Order,
  CartItem,
  UpcomingDay,
  SkipResult,
  MealInput,
  PriceBreakdown,
  Invoice,
} from "../types.js";

// The menu API declares searchBy list fields as lists but returns them as comma-joined
// strings ("Vegan, Plant-Based"). The GraphQL response is untyped, so this slips past the
// compiler and only surfaces as a runtime TypeError on .some()/.join(). Normalize here so
// every caller downstream can rely on MealSearchBy actually being string[].
//
// `ingredients` is the exception and must NOT be split. It is space-joined, and 26% of meals
// (105 of 401 on the 2026-08-10 menu) carry commas *inside* a single ingredient name — the
// supplier-style "Veg, Tomatoes, Whole, Canned, Italian" is one ingredient, not five.
// Splitting it yields fragments like "Whole" and "Canned". Keeping the blob intact preserves
// the substring matching in searchMeals, which is all this field feeds; use the real
// `ingredients { name }` array from getMenuDetailed when an actual list is needed.
function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  return value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function toSingleton(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  return trimmed ? [trimmed] : [];
}

function normalizeMeal<T extends Meal>(meal: T): T {
  const raw = meal.searchBy as unknown as Record<string, unknown> | null | undefined;
  // Annotated rather than inlined into the return. Inside a generic returning T, an inline
  // `{ ...meal, searchBy: { ... } }` is not excess-property-checked — tsc accepts a plain
  // string where string[] is declared, which is the exact bug this function exists to fix.
  // The annotation is what makes the compiler guard this boundary going forward.
  const searchBy: MealSearchBy = {
    chefFirstName: String(raw?.chefFirstName ?? ""),
    chefLastName: String(raw?.chefLastName ?? ""),
    cuisines: toStringList(raw?.cuisines),
    dietTags: toStringList(raw?.dietTags),
    proteinTags: toStringList(raw?.proteinTags),
    ingredients: toSingleton(raw?.ingredients),
  };
  return { ...meal, searchBy };
}

export class CookUnityAPI {
  private auth: CookUnityAuth;

  constructor(opts: AuthOptions) {
    this.auth = new CookUnityAuth(opts);
  }

  async getMenu(date: string, filters: Record<string, unknown> = {}): Promise<Menu> {
    const query = `
      query getMenu($date: String!, $filters: MenuFilters!) {
        menu(date: $date, filters: $filters) {
          categories { id title subtitle label tag }
          meals {
            id batchId name shortDescription image imagePath price finalPrice premiumFee
            sku stock isNewMeal userRating inventoryId categoryId
            searchBy { cuisines chefFirstName chefLastName dietTags ingredients proteinTags }
            nutritionalFacts { calories fat carbs sodium fiber }
            chef { id firstName lastName }
            meatType category { id title label }
          }
        }
      }
    `;
    const data = await this.queryMenu(query, { date, filters });
    const menu = data.menu as Menu;
    return { ...menu, meals: menu.meals.map(normalizeMeal) };
  }

  async getMenuDetailed(date: string): Promise<DetailedMeal[]> {
    const query = `
      query getMenu($date: String!, $filters: MenuFilters!) {
        menu(date: $date, filters: $filters) {
          meals {
            id batchId name shortDescription image imagePath price finalPrice premiumFee
            sku stock isNewMeal userRating inventoryId categoryId
            searchBy { cuisines chefFirstName chefLastName dietTags ingredients proteinTags }
            nutritionalFacts { calories fat carbs sodium fiber protein sugar }
            chef { id firstName lastName }
            meatType category { id title label }
            allergens { name }
            ingredients { name }
          }
        }
      }
    `;
    const data = await this.queryMenu(query, { date, filters: {} });
    return (data.menu as { meals: DetailedMeal[] }).meals.map(normalizeMeal);
  }

  async getUserInfo(): Promise<UserInfo> {
    const query = `
      query {
        users {
          id name email plan_id store_id status
          deliveryDays { id day time_start time_end }
          currentCredit
          ring { id name is_local }
          addresses { id isActive city region postcode street }
          profiles { id firstname lastname }
        }
      }
    `;
    const data = await this.querySubscription(query);
    return (data.users as UserInfo[])[0];
  }

  async getAllOrders(): Promise<Order[]> {
    const data = await this.querySubscription(`query { allOrders { id deliveryDate } }`);
    return data.allOrders as Order[];
  }

  async getUpcomingDays(): Promise<UpcomingDay[]> {
    const query = `
      query upcomingDays {
        upcomingDays {
          id date displayDate available menuAvailable canEdit skip isPaused
          scheduled
          cutoff { time userTimeZone __typename }
          cart {
            product {
              id inventoryId name sku image_path price_incl_tax realPrice
              chef_firstname chef_lastname meat_type premium_special
              __typename
            }
            qty
            __typename
          }
          recommendation {
            meals {
              name inventoryId chef_firstname chef_lastname meat_type qty premium_special
              __typename
            }
            __typename
          }
          order {
            id grandTotal
            orderStatus { state status __typename }
            items {
              qty
              product {
                id inventoryId name chef_firstname chef_lastname meat_type premium_special
                __typename
              }
              price { price originalPrice __typename }
              __typename
            }
            __typename
          }
          __typename
        }
      }
    `;
    const data = await this.querySubscription(query, {}, "upcomingDays");
    return data.upcomingDays as UpcomingDay[];
  }

  async addMeal(
    date: string,
    inventoryId: string,
    quantity: number = 1,
    batchId?: number
  ): Promise<{ added: CartItem; cart: CartItem[] }> {
    const mutation = `
      mutation addMeal($date: String!, $batch_id: Int, $quantity: Int!, $inventory_id: String) {
        addMeal(date: $date, batch_id: $batch_id, quantity: $quantity, inventory_id: $inventory_id) {
          qty: quantity
          inventoryId
        }
      }
    `;
    const data = await this.querySubscription(mutation, {
      date,
      batch_id: batchId,
      quantity,
      inventory_id: inventoryId,
    });
    // API returns the full cart as an array, not just the added item
    const cart = data.addMeal as CartItem[];
    const added = cart.find((item) => item.inventoryId === inventoryId) ?? { qty: quantity, inventoryId };
    return { added, cart };
  }

  async removeMeal(date: string, inventoryId: string, quantity: number = 1): Promise<CartItem> {
    const mutation = `
      mutation removeProductFromCart($date: String!, $quantity: Int!, $inventory_id: String) {
        deleteMeal(date: $date, quantity: $quantity, inventory_id: $inventory_id) {
          qty: quantity
          inventoryId
        }
      }
    `;
    const data = await this.querySubscription(mutation, { date, quantity, inventory_id: inventoryId });
    return data.deleteMeal as CartItem;
  }

  async clearCart(date: string): Promise<boolean> {
    await this.querySubscription(
      `mutation deleteCart($date: String!) { deleteCart(date: $date) }`,
      { date }
    );
    return true;
  }

  async skipDelivery(date: string): Promise<SkipResult> {
    const mutation = `
      mutation createSkip($skip: SkipInput!, $origin: OperationOrigin) {
        createSkip(skip: $skip, origin: $origin) {
          __typename
          ... on Skip { id }
          ... on OrderCreationError { error }
        }
      }
    `;
    const data = await this.querySubscription(mutation, {
      skip: { date, deliveryDate: date },
      origin: "unsubscription",
    });
    return data.createSkip as SkipResult;
  }

  async unskipDelivery(date: string): Promise<SkipResult> {
    const mutation = `
      mutation createUnskip($unskip: SkipInput!, $origin: OperationOrigin) {
        createUnskip(unskip: $unskip, origin: $origin) {
          __typename
          ... on Skip { id }
          ... on OrderCreationError { error }
        }
      }
    `;
    const data = await this.querySubscription(mutation, {
      unskip: { date, deliveryDate: date },
      origin: "unsubscription",
    });
    return data.createUnskip as SkipResult;
  }

  async createOrder(
    deliveryDate: string,
    start: string,
    end: string,
    products: Array<{ qty: number; inventoryId: string }>,
    options?: { comment?: string; tip?: number }
  ): Promise<{ __typename: string; id?: string; deliveryDate?: string; paymentStatus?: string; error?: string; outOfStockIds?: string[] }> {
    const mutation = `
      mutation createOrder($order: CreateOrderInput!) {
        createOrder(order: $order) {
          __typename
          ... on OrderCreation { id deliveryDate paymentStatus }
          ... on OrderCreationError { error outOfStockIds }
        }
      }
    `;
    const order: Record<string, unknown> = {
      deliveryDate,
      start,
      end,
      products: products.map((p) => ({ qty: p.qty, inventoryId: p.inventoryId })),
    };
    if (options?.comment) order.comment = options.comment;
    if (options?.tip != null) order.tip = options.tip;
    const data = await this.querySubscription(mutation, { order });
    return data.createOrder as { __typename: string; id?: string; deliveryDate?: string; paymentStatus?: string; error?: string; outOfStockIds?: string[] };
  }

  async getPriceBreakdown(date: string, meals: MealInput[]): Promise<PriceBreakdown> {
    const query = `
      query getOrderDetail($date: String!, $cartId: String, $meals: [MealInput]) {
        getOrderDetail(date: $date, cartId: $cartId, meals: $meals) {
          qtyPlanMeals qtyItems totalPlanPrice totalExtraMeals totalTaxes
          totalDeliveryFee totalExpressFee totalFee subTotalOrder
          totalPromoDiscount totalOrder availableCredits totalOrderWithCreditsSubtracted
        }
      }
    `;
    const data = await this.querySubscription(query, { date, meals });
    return data.getOrderDetail as PriceBreakdown;
  }

  async getInvoices(from: string, to: string, offset: number = 0, limit: number = 10): Promise<Invoice[]> {
    const query = `
      query getInvoices($date: InvoicesInput!, $liteVersion: Boolean!, $offset: Int, $limit: Int) {
        invoices(date: $date, liteVersion: $liteVersion, limit: $limit, offset: $offset) {
          id customerId date customerName deliveryAddress
          subtotal deliveryFee expressFee taxes tip discount chargedCredit total
          ccNumber planId createdAt updatedAt
          charges {
            id chargeId status stripeId
            refund { amount createdAt updatedAt __typename }
            createdAt updatedAt __typename
          }
          orders {
            id delivery_date display_date time_start time_end
            items {
              product {
                id name sku short_description image calories category_id
                sidedish chef_firstname chef_lastname meat_type stars user_rating
                premium_special
                review { id order product rating review reasons created_at __typename }
                __typename
              }
              price { price originalPrice priceIncludingTax basePriceIncludingTax __typename }
              qty __typename
            }
            __typename
          }
          __typename
        }
      }
    `;
    const data = await this.querySubscription(query, {
      date: { from, to },
      liteVersion: false,
      offset,
      limit,
    });
    return data.invoices as Invoice[];
  }

  async searchMeals(keyword: string, date: string): Promise<Meal[]> {
    const menu = await this.getMenu(date);
    const term = keyword.toLowerCase();
    return menu.meals.filter((meal) => {
      if (meal.name.toLowerCase().includes(term)) return true;
      if (meal.shortDescription.toLowerCase().includes(term)) return true;
      const s = meal.searchBy;
      if (s.cuisines.some((c) => c.toLowerCase().includes(term))) return true;
      if (s.dietTags.some((t) => t.toLowerCase().includes(term))) return true;
      if (s.ingredients.some((i) => i.toLowerCase().includes(term))) return true;
      if (s.proteinTags.some((p) => p.toLowerCase().includes(term))) return true;
      if (`${s.chefFirstName} ${s.chefLastName}`.toLowerCase().includes(term)) return true;
      if (meal.category.title.toLowerCase().includes(term)) return true;
      return false;
    });
  }

  // --- private helpers ---

  private async queryMenu(
    query: string,
    variables: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    return this.executeGraphQL(MENU_SERVICE_URL, query, variables);
  }

  private async querySubscription(
    query: string,
    variables: Record<string, unknown> = {},
    operationName?: string
  ): Promise<Record<string, unknown>> {
    return this.executeGraphQL(SUBSCRIPTION_URL, query, variables, operationName);
  }

  private async executeGraphQL(
    endpoint: string,
    query: string,
    variables: Record<string, unknown> = {},
    operationName?: string
  ): Promise<Record<string, unknown>> {
    const accessToken = await this.auth.getAccessToken();
    try {
      const body: Record<string, unknown> = { query, variables };
      if (operationName) body.operationName = operationName;
      const response = await axios.post(
        endpoint,
        body,
        {
          headers: {
            Authorization: accessToken,
            "Content-Type": "application/json",
            "User-Agent": "CookUnity-MCP/1.0.0",
          },
          timeout: 30000,
        }
      );
      const result = response.data as { data?: Record<string, unknown>; errors?: Array<{ message: string }> };
      if (result.errors) {
        throw new Error(`GraphQL errors: ${result.errors.map((e: { message: string }) => e.message).join(", ")}`);
      }
      return result.data!;
    } catch (error) {
      if (error instanceof AxiosError) {
        const status = error.response?.status;
        if (status === 401) throw new Error("Authentication expired or revoked. If using COOKUNITY_TOKEN_FILE, harvest a fresh token; otherwise verify COOKUNITY_EMAIL and COOKUNITY_PASSWORD.");
        if (status === 429) throw new Error("Rate limited by CookUnity API. Please wait before retrying.");
        throw new Error(`CookUnity API error (HTTP ${status ?? "unknown"}): ${error.message}`);
      }
      throw error;
    }
  }
}
