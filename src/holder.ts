import type { HolderAlertState } from "./state.js";
import type { HolderSportWindow } from "./config.js";

export type TargetMarketType = "moneyline" | "spread" | "total" | "prop";

export const DEFAULT_HOLDER_MARKET_TYPES = [
  "moneyline",
  "spreads",
  "totals",
  "match_handicap",
  "tennis_completed_match",
  "tennis_match_totals",
  "tennis_first_set_totals",
  "tennis_first_set_winner",
  "tennis_set_games_totals",
  "tennis_set_handicap",
  "tennis_set_totals",
  "tennis_set_winner",
  "cricket_completed_match",
  "cricket_first_inning_runs",
  "cricket_second_inning_runs",
  "cricket_match_to_go_till",
  "baseball_game_extra_innings",
  "baseball_team_first_five_spread",
  "baseball_team_first_five_total",
  "baseball_team_first_five_winner",
  "nrfi",
  "ufc_go_the_distance",
  "ufc_method_of_victory"
] as const;

export interface MatchEvent {
  slug: string;
  title: string;
  gameStartTime: string;
  sport?: string;
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
  sportsMarketType?: string;
  line?: number;
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
  sportsMarketType?: string;
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

export function isMatchEventInMonitorWindow(
  match: Pick<MatchEvent, "gameStartTime" | "sport">,
  now: Date,
  defaultPrematchMinutes: number,
  defaultPostMatchMinutes: number,
  sportWindows: Record<string, HolderSportWindow>
): boolean {
  const window = getHolderSportWindow(match.sport, defaultPrematchMinutes, defaultPostMatchMinutes, sportWindows);
  return isMatchInMonitorWindow(match.gameStartTime, now, window.prematchMinutes, window.postMatchMinutes);
}

export function getHolderSportWindow(
  sport: string | undefined,
  defaultPrematchMinutes: number,
  defaultPostMatchMinutes: number,
  sportWindows: Record<string, HolderSportWindow>
): HolderSportWindow {
  const normalizedSport = normalizeSport(sport);
  return sportWindows[normalizedSport] ?? {
    prematchMinutes: defaultPrematchMinutes,
    postMatchMinutes: defaultPostMatchMinutes
  };
}

export function normalizeSport(sport: string | undefined): string {
  const normalized = (sport ?? "").trim().toLowerCase();
  if (/^(fifwc|uel|uecl|mls|csl|brseriea|mex|auc|kleague|arg)-/.test(normalized)) return "soccer";
  if (/^(nba|nbasl|wnba|bkbsn|bk)-/.test(normalized)) return "basketball";
  if (/^(atp|wta|itf)-/.test(normalized)) return "tennis";
  if (/^mlb-/.test(normalized)) return "baseball";
  if (/^cric/.test(normalized)) return "cricket";
  if (/^ufc-/.test(normalized)) return "combat";
  if (/^(cfl|nfl|cfb)-/.test(normalized)) return "american-football";
  if (/^(pll|wll)-/.test(normalized)) return "lacrosse";
  if (["fifwc", "soccer", "football"].includes(normalized)) return "soccer";
  if (["nba", "wnba", "bsn", "basketball"].includes(normalized)) return "basketball";
  if (["atp", "wta", "itf", "tennis"].includes(normalized)) return "tennis";
  if (["mlb", "baseball"].includes(normalized)) return "baseball";
  if (["mlc", "lpl", "t20-blast", "shpageeza", "international", "cricket"].includes(normalized)) return "cricket";
  if (["ufc", "mma", "combat"].includes(normalized)) return "combat";
  if (["cfl", "nfl", "cfb", "american-football"].includes(normalized)) return "american-football";
  if (["pll", "wll", "lacrosse"].includes(normalized)) return "lacrosse";
  if (["nhl", "hockey"].includes(normalized)) return "hockey";
  return normalized;
}

export function classifyTargetMarket(market: {
  slug?: string;
  question?: string;
  groupItemTitle?: string;
  sportsMarketType?: string;
}): TargetMarketType | null {
  const sportsType = normalizeSportsMarketType(market.sportsMarketType);
  if (sportsType) {
    return categoryForSportsMarketType(sportsType);
  }

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

export function isTargetHolderMarket(market: {
  type: TargetMarketType;
  slug?: string;
  question?: string;
  sportsMarketType?: string;
  line?: number | string;
  sport?: string;
  allowedSportsMarketTypes?: readonly string[];
}): boolean {
  const sportsType = normalizeSportsMarketType(market.sportsMarketType);
  if (sportsType) {
    const allowedTypes = new Set(
      (market.allowedSportsMarketTypes ?? DEFAULT_HOLDER_MARKET_TYPES).map(normalizeSportsMarketType).filter(Boolean)
    );
    if (!allowedTypes.has(sportsType)) {
      return false;
    }

    const sport = normalizeSport(market.sport);
    if (sport === "soccer" && (market.type === "spread" || market.type === "total")) {
      return isSoccerLineInTargetRange(market);
    }
    return true;
  }

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

export function normalizeSportsMarketType(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, "_");
}

function categoryForSportsMarketType(value: string): TargetMarketType {
  if (
    value === "moneyline" ||
    value === "tennis_completed_match" ||
    value === "cricket_completed_match" ||
    value === "baseball_team_first_five_winner" ||
    value.endsWith("_winner") ||
    value.endsWith("_match_result")
  ) {
    return "moneyline";
  }
  if (value.includes("spread") || value.includes("handicap")) {
    return "spread";
  }
  if (value.includes("total") || value === "nrfi") {
    return "total";
  }
  return "prop";
}

function isSoccerLineInTargetRange(market: { slug?: string; line?: number | string; type: TargetMarketType }): boolean {
  const slug = (market.slug ?? "").toLowerCase();
  const line =
    parseMarketLine(market.line) ??
    parseLineFromSlug(slug, /-spread-(?:home|away)-(\d+)pt5$/) ??
    parseLineFromSlug(slug, /-total-(\d+)pt5$/);
  if (line === null) {
    return false;
  }
  if (market.type === "spread") {
    return line === 1.5 || line === 2.5;
  }
  return line >= 1.5 && line <= 7.5;
}

function parseMarketLine(value: number | string | undefined): number | null {
  const line = Number(value);
  return Number.isFinite(line) ? Math.abs(line) : null;
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
    sportsMarketType: params.market.sportsMarketType,
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
