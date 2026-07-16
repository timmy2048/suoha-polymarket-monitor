import type { AppConfig } from "./config.js";
import { isMatchInMonitorWindow } from "./holder.js";
import { refreshHolderSchedule, scanHolderSchedule, type Alert, type MonitorDependencies } from "./monitor.js";
import { PolymarketClient } from "./polymarket.js";
import { buildSportsCatalog, type SportsCatalog } from "./sports.js";
import { scanAddressTradesOnce, scanLargeTradesOnce } from "./tradeMonitor.js";
import { loadWatchlist, type Watchlist } from "./watchlist.js";

export async function scanCombinedOnce(
  config: AppConfig,
  dependencies: MonitorDependencies,
  now = new Date()
): Promise<Alert[]> {
  const client = dependencies.client ?? new PolymarketClient();
  const watchlist = await loadWatchlist(config.watchlistFile);
  const catalog = await refreshCatalog(config, client, watchlist);
  const schedule = await refreshHolderSchedule(client);
  const alerts: Alert[] = [];

  alerts.push(...(await scanLargeTradesOnce(config, { ...dependencies, client }, catalog, watchlist, now)));
  alerts.push(...(await scanAddressTradesOnce(config, { ...dependencies, client }, catalog, watchlist, now)));
  alerts.push(...(await scanHolderSchedule(config, { ...dependencies, client }, schedule, now)));
  console.log(`[${new Date().toISOString()}] once scan complete, catalogScopes=${catalog.scopes.length}, catalogConditions=${catalog.conditionIds.size}, holderMatches=${schedule.length}, alerts=${alerts.length}`);
  return alerts;
}

export async function runCombinedMonitor(config: AppConfig, dependencies: MonitorDependencies): Promise<void> {
  const client = dependencies.client ?? new PolymarketClient();
  let watchlist = await loadWatchlist(config.watchlistFile);
  let catalog = await refreshCatalog(config, client, watchlist);
  let holderSchedule = (await safeRefreshHolderSchedule(client)) ?? [];
  let lastCatalogRefreshMs = Date.now();
  let lastWatchlistRefreshMs = Date.now();
  let nextLargeTradeMs = 0;
  let nextAddressMs = 0;
  let nextHolderMs = 0;
  let lastHolderScheduleDay = localDateKey(new Date());
  let nextHolderScheduleRetryMs = 0;

  logStartupSummary(config, watchlist, catalog, holderSchedule);

  while (true) {
    const now = new Date();
    const nowMs = now.getTime();

    if (nowMs - lastWatchlistRefreshMs >= config.sportsCatalogRefreshMs) {
      try {
        watchlist = await loadWatchlist(config.watchlistFile);
        lastWatchlistRefreshMs = nowMs;
        catalog = await refreshCatalog(config, client, watchlist);
        lastCatalogRefreshMs = nowMs;
        console.log(`[${new Date().toISOString()}] sports catalog refreshed, scopes=${catalog.scopes.length}, conditions=${catalog.conditionIds.size}`);
      } catch (error) {
        console.error(`[${new Date().toISOString()}] sports catalog refresh failed`, error);
      }
    } else if (nowMs - lastCatalogRefreshMs >= config.sportsCatalogRefreshMs) {
      try {
        catalog = await refreshCatalog(config, client, watchlist);
        lastCatalogRefreshMs = nowMs;
        console.log(`[${new Date().toISOString()}] sports catalog refreshed, scopes=${catalog.scopes.length}, conditions=${catalog.conditionIds.size}`);
      } catch (error) {
        console.error(`[${new Date().toISOString()}] sports catalog refresh failed`, error);
      }
    }

    const localDay = localDateKey(now);
    if (
      localDay !== lastHolderScheduleDay &&
      localTimeKey(now) >= config.scheduleRefreshTimeLocal &&
      nowMs >= nextHolderScheduleRetryMs
    ) {
      const refreshedSchedule = await safeRefreshHolderSchedule(client);
      if (refreshedSchedule) {
        holderSchedule = refreshedSchedule;
        lastHolderScheduleDay = localDay;
        nextHolderScheduleRetryMs = 0;
        logHolderSummary(holderSchedule);
      } else {
        nextHolderScheduleRetryMs = nowMs + 5 * 60_000;
      }
    }

    if (nowMs >= nextLargeTradeMs) {
      await runLargeTradeScan(config, dependencies, client, catalog, watchlist, now);
      nextLargeTradeMs = nowMs + config.pollIntervalMs;
    }

    if (config.addressMonitorEnabled && nowMs >= nextAddressMs) {
      await runAddressScan(config, dependencies, client, catalog, watchlist, now);
      nextAddressMs = nowMs + config.addressPollIntervalMs;
    }

    if (nowMs >= nextHolderMs) {
      await runHolderScan(config, dependencies, client, holderSchedule, now);
      nextHolderMs = nowMs + config.holderPollIntervalMs;
    }

    const nextRun = Math.min(nextLargeTradeMs, config.addressMonitorEnabled ? nextAddressMs : Number.POSITIVE_INFINITY, nextHolderMs, lastCatalogRefreshMs + config.sportsCatalogRefreshMs);
    await sleep(Math.max(250, Math.min(nextRun - Date.now(), 5_000)));
  }
}

async function refreshCatalog(config: AppConfig, client: PolymarketClient, watchlist: Watchlist): Promise<SportsCatalog> {
  const hasEnabledWallets = watchlist.wallets.some((wallet) => wallet.enabled);
  const addressScopes = config.addressMonitorEnabled && hasEnabledWallets ? config.addressSportsScopePaths : [];
  const scopes = [...new Set([...watchlist.largeTradeScopes, ...addressScopes])];
  return buildSportsCatalog(client, scopes);
}

async function runLargeTradeScan(
  config: AppConfig,
  dependencies: MonitorDependencies,
  client: PolymarketClient,
  catalog: SportsCatalog,
  watchlist: Watchlist,
  now: Date
): Promise<void> {
  try {
    const alerts = await scanLargeTradesOnce(config, { ...dependencies, client }, catalog, watchlist, now);
    console.log(`[${new Date().toISOString()}] large trade scan complete, alerts=${alerts.length}`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] large trade scan failed`, error);
  }
}

async function runAddressScan(
  config: AppConfig,
  dependencies: MonitorDependencies,
  client: PolymarketClient,
  catalog: SportsCatalog,
  watchlist: Watchlist,
  now: Date
): Promise<void> {
  try {
    const alerts = await scanAddressTradesOnce(config, { ...dependencies, client }, catalog, watchlist, now);
    console.log(`[${new Date().toISOString()}] address scan complete, wallets=${watchlist.wallets.filter((wallet) => wallet.enabled).length}, alerts=${alerts.length}`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] address scan failed`, error);
  }
}

async function runHolderScan(
  config: AppConfig,
  dependencies: MonitorDependencies,
  client: PolymarketClient,
  schedule: Awaited<ReturnType<typeof refreshHolderSchedule>>,
  now: Date
): Promise<void> {
  try {
    const alerts = await scanHolderSchedule(config, { ...dependencies, client }, schedule, now);
    const activeMatches = schedule.filter((match) =>
      isMatchInMonitorWindow(match.gameStartTime, now, config.prematchMonitorMinutes, config.matchMonitorDurationMinutes)
    ).length;
    console.log(`[${new Date().toISOString()}] holder scan complete, activeMatches=${activeMatches}, alerts=${alerts.length}`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] holder scan failed`, error);
  }
}

async function safeRefreshHolderSchedule(client: PolymarketClient): Promise<Awaited<ReturnType<typeof refreshHolderSchedule>> | null> {
  try {
    return await refreshHolderSchedule(client);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] holder schedule refresh failed`, error);
    return null;
  }
}

function logStartupSummary(config: AppConfig, watchlist: Watchlist, catalog: SportsCatalog, schedule: Awaited<ReturnType<typeof refreshHolderSchedule>>): void {
  console.log(`[${new Date().toISOString()}] combined monitor started, largeThresholdUsdc=${config.thresholdUsdc}, largePollSeconds=${config.pollIntervalMs / 1000}, addressEnabled=${config.addressMonitorEnabled}, addressPollSeconds=${config.addressPollIntervalMs / 1000}, addressAggregationMinutes=${config.addressAggregationWindowMs / 60_000}, catalogScopes=${catalog.scopes.length}, catalogConditions=${catalog.conditionIds.size}, configuredLargeScopes=${watchlist.largeTradeScopes.join(",") || "none"}, holderMatches=${schedule.length}`);
}

function logHolderSummary(schedule: Awaited<ReturnType<typeof refreshHolderSchedule>>): void {
  console.log(`[${new Date().toISOString()}] holder schedule refreshed, matches=${schedule.length}`);
}

function localDateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function localTimeKey(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
