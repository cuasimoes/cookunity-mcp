import type { UpcomingDay } from "../types.js";
import type { CookUnityAPI } from "./api.js";

/**
 * A date that is not one of the account's scheduled deliveries.
 *
 * Worth its own type because the API never raises this itself: `upcomingDays` returns every
 * slot CookUnity could deliver on, and the menu query serves a full menu for any of them. A
 * date the user has not scheduled yields plausible data carrying ids that attach to no order.
 */
export class DeliveryDateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryDateError";
  }
}

/**
 * Today as YYYY-MM-DD on the local calendar.
 *
 * Not `toISOString()`: delivery dates are calendar days, and UTC runs a day ahead every
 * evening in the Americas — long enough to drop a same-day delivery from "upcoming".
 */
export function localToday(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Pick the delivery a date-taking tool should act on.
 *
 * With `requested`, it must be a scheduled delivery — skipped or locked ones included, since
 * reading a locked week's cart or a skipped week's menu is legitimate. Without it, the nearest
 * scheduled delivery the user can still edit and will actually receive — not skipped, not
 * paused: the week being chosen for, not tomorrow's already-placed order.
 *
 * Matches on `date` only. `displayDate` has equalled `date` on every slot observed; matching
 * either would let a caller fetch data for one and resolve the delivery to the other.
 *
 * @throws DeliveryDateError when `requested` is not scheduled, or no editable delivery exists.
 */
export function selectDeliveryDay(
  days: UpcomingDay[],
  requested: string | undefined,
  today: string
): UpcomingDay {
  const scheduled = days.filter((d) => d.scheduled).sort((a, b) => a.date.localeCompare(b.date));
  // Upcoming only: past deliveries stay valid to request, but listing them first invites a
  // caller to take the first date and read last week's menu.
  const upcoming = scheduled.filter((d) => d.date >= today).map((d) => d.date).join(", ") || "none";

  if (requested !== undefined) {
    const day = scheduled.find((d) => d.date === requested);
    if (!day) {
      throw new DeliveryDateError(
        `${requested} is not one of your scheduled deliveries. Upcoming scheduled: ${upcoming}. ` +
          "Take dates from cookunity_list_deliveries — delivery days vary by account, so never compute one."
      );
    }
    return day;
  }

  const next = scheduled.find((d) => !d.skip && !d.isPaused && d.canEdit && d.date >= today);
  if (!next) {
    throw new DeliveryDateError(
      `No upcoming delivery is still editable. Upcoming scheduled: ${upcoming}. ` +
        "Pass a date from cookunity_list_deliveries."
    );
  }
  return next;
}

export async function resolveDeliveryDay(api: CookUnityAPI, requested?: string): Promise<UpcomingDay> {
  return selectDeliveryDay(await api.getUpcomingDays(), requested, localToday());
}

/**
 * Resolve the delivery date, then fetch data for it.
 *
 * A supplied date is validated in parallel with the fetch rather than before it: the fetch
 * already knows its date, and an invalid one is the rare path, so sequencing would add a full
 * round-trip to every valid call to save one wasted fetch on an error. Without a date the
 * fetch has nothing to fetch until resolution finishes.
 *
 * Settled rather than `Promise.all`, so a date error wins over a fetch error: the date error
 * names the valid dates, which is the actionable message when both go wrong.
 */
export async function fetchForDelivery<T>(
  api: CookUnityAPI,
  requested: string | undefined,
  fetch: (date: string) => Promise<T>
): Promise<{ date: string; data: T }> {
  if (requested === undefined) {
    const day = await resolveDeliveryDay(api);
    return { date: day.date, data: await fetch(day.date) };
  }
  const [resolved, fetched] = await Promise.allSettled([resolveDeliveryDay(api, requested), fetch(requested)]);
  if (resolved.status === "rejected") throw resolved.reason;
  if (fetched.status === "rejected") throw fetched.reason;
  return { date: requested, data: fetched.value };
}
