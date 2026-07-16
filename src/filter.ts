export type TradeSide = "BUY" | "SELL" | string;

export interface Trade {
  proxyWallet: string;
  side: TradeSide;
  size: number;
  price: number;
  timestamp: number;
  title: string;
  slug: string;
  eventSlug: string;
  outcome?: string;
  asset?: string;
  conditionId?: string;
  outcomeIndex?: number;
  transactionHash: string;
}

export interface WorldCupMatcher {
  eventSlugs: string[];
  slugPrefixes: string[];
}

const EVENT_DATE_PATTERN = /(?:^|-)(20\d{2}-\d{2}-\d{2})(?:-|$)/;

export function tradeCashValue(trade: Trade): number {
  return trade.size * trade.price;
}

export function meetsCashThreshold(trade: Trade, thresholdUsdc: number): boolean {
  return tradeCashValue(trade) >= thresholdUsdc;
}

export function isWorldCupTrade(trade: Trade, matcher: WorldCupMatcher): boolean {
  const eventSlug = trade.eventSlug.toLowerCase();
  const slug = trade.slug.toLowerCase();
  const eventSlugs = matcher.eventSlugs.map((value) => value.toLowerCase());
  const prefixes = matcher.slugPrefixes.map((value) => value.toLowerCase());

  return (
    eventSlugs.includes(eventSlug) ||
    prefixes.some((prefix) => eventSlug.startsWith(prefix) || slug.startsWith(prefix))
  );
}

export function isEventDateCurrentOrFuture(trade: Trade, today = todayInTimeZone("Asia/Shanghai")): boolean {
  const eventDate = extractEventDate(trade.eventSlug) ?? extractEventDate(trade.slug);
  if (!eventDate) {
    return true;
  }

  return eventDate >= today;
}

export function extractEventDate(value: string): string | undefined {
  return EVENT_DATE_PATTERN.exec(value)?.[1];
}

export function buildTradeKey(trade: Trade): string {
  return [trade.transactionHash, trade.slug, trade.side, trade.size, trade.price].join("|");
}

function todayInTimeZone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error(`Unable to format current date for time zone ${timeZone}`);
  }

  return `${year}-${month}-${day}`;
}
