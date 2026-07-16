import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { Alert, MonitorDependencies } from "../src/monitor.js";
import { scanAddressTradesOnce, scanLargeTradesOnce } from "../src/tradeMonitor.js";
import { AlertStateStore } from "../src/state.js";
import type { SportsCatalog } from "../src/sports.js";
import type { Trade } from "../src/filter.js";
import type { Watchlist } from "../src/watchlist.js";
import type { PolymarketClient, TradeQueryOptions } from "../src/polymarket.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "suoha-trade-monitor-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("generic large trade monitor", () => {
  it("alerts on a qualifying BUY/SELL trade inside configured sports markets", async () => {
    const sent: Alert[] = [];
    const stateStore = await AlertStateStore.load(path.join(tempDir, "state.json"));
    const dependencies = dependenciesWith({
      stateStore,
      sent,
      client: clientWithTrades([trade({ side: "SELL", size: 1_000_000, price: 0.6, conditionId: "0xcondition" })])
    });

    const alerts = await scanLargeTradesOnce(config(), dependencies, catalog(), watchlist());

    expect(alerts).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: "large-trade", kind: "single", cashValue: 600_000 });
  });
});

describe("address trade monitor", () => {
  it("sends the first BUY immediately and aggregates later BUY fills for five minutes", async () => {
    const sent: Alert[] = [];
    const stateStore = await AlertStateStore.load(path.join(tempDir, "state.json"));
    let call = 0;
    const client = clientWithTrades([], async () => {
      call += 1;
      if (call === 1) return [trade({ transactionHash: "0x1", timestamp: 1_000, size: 100, price: 0.5, conditionId: "0xcondition" })];
      if (call === 2) return [trade({ transactionHash: "0x2", timestamp: 1_010, size: 200, price: 0.5, conditionId: "0xcondition" })];
      return [];
    });
    const dependencies = dependenciesWith({ stateStore, sent, client });

    const first = await scanAddressTradesOnce(config({ addressMonitorEnabled: true }), dependencies, catalog(), watchlist(), new Date(1_000_000));
    const second = await scanAddressTradesOnce(config({ addressMonitorEnabled: true }), dependencies, catalog(), watchlist(), new Date(1_020_000));
    const third = await scanAddressTradesOnce(config({ addressMonitorEnabled: true }), dependencies, catalog(), watchlist(), new Date(1_301_000));

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ kind: "address-initial", channel: "address-trade", address: { side: "BUY", stage: "initial" } });
    expect(second).toHaveLength(0);
    expect(third).toHaveLength(1);
    expect(third[0]).toMatchObject({
      kind: "address-aggregate",
      address: { side: "BUY", stage: "aggregate", totalSize: 200, tradeCount: 1 }
    });
    expect(sent).toHaveLength(2);
  });
});

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    thresholdUsdc: 500_000,
    holderChangeAlertUsdc: 50_000,
    prematchMonitorMinutes: 30,
    matchMonitorDurationMinutes: 105,
    holderPollIntervalMs: 60_000,
    scheduleRefreshMode: "daily",
    scheduleRefreshTimeLocal: "00:05",
    holderRankLimit: 1,
    holderEventScopePaths: ["world-cup"],
    holderSportWindows: {
      soccer: { prematchMinutes: 30, postMatchMinutes: 105 },
      basketball: { prematchMinutes: 30, postMatchMinutes: 180 },
      tennis: { prematchMinutes: 30, postMatchMinutes: 240 }
    },
    minTradeUsdc: 50_000,
    tradeFetchLimit: 500,
    cumulativeWindowSeconds: 300,
    pollIntervalMs: 30_000,
    watchlistFile: path.join(tempDir, "watchlist.json"),
    addressSportsScopePaths: ["sports"],
    sportsCatalogRefreshMs: 900_000,
    addressMonitorEnabled: false,
    addressPollIntervalMs: 30_000,
    addressAggregationWindowMs: 300_000,
    addressLookbackOverlapSeconds: 180,
    addressTradeFetchLimit: 1_000,
    worldCupEventSlugs: [],
    worldCupEventPrefixes: ["fifwc-"],
    largeTradeKeyword: "跟单",
    addressKeyword: "sport",
    stateFile: path.join(tempDir, "state.json"),
    alertsFile: path.join(tempDir, "alerts.ndjson"),
    addressAlertsFile: path.join(tempDir, "address-alerts.ndjson"),
    ...overrides
  };
}

function watchlist(): Watchlist {
  return { largeTradeScopes: ["world-cup"], wallets: [{ address: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", label: "Test", enabled: true }] };
}

function catalog(): SportsCatalog {
  return {
    refreshedAt: new Date().toISOString(),
    scopes: [],
    conditionIds: new Set(["0xcondition"]),
    eventSlugs: new Set(["sports-event"]),
    marketSlugs: new Set(["sports-market"])
  };
}

function dependenciesWith(input: { stateStore: AlertStateStore; sent: Alert[]; client: PolymarketClient }): MonitorDependencies {
  return {
    stateStore: input.stateStore,
    client: input.client,
    notifier: { send: async (alert) => void input.sent.push(alert) }
  };
}

function clientWithTrades(trades: Trade[], dynamic?: (options: TradeQueryOptions) => Promise<Trade[]>): PolymarketClient {
  return { fetchRecentTrades: dynamic ?? (async () => trades) } as unknown as PolymarketClient;
}

function trade(overrides: Partial<Trade>): Trade {
  return {
    proxyWallet: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    side: "BUY",
    size: 100,
    price: 0.5,
    timestamp: 1_000,
    title: "Sports market",
    slug: "sports-market",
    eventSlug: "sports-event",
    asset: "0xasset",
    conditionId: "0xcondition",
    outcome: "Yes",
    transactionHash: "0xhash",
    ...overrides
  };
}
