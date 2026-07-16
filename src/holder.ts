import type { HolderAlertState } from "./state.js";

export type TargetMarketType = "moneyline" | "spread" | "total";

export interface MatchEvent {
  slug: string;
  title: string;
  gameStartTime: string;
  markets: HolderMarket[];
}

export interface HolderMarket {
  eventSlug: string;
  eventTitle: string;
  gameStartTime: string;
  slug: string;
  question: string;
  conditionId: string;
  type: TargetMarketType;
  outcomes: string[];
  clobTokenIds: string[];
}

export interface TopHolder {
  wallet: string;
  name?: string;
  pseudonym?: string;
  tokenId: string;
  outcomeIndex: number;
  shares: number;
}

export interface HolderPosition {
  wallet: string;
  tokenId: string;
  conditionId: string;
  marketSlug: string;
  outcome: string;
  shares: number;
  avgPrice: number;
  initialValue?: number;
}

export interface HolderCostAlert {
  key: string;
  eventSlug: string;
  eventTitle: string;
  gameStartTime: string;
  marketSlug: string;
  marketTitle: string;
  marketType: TargetMarketType;
  conditionId: string;
  outcome: string;
  outcomeTokenId: string;
  wallet: string;
  holderName?: string;
  holderPseudonym?: string;
  shares: number;
  avgPrice: number;
  costUsdc: number;
  previousCostUsdc?: number;
  costIncreaseUsdc?: number;
  marketUrl: string;
  walletUrl: string;
}

export function isMatchInMonitorWindow(
  gameStartTime: string,
  now: Date,
  prematchMinutes: number,
  durationMinutes: number
): boolean {
  const startMs = Date.parse(gameStartTime);
  if (!Number.isFinite(startMs)) {
    return false;
  }

  const nowMs = now.getTime();
  return nowMs >= startMs - prematchMinutes * 60_000 && nowMs <= startMs + durationMinutes * 60_000;
}

export function classifyTargetMarket(market: { slug?: string; question?: string; groupItemTitle?: string }): TargetMarketType | null {
  const slug = (market.slug ?? "").toLowerCase();
  const question = (market.question ?? "").toLowerCase();
  const groupItemTitle = (market.groupItemTitle ?? "").toLowerCase();
  const haystack = `${slug} ${question} ${groupItemTitle}`;

  if (slug.endsWith("-draw") || /^will .+ win on \d{4}-\d{2}-\d{2}\?$/i.test(market.question ?? "")) {
    return "moneyline";
  }

  if (slug.includes("-spread-") || question.startsWith("spread:")) {
    return "spread";
  }

  if (slug.includes("-total-") || haystack.includes("o/u")) {
    return "total";
  }

  return null;
}

export function isTargetHolderMarket(market: { type: TargetMarketType; slug?: string }): boolean {
  const slug = (market.slug ?? "").toLowerCase();

  if (market.type === "moneyline") {
    return true;
  }

  if (market.type === "spread") {
    const line = parseLineFromSlug(slug, /-spread-(?:home|away)-(\d+)pt5$/);
    return line === 1.5 || line === 2.5;
  }

  if (market.type === "total") {
    if (slug.includes("-team-total-") || slug.includes("-first-half-") || slug.includes("-second-half-")) {
      return false;
    }

    const line = parseLineFromSlug(slug, /-total-(\d+)pt5$/);
    return line !== null && line >= 1.5 && line <= 7.5;
  }

  return false;
}

function parseLineFromSlug(slug: string, pattern: RegExp): number | null {
  const match = slug.match(pattern);
  if (!match?.[1]) {
    return null;
  }

  const whole = Number(match[1]);
  if (!Number.isFinite(whole)) {
    return null;
  }
  return whole + 0.5;
}

export function holderCostUsdc(position: HolderPosition): number | null {
  if (!Number.isFinite(position.shares) || !Number.isFinite(position.avgPrice)) {
    return null;
  }
  return position.shares * position.avgPrice;
}

export function buildHolderAlertKey(input: {
  eventSlug: string;
  marketSlug: string;
  outcomeTokenId: string;
  wallet: string;
}): string {
  return [input.eventSlug, input.marketSlug, input.outcomeTokenId, input.wallet.toLowerCase()].join("|");
}

export function shouldAlertHolderCost(
  costUsdc: number,
  previous: HolderAlertState | undefined,
  thresholdUsdc: number,
  changeAlertUsdc: number
): boolean {
  if (costUsdc < thresholdUsdc) {
    return false;
  }
  if (!previous) {
    return true;
  }
  return costUsdc - previous.lastAlertedCostUsdc >= changeAlertUsdc;
}

export function createHolderCostAlert(params: {
  market: HolderMarket;
  holder: TopHolder;
  position: HolderPosition;
  previous?: HolderAlertState;
}): HolderCostAlert | null {
  const costUsdc = holderCostUsdc(params.position);
  if (costUsdc === null) {
    return null;
  }

  const outcome = params.market.outcomes[params.holder.outcomeIndex] ?? params.position.outcome;
  const outcomeTokenId = params.market.clobTokenIds[params.holder.outcomeIndex] ?? params.holder.tokenId;
  return {
    key: buildHolderAlertKey({
      eventSlug: params.market.eventSlug,
      marketSlug: params.market.slug,
      outcomeTokenId,
      wallet: params.holder.wallet
    }),
    eventSlug: params.market.eventSlug,
    eventTitle: params.market.eventTitle,
    gameStartTime: params.market.gameStartTime,
    marketSlug: params.market.slug,
    marketTitle: params.market.question,
    marketType: params.market.type,
    conditionId: params.market.conditionId,
    outcome,
    outcomeTokenId,
    wallet: params.holder.wallet,
    holderName: params.holder.name,
    holderPseudonym: params.holder.pseudonym,
    shares: params.position.shares,
    avgPrice: params.position.avgPrice,
    costUsdc,
    previousCostUsdc: params.previous?.lastAlertedCostUsdc,
    costIncreaseUsdc: params.previous ? costUsdc - params.previous.lastAlertedCostUsdc : undefined,
    marketUrl: `https://polymarket.com/event/${params.market.eventSlug}`,
    walletUrl: `https://polymarket.com/profile/${params.holder.wallet}`
  };
}
