import type { AppConfig } from "./config.js";
import { tradeCashValue, type Trade } from "./filter.js";
import { matchesSportsCatalog, type SportsCatalog } from "./sports.js";
import type { AddressAggregateState, AlertStateStore } from "./state.js";
import type { WatchedWallet, Watchlist } from "./watchlist.js";
import { PolymarketClient } from "./polymarket.js";
import { createCumulativeAlerts, createSingleAlert, type Alert, type AddressAlertDetails, type MonitorDependencies } from "./monitor.js";

const CONDITION_BATCH_SIZE = 50;

export async function scanLargeTradesOnce(
  config: AppConfig,
  dependencies: MonitorDependencies,
  catalog: SportsCatalog,
  watchlist: Watchlist,
  now = dependencies.now?.() ?? new Date()
): Promise<Alert[]> {
  if (
    watchlist.largeTradeScopes.length === 0 ||
    (catalog.conditionIds.size === 0 && catalog.eventSlugs.size === 0 && catalog.marketSlugs.size === 0)
  ) {
    return [];
  }

  const client = dependencies.client ?? new PolymarketClient();
  const nowEpochSeconds = Math.floor(now.getTime() / 1000);
  const start = nowEpochSeconds - Math.max(config.cumulativeWindowSeconds, 300);
  const conditionIds = [...catalog.conditionIds];
  const trades: Trade[] = [];

  if (conditionIds.length === 0 || conditionIds.length > (config.largeTradeMarketFilterMaxConditions ?? 1_000)) {
    console.warn(
      `[${new Date().toISOString()}] large trade catalog has ${conditionIds.length} conditions; using one global candidate query and catalog filtering`
    );
    trades.push(
      ...(await client.fetchRecentTrades({
        limit: config.tradeFetchLimit,
        takerOnly: false,
        filterType: "CASH",
        filterAmount: config.minTradeUsdc,
        start,
        end: nowEpochSeconds
      }))
    );
  } else {
    for (const batch of chunks(conditionIds, CONDITION_BATCH_SIZE)) {
      trades.push(
        ...(await client.fetchRecentTrades({
          limit: config.tradeFetchLimit,
          market: batch,
          takerOnly: false,
          filterType: "CASH",
          filterAmount: config.minTradeUsdc,
          start,
          end: nowEpochSeconds
        }))
      );
    }
  }

  const eligible = trades.filter((trade) => matchesSportsCatalog(trade, catalog));
  const alerts: Alert[] = [];
  for (const trade of eligible) {
    if (tradeCashValue(trade) < config.thresholdUsdc) {
      continue;
    }
    await sendNewAlert(
      { ...createSingleAlert(trade), channel: "large-trade" },
      config.alertsFile,
      dependencies,
      alerts
    );
  }

  const cumulativeAlerts = createCumulativeAlerts(eligible, config.thresholdUsdc, config.cumulativeWindowSeconds, nowEpochSeconds);
  for (const alert of cumulativeAlerts) {
    await sendNewAlert({ ...alert, channel: "large-trade" }, config.alertsFile, dependencies, alerts);
  }

  return alerts;
}

export async function scanAddressTradesOnce(
  config: AppConfig,
  dependencies: MonitorDependencies,
  catalog: SportsCatalog,
  watchlist: Watchlist,
  now = dependencies.now?.() ?? new Date()
): Promise<Alert[]> {
  const alerts: Alert[] = [];
  if (!config.addressMonitorEnabled) {
    return alerts;
  }

  const nowEpochSeconds = Math.floor(now.getTime() / 1000);
  await flushExpiredAddressAggregates(config, dependencies, nowEpochSeconds, alerts);

  for (const wallet of watchlist.wallets.filter((item) => item.enabled)) {
    const cursor = dependencies.stateStore.getAddressCursor(wallet.address);
    const start = cursor === undefined ? nowEpochSeconds - config.addressLookbackOverlapSeconds : cursor - config.addressLookbackOverlapSeconds;
    const client = dependencies.client ?? new PolymarketClient();
    const trades = await client.fetchRecentTrades({
      user: wallet.address,
      takerOnly: false,
      limit: config.addressTradeFetchLimit,
      start: Math.max(0, start),
      end: nowEpochSeconds
    });

    for (const trade of trades.filter((item) => item.side.toUpperCase() === "BUY" || item.side.toUpperCase() === "SELL")) {
      if (!matchesSportsCatalog(trade, catalog)) {
        continue;
      }

      const tradeKey = buildAddressTradeKey(wallet.address, trade);
      if (dependencies.stateStore.hasAddressTrade(tradeKey)) {
        continue;
      }

      const groupKey = buildAddressGroupKey(wallet.address, trade);
      const existing = dependencies.stateStore.getAddressAggregate(groupKey);
      if (!dependencies.stateStore.hasAddressInitial(groupKey)) {
        const alert = createAddressAlert(wallet, trade, "initial");
        await dependencies.notifier.send(alert);
        await dependencies.stateStore.markAddressTrade(tradeKey, trade.timestamp);
        await dependencies.stateStore.markAddressInitial(groupKey);
        await dependencies.stateStore.appendAlert(config.addressAlertsFile, alert);
        alerts.push(alert);
        continue;
      }

      let aggregate = existing;
      const bucketStart = Math.floor(trade.timestamp / (config.addressAggregationWindowMs / 1000)) * (config.addressAggregationWindowMs / 1000);
      if (aggregate && trade.timestamp >= aggregate.bucketStartedAt + config.addressAggregationWindowMs / 1000) {
        await emitAddressAggregate(config, dependencies, groupKey, aggregate, alerts);
        aggregate = undefined;
      }

      const nextAggregate = aggregate ? addToAggregate(aggregate, wallet, trade) : createAggregate(wallet, trade, bucketStart);
      await dependencies.stateStore.markAddressTrade(tradeKey, trade.timestamp);
      await dependencies.stateStore.setAddressAggregate(groupKey, nextAggregate);
    }

    await dependencies.stateStore.markAddressCursor(wallet.address, nowEpochSeconds);
  }

  return alerts;
}

export function buildAddressTradeKey(wallet: string, trade: Trade): string {
  return [wallet.toLowerCase(), trade.transactionHash, trade.conditionId ?? trade.slug, trade.asset ?? "", trade.side.toUpperCase(), trade.size, trade.price, trade.timestamp].join("|");
}

export function buildAddressGroupKey(wallet: string, trade: Trade): string {
  return [wallet.toLowerCase(), trade.conditionId ?? trade.slug, trade.asset ?? trade.slug, trade.side.toUpperCase()].join("|");
}

function createAddressAlert(wallet: WatchedWallet, trade: Trade, stage: "initial" | "aggregate"): Alert {
  const side = trade.side.toUpperCase() as "BUY" | "SELL";
  const details: AddressAlertDetails = {
    wallet: wallet.address,
    walletLabel: wallet.label,
    side,
    stage,
    eventSlug: trade.eventSlug,
    marketSlug: trade.slug,
    marketTitle: trade.title,
    outcome: trade.outcome,
    conditionId: trade.conditionId,
    asset: trade.asset,
    totalSize: trade.size,
    totalCashValue: tradeCashValue(trade),
    tradeCount: 1,
    firstTimestamp: trade.timestamp,
    lastTimestamp: trade.timestamp,
    transactionHashes: [trade.transactionHash],
    marketUrl: trade.eventSlug ? `https://polymarket.com/event/${trade.eventSlug}` : `https://polymarket.com/market/${trade.slug}`,
    walletUrl: `https://polymarket.com/profile/${wallet.address}`
  };

  return {
    key: `address|${buildAddressTradeKey(wallet.address, trade)}|${stage}`,
    kind: stage === "initial" ? "address-initial" : "address-aggregate",
    channel: "address-trade",
    cashValue: details.totalCashValue,
    marketUrl: details.marketUrl,
    trade,
    address: details
  };
}

function createAggregate(wallet: WatchedWallet, trade: Trade, bucketStartedAt: number): AddressAggregateState {
  return {
    wallet: wallet.address,
    walletLabel: wallet.label,
    marketSlug: trade.slug,
    marketTitle: trade.title,
    eventSlug: trade.eventSlug,
    conditionId: trade.conditionId,
    asset: trade.asset,
    outcome: trade.outcome,
    side: trade.side.toUpperCase() as "BUY" | "SELL",
    totalSize: trade.size,
    totalCashValue: tradeCashValue(trade),
    tradeCount: 1,
    firstTimestamp: trade.timestamp,
    lastTimestamp: trade.timestamp,
    transactionHashes: [trade.transactionHash],
    bucketStartedAt
  };
}

function addToAggregate(aggregate: AddressAggregateState, wallet: WatchedWallet, trade: Trade): AddressAggregateState {
  return {
    ...aggregate,
    walletLabel: wallet.label ?? aggregate.walletLabel,
    marketTitle: trade.title || aggregate.marketTitle,
    totalSize: aggregate.totalSize + trade.size,
    totalCashValue: aggregate.totalCashValue + tradeCashValue(trade),
    tradeCount: aggregate.tradeCount + 1,
    firstTimestamp: Math.min(aggregate.firstTimestamp, trade.timestamp),
    lastTimestamp: Math.max(aggregate.lastTimestamp, trade.timestamp),
    transactionHashes: [...new Set([...aggregate.transactionHashes, trade.transactionHash])]
  };
}

async function flushExpiredAddressAggregates(
  config: AppConfig,
  dependencies: MonitorDependencies,
  nowEpochSeconds: number,
  alerts: Alert[]
): Promise<void> {
  const windowSeconds = config.addressAggregationWindowMs / 1000;
  for (const [groupKey, aggregate] of dependencies.stateStore.getAddressAggregates()) {
    if (nowEpochSeconds < aggregate.bucketStartedAt + windowSeconds) {
      continue;
    }
    await emitAddressAggregate(config, dependencies, groupKey, aggregate, alerts);
  }
}

async function emitAddressAggregate(
  config: AppConfig,
  dependencies: MonitorDependencies,
  groupKey: string,
  aggregate: AddressAggregateState,
  alerts: Alert[]
): Promise<void> {
  const details: AddressAlertDetails = {
    wallet: aggregate.wallet,
    walletLabel: aggregate.walletLabel,
    side: aggregate.side,
    stage: "aggregate",
    eventSlug: aggregate.eventSlug,
    marketSlug: aggregate.marketSlug,
    marketTitle: aggregate.marketTitle ?? aggregate.marketSlug,
    outcome: aggregate.outcome,
    conditionId: aggregate.conditionId,
    asset: aggregate.asset,
    totalSize: aggregate.totalSize,
    totalCashValue: aggregate.totalCashValue,
    tradeCount: aggregate.tradeCount,
    firstTimestamp: aggregate.firstTimestamp,
    lastTimestamp: aggregate.lastTimestamp,
    transactionHashes: aggregate.transactionHashes,
    marketUrl: aggregate.eventSlug ? `https://polymarket.com/event/${aggregate.eventSlug}` : `https://polymarket.com/market/${aggregate.marketSlug}`,
    walletUrl: `https://polymarket.com/profile/${aggregate.wallet}`
  };
  const alert: Alert = {
    key: `address|${groupKey}|aggregate|${aggregate.bucketStartedAt}`,
    kind: "address-aggregate",
    channel: "address-trade",
    cashValue: aggregate.totalCashValue,
    marketUrl: details.marketUrl,
    address: details
  };
  await dependencies.notifier.send(alert);
  await dependencies.stateStore.deleteAddressAggregate(groupKey);
  await dependencies.stateStore.appendAlert(config.addressAlertsFile, alert);
  alerts.push(alert);
}

async function sendNewAlert(
  alert: Alert,
  historyFile: string,
  dependencies: MonitorDependencies,
  alerts: Alert[]
): Promise<void> {
  if (dependencies.stateStore.has(alert.key)) {
    return;
  }
  await dependencies.notifier.send(alert);
  await dependencies.stateStore.markSeen(alert.key);
  await dependencies.stateStore.appendAlert(historyFile, alert);
  alerts.push(alert);
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
