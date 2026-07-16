import { buildTradeKey, isEventDateCurrentOrFuture, isWorldCupTrade, meetsCashThreshold, tradeCashValue, type Trade } from "./filter.js";
import {
  createHolderCostAlert,
  getHolderSportWindow,
  isMatchEventInMonitorWindow,
  shouldAlertHolderCost,
  type HolderCostAlert,
  type MatchEvent
} from "./holder.js";
import type { Notifier } from "./notifier.js";
import { PolymarketClient } from "./polymarket.js";
import { AlertStateStore } from "./state.js";
import type { AppConfig } from "./config.js";
import { formatMonitorWindow } from "./time.js";

export interface Alert {
  key: string;
  kind: "single" | "cumulative" | "holder" | "address-initial" | "address-aggregate";
  channel?: "large-trade" | "address-trade";
  cashValue: number;
  marketUrl: string;
  trade?: Trade;
  holder?: HolderCostAlert;
  tradeCount?: number;
  windowSeconds?: number;
  firstTradeTimestamp?: number;
  latestTradeTimestamp?: number;
  address?: AddressAlertDetails;
}

export interface AddressAlertDetails {
  wallet: string;
  walletLabel?: string;
  side: "BUY" | "SELL";
  stage: "initial" | "aggregate";
  eventSlug: string;
  marketSlug: string;
  marketTitle: string;
  outcome?: string;
  conditionId?: string;
  asset?: string;
  totalSize: number;
  totalCashValue: number;
  tradeCount: number;
  firstTimestamp: number;
  lastTimestamp: number;
  transactionHashes: string[];
  marketUrl: string;
  walletUrl: string;
}

export interface MonitorDependencies {
  client?: PolymarketClient;
  notifier: Notifier;
  stateStore: AlertStateStore;
  now?: () => Date;
}

export async function scanOnce(config: AppConfig, dependencies: MonitorDependencies): Promise<Alert[]> {
  const client = dependencies.client ?? new PolymarketClient();
  const trades = await client.fetchTradesByCash(config.minTradeUsdc, config.tradeFetchLimit);
  const alerts: Alert[] = [];
  const eligibleTrades = trades.filter(
    (trade) =>
      isWorldCupTrade(trade, {
        eventSlugs: config.worldCupEventSlugs,
        slugPrefixes: config.worldCupEventPrefixes
      }) && isEventDateCurrentOrFuture(trade)
  );

  for (const trade of eligibleTrades) {
    if (!meetsCashThreshold(trade, config.thresholdUsdc)) {
      continue;
    }

    await sendAlertIfNew(createSingleAlert(trade), config, dependencies, alerts);
  }

  const nowEpochSeconds = Math.floor((dependencies.now?.() ?? new Date()).getTime() / 1000);
  for (const alert of createCumulativeAlerts(
    eligibleTrades,
    config.thresholdUsdc,
    config.cumulativeWindowSeconds,
    nowEpochSeconds
  )) {
    await sendAlertIfNew(alert, config, dependencies, alerts);
  }

  return alerts;
}

export async function scanHolderOnce(config: AppConfig, dependencies: MonitorDependencies): Promise<Alert[]> {
  const client = dependencies.client ?? new PolymarketClient();
  const now = dependencies.now?.() ?? new Date();
  const schedule = await refreshHolderSchedule(client, config.holderEventScopePaths, config.holderMarketTypes, config.holderScheduleLookaheadDays);
  return scanHolderSchedule(config, dependencies, schedule, now);
}

export async function runHolderMonitor(config: AppConfig, dependencies: MonitorDependencies): Promise<void> {
  const client = dependencies.client ?? new PolymarketClient();
  let schedule = await refreshHolderSchedule(client, config.holderEventScopePaths, config.holderMarketTypes, config.holderScheduleLookaheadDays);
  logHolderScheduleSummary(schedule, config);
  let lastRefreshDay = localDateKey(new Date());

  while (true) {
    try {
      const now = dependencies.now?.() ?? new Date();
      const today = localDateKey(now);
      if (today !== lastRefreshDay && localTimeKey(now) >= config.scheduleRefreshTimeLocal) {
        schedule = await refreshHolderSchedule(client, config.holderEventScopePaths, config.holderMarketTypes, config.holderScheduleLookaheadDays);
        logHolderScheduleSummary(schedule, config);
        lastRefreshDay = today;
      }

      const alerts = await scanHolderSchedule(config, { ...dependencies, client }, schedule, now);
      const activeMatches = schedule.filter((match) =>
        isMatchEventInMonitorWindow(match, now, config.prematchMonitorMinutes, config.matchMonitorDurationMinutes, config.holderSportWindows)
      ).length;
      console.log(`[${new Date().toISOString()}] holder scan complete, activeMatches=${activeMatches}, alerts=${alerts.length}`);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] holder scan failed`, error);
    }

    await sleep(config.holderPollIntervalMs);
  }
}

export async function refreshHolderSchedule(
  client: PolymarketClient,
  scopePaths = ["world-cup"],
  holderMarketTypes?: readonly string[],
  scheduleLookaheadDays = 3
): Promise<MatchEvent[]> {
  const slugGroups = await mapWithConcurrency(scopePaths, 4, (scopePath) => client.fetchEventSlugsForScope(scopePath));
  const slugs = [...new Set(slugGroups.flat())].filter((slug) => isLikelyScheduledMatchSlug(slug, new Date(), scheduleLookaheadDays));
  const resolvedEvents = await mapWithConcurrency(slugs, 8, async (slug) => {
    try {
      const event = await client.fetchMatchEvent(slug, holderMarketTypes);
      return event && event.markets.length > 0 ? event : null;
    } catch (error) {
      console.error(`[${new Date().toISOString()}] holder event refresh failed slug=${slug}`, error);
      return null;
    }
  });
  return resolvedEvents
    .filter((event): event is MatchEvent => event !== null)
    .sort((left, right) => Date.parse(left.gameStartTime) - Date.parse(right.gameStartTime));
}

function isLikelyScheduledMatchSlug(slug: string, now: Date, lookaheadDays: number): boolean {
  const match = slug.match(/(?:^|-)(20\d{2}-\d{2}-\d{2})(?:-|$)/);
  if (!match?.[1]) {
    return false;
  }

  const today = localDateKey(now);
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const eventMs = Date.parse(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(todayMs) || !Number.isFinite(eventMs)) {
    return false;
  }
  return eventMs >= todayMs - 86_400_000 && eventMs <= todayMs + lookaheadDays * 86_400_000;
}

async function mapWithConcurrency<T, R>(values: T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) {
        return;
      }
      results[index] = await mapper(values[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

export async function scanHolderSchedule(
  config: AppConfig,
  dependencies: MonitorDependencies,
  schedule: MatchEvent[],
  now: Date
): Promise<Alert[]> {
  const client = dependencies.client ?? new PolymarketClient();
  const alerts: Alert[] = [];
  const activeMatches = schedule.filter((match) =>
    isMatchEventInMonitorWindow(match, now, config.prematchMonitorMinutes, config.matchMonitorDurationMinutes, config.holderSportWindows)
  );

  const markets = activeMatches.flatMap((match) => match.markets);
  const candidates = await mapWithConcurrency(markets, 8, async (market) => {
    let holders: Awaited<ReturnType<PolymarketClient["fetchTopHolders"]>>;
    try {
      holders = await client.fetchTopHolders(market.conditionId, config.holderRankLimit);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] holder top-holder query failed market=${market.slug}`, error);
      return [];
    }

    const results: HolderCandidate[] = [];
    for (const holder of holders) {
      let positions: Awaited<ReturnType<PolymarketClient["fetchHolderPositions"]>>;
      try {
        positions = await client.fetchHolderPositions(holder.wallet, market.conditionId);
      } catch (error) {
        console.error(
          `[${new Date().toISOString()}] holder position query failed wallet=${holder.wallet} market=${market.slug}`,
          error
        );
        continue;
      }
      const position = positions.find((item) => item.tokenId === holder.tokenId);
      if (!position) {
        console.warn(`[${new Date().toISOString()}] missing holder position cost wallet=${holder.wallet} market=${market.slug} token=${holder.tokenId}`);
        continue;
      }
      results.push({ market, holder, position });
    }
    return results;
  });

  for (const candidate of candidates.flat()) {
    const { market, holder, position } = candidate;
    const key = [market.eventSlug, market.slug, holder.tokenId, holder.wallet.toLowerCase()].join("|");
    const previous = dependencies.stateStore.getHolderAlert(key);
    const holderAlert = createHolderCostAlert({ market, holder, position, previous });
    if (!holderAlert || !shouldAlertHolderCost(holderAlert.costUsdc, previous, config.thresholdUsdc, config.holderChangeAlertUsdc)) {
      continue;
    }

    const alert: Alert = {
      key: holderAlert.key,
      kind: "holder",
      cashValue: holderAlert.costUsdc,
      marketUrl: holderAlert.marketUrl,
      holder: holderAlert
    };
    await dependencies.notifier.send(alert);
    await dependencies.stateStore.markHolderAlert(holderAlert.key, {
      wallet: holderAlert.wallet,
      marketSlug: holderAlert.marketSlug,
      outcomeTokenId: holderAlert.outcomeTokenId,
      outcome: holderAlert.outcome,
      lastAlertedCostUsdc: holderAlert.costUsdc,
      shares: holderAlert.shares,
      avgPrice: holderAlert.avgPrice,
      lastAlertedAt: new Date().toISOString()
    });
    await dependencies.stateStore.appendAlert(config.alertsFile, alert);
    alerts.push(alert);
  }

  return alerts;
}

interface HolderCandidate {
  market: MatchEvent["markets"][number];
  holder: Awaited<ReturnType<PolymarketClient["fetchTopHolders"]>>[number];
  position: Awaited<ReturnType<PolymarketClient["fetchHolderPositions"]>>[number];
}

export async function runMonitor(config: AppConfig, dependencies: MonitorDependencies): Promise<void> {
  while (true) {
    try {
      const alerts = await scanOnce(config, dependencies);
      console.log(`[${new Date().toISOString()}] scan complete, alerts=${alerts.length}`);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] scan failed`, error);
    }

    await sleep(config.pollIntervalMs);
  }
}

export function createSingleAlert(trade: Trade): Alert {
  return {
    key: buildTradeKey(trade),
    kind: "single",
    cashValue: tradeCashValue(trade),
    marketUrl: buildMarketUrl(trade),
    trade
  };
}

export function createAlert(trade: Trade): Alert {
  return createSingleAlert(trade);
}

export function createCumulativeAlerts(
  trades: Trade[],
  thresholdUsdc: number,
  windowSeconds: number,
  nowEpochSeconds: number
): Alert[] {
  const windowStart = nowEpochSeconds - windowSeconds;
  const groups = new Map<string, Trade[]>();
  const seenTradeKeys = new Set<string>();

  for (const trade of trades) {
    const tradeKey = buildTradeKey(trade);
    if (seenTradeKeys.has(tradeKey) || trade.timestamp < windowStart || trade.timestamp > nowEpochSeconds) {
      continue;
    }
    seenTradeKeys.add(tradeKey);

    const groupKey = buildCumulativeGroupKey(trade);
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), trade]);
  }

  const alerts: Alert[] = [];
  for (const [groupKey, groupTrades] of groups) {
    if (groupTrades.length < 2 || groupTrades.some((trade) => meetsCashThreshold(trade, thresholdUsdc))) {
      continue;
    }

    const cashValue = groupTrades.reduce((total, trade) => total + tradeCashValue(trade), 0);
    if (cashValue < thresholdUsdc) {
      continue;
    }

    const sorted = [...groupTrades].sort((left, right) => left.timestamp - right.timestamp);
    const first = sorted[0];
    const latest = sorted.at(-1);
    if (!first || !latest) {
      continue;
    }

    const thresholdTier = Math.floor(cashValue / thresholdUsdc);
    const latestBucket = Math.floor(latest.timestamp / windowSeconds);
    alerts.push({
      key: `cumulative|${groupKey}|${latestBucket}|tier-${thresholdTier}`,
      kind: "cumulative",
      cashValue,
      marketUrl: buildMarketUrl(latest),
      trade: latest,
      tradeCount: sorted.length,
      windowSeconds,
      firstTradeTimestamp: first.timestamp,
      latestTradeTimestamp: latest.timestamp
    });
  }

  return alerts;
}

async function sendAlertIfNew(
  alert: Alert,
  config: AppConfig,
  dependencies: MonitorDependencies,
  alerts: Alert[]
): Promise<void> {
  if (dependencies.stateStore.has(alert.key)) {
    return;
  }

  await dependencies.notifier.send(alert);
  await dependencies.stateStore.markSeen(alert.key);
  await dependencies.stateStore.appendAlert(config.alertsFile, alert);
  alerts.push(alert);
}

function buildCumulativeGroupKey(trade: Trade): string {
  return [trade.proxyWallet.toLowerCase(), trade.eventSlug, trade.slug, trade.side.toUpperCase(), trade.outcome ?? ""].join("|");
}

function buildMarketUrl(trade: Trade): string {
  if (trade.eventSlug) {
    return `https://polymarket.com/event/${trade.eventSlug}`;
  }
  return `https://polymarket.com/market/${trade.slug}`;
}

function localDateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function logHolderScheduleSummary(schedule: MatchEvent[], config: AppConfig): void {
  const nextMatches = schedule.slice(0, 8);
  console.log(
    `[${new Date().toISOString()}] holder schedule refreshed, matches=${schedule.length}, timeRule=kickoff UTC ISO, refreshTime=${config.scheduleRefreshTimeLocal} Asia/Shanghai`
  );

  for (const match of nextMatches) {
    const sportWindow = getHolderSportWindow(match.sport, config.prematchMonitorMinutes, config.matchMonitorDurationMinutes, config.holderSportWindows);
    const window = formatMonitorWindow(match.gameStartTime, sportWindow.prematchMinutes, sportWindow.postMatchMinutes);
    console.log(
      `[${new Date().toISOString()}] holder schedule match=${match.slug}, sport=${match.sport ?? "unknown"}, kickoff=${window.kickoff}, monitorStart=${window.start}, monitorEnd=${window.end}, markets=${match.markets.length}`
    );
  }
}

function localTimeKey(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
