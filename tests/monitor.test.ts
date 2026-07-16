import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { Alert } from "../src/monitor.js";
import { scanHolderSchedule, scanOnce } from "../src/monitor.js";
import type { PolymarketClient } from "../src/polymarket.js";
import { AlertStateStore } from "../src/state.js";
import type { Trade } from "../src/filter.js";
import type { HolderPosition, MatchEvent, TopHolder } from "../src/holder.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "suoha-monitor-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("scanOnce cumulative split-fill monitoring", () => {
  it("alerts when one wallet accumulates the threshold through multiple fills inside the window", async () => {
    const sentAlerts: Alert[] = [];
    const stateStore = await AlertStateStore.load(path.join(tempDir, "state.json"));
    const client = clientWithTrades([
      trade({ transactionHash: "0x1", size: 250_000, price: 0.8, timestamp: 1_781_917_700 }),
      trade({ transactionHash: "0x2", size: 240_000, price: 0.75, timestamp: 1_781_917_800 }),
      trade({ transactionHash: "0x3", size: 200_000, price: 0.75, timestamp: 1_781_917_900 })
    ]);

    const alerts = await scanOnce(config(), {
      client,
      stateStore,
      notifier: { send: async (alert) => void sentAlerts.push(alert) },
      now: () => new Date(1_781_917_950 * 1000)
    });

    expect(alerts).toHaveLength(1);
    expect(sentAlerts[0]).toMatchObject({
      kind: "cumulative",
      cashValue: 530_000,
      tradeCount: 3,
      windowSeconds: 300
    });
  });

  it("does not emit a cumulative duplicate for a single fill that already meets the threshold", async () => {
    const sentAlerts: Alert[] = [];
    const stateStore = await AlertStateStore.load(path.join(tempDir, "state.json"));
    const client = clientWithTrades([
      trade({ transactionHash: "0x1", size: 650_000, price: 0.8, timestamp: 1_781_917_800 }),
      trade({ transactionHash: "0x2", size: 100_000, price: 0.8, timestamp: 1_781_917_900 })
    ]);

    const alerts = await scanOnce(config(), {
      client,
      stateStore,
      notifier: { send: async (alert) => void sentAlerts.push(alert) },
      now: () => new Date(1_781_917_950 * 1000)
    });

    expect(alerts).toHaveLength(1);
    expect(sentAlerts[0]?.kind).toBe("single");
  });
});

describe("scanHolderSchedule", () => {
  it("alerts when top1 holder cost is above threshold", async () => {
    const sentAlerts: Alert[] = [];
    const stateStore = await AlertStateStore.load(path.join(tempDir, "state.json"));
    const client = holderClient({
      holders: [topHolder({ wallet: "0xabc", tokenId: "yes-token", shares: 1_000_000 })],
      positions: [position({ wallet: "0xabc", tokenId: "yes-token", shares: 1_000_000, avgPrice: 0.51 })]
    });

    const alerts = await scanHolderSchedule(config(), {
      client,
      stateStore,
      notifier: { send: async (alert) => void sentAlerts.push(alert) }
    }, [matchEvent()], new Date("2026-06-25T11:45:00Z"));

    expect(alerts).toHaveLength(1);
    expect(sentAlerts[0]).toMatchObject({
      kind: "holder",
      cashValue: 510_000,
      holder: {
        wallet: "0xabc",
        outcome: "Yes",
        avgPrice: 0.51
      }
    });
  });

  it("does not repeat until holder cost increases by the configured amount", async () => {
    const sentAlerts: Alert[] = [];
    const stateStore = await AlertStateStore.load(path.join(tempDir, "state.json"));
    await stateStore.markHolderAlert("fifwc-eng-gha-2026-06-25|fifwc-eng-gha-2026-06-25-eng|yes-token|0xabc", {
      wallet: "0xabc",
      marketSlug: "fifwc-eng-gha-2026-06-25-eng",
      outcomeTokenId: "yes-token",
      outcome: "Yes",
      lastAlertedCostUsdc: 500_000,
      shares: 1_000_000,
      avgPrice: 0.5,
      lastAlertedAt: "2026-06-25T00:00:00Z"
    });

    const noRepeat = await scanHolderSchedule(config(), {
      client: holderClient({
        holders: [topHolder({ wallet: "0xabc", tokenId: "yes-token" })],
        positions: [position({ wallet: "0xabc", tokenId: "yes-token", shares: 1_000_000, avgPrice: 0.54 })]
      }),
      stateStore,
      notifier: { send: async (alert) => void sentAlerts.push(alert) }
    }, [matchEvent()], new Date("2026-06-25T11:45:00Z"));
    expect(noRepeat).toHaveLength(0);

    const repeat = await scanHolderSchedule(config(), {
      client: holderClient({
        holders: [topHolder({ wallet: "0xabc", tokenId: "yes-token" })],
        positions: [position({ wallet: "0xabc", tokenId: "yes-token", shares: 1_000_000, avgPrice: 0.56 })]
      }),
      stateStore,
      notifier: { send: async (alert) => void sentAlerts.push(alert) }
    }, [matchEvent()], new Date("2026-06-25T11:46:00Z"));
    expect(repeat).toHaveLength(1);
  });

  it("skips holders when avg price position data is missing", async () => {
    const sentAlerts: Alert[] = [];
    const stateStore = await AlertStateStore.load(path.join(tempDir, "state.json"));

    const alerts = await scanHolderSchedule(config(), {
      client: holderClient({
        holders: [topHolder({ wallet: "0xabc", tokenId: "yes-token" })],
        positions: []
      }),
      stateStore,
      notifier: { send: async (alert) => void sentAlerts.push(alert) }
    }, [matchEvent()], new Date("2026-06-25T11:45:00Z"));

    expect(alerts).toHaveLength(0);
    expect(sentAlerts).toHaveLength(0);
  });
});

function config(): AppConfig {
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
    pollIntervalMs: 60_000,
    worldCupEventSlugs: [],
    worldCupEventPrefixes: ["fifwc-"],
    stateFile: path.join(tempDir, "state.json"),
    alertsFile: path.join(tempDir, "alerts.ndjson"),
    addressAlertsFile: path.join(tempDir, "address-alerts.ndjson"),
    watchlistFile: path.join(tempDir, "watchlist.json"),
    addressSportsScopePaths: ["sports"],
    sportsCatalogRefreshMs: 900_000,
    addressMonitorEnabled: false,
    addressPollIntervalMs: 30_000,
    addressAggregationWindowMs: 300_000,
    addressLookbackOverlapSeconds: 180,
    addressTradeFetchLimit: 1_000,
    largeTradeKeyword: "跟单",
    addressKeyword: "sport"
  };
}

function clientWithTrades(trades: Trade[]): PolymarketClient {
  return {
    fetchTradesByCash: async () => trades
  } as unknown as PolymarketClient;
}

function trade(overrides: Partial<Trade>): Trade {
  return {
    proxyWallet: "0xabc",
    side: "BUY",
    size: 100_000,
    price: 0.75,
    timestamp: 1_781_917_805,
    title: "Will England beat Ghana on 2099-06-25?",
    slug: "fifwc-eng-gha-2099-06-25-eng",
    eventSlug: "fifwc-eng-gha-2099-06-25",
    outcome: "Yes",
    transactionHash: "0xhash",
    ...overrides
  };
}

function matchEvent(): MatchEvent {
  return {
    slug: "fifwc-eng-gha-2026-06-25",
    title: "England vs. Ghana",
    gameStartTime: "2026-06-25T12:00:00Z",
    markets: [
      {
        eventSlug: "fifwc-eng-gha-2026-06-25",
        eventTitle: "England vs. Ghana",
        gameStartTime: "2026-06-25T12:00:00Z",
        slug: "fifwc-eng-gha-2026-06-25-eng",
        question: "Will England win on 2026-06-25?",
        conditionId: "0xcondition",
        type: "moneyline",
        outcomes: ["Yes", "No"],
        clobTokenIds: ["yes-token", "no-token"]
      }
    ]
  };
}

function holderClient(input: { holders: TopHolder[]; positions: HolderPosition[] }): PolymarketClient {
  return {
    fetchTopHolders: async () => input.holders,
    fetchHolderPositions: async () => input.positions
  } as unknown as PolymarketClient;
}

function topHolder(overrides: Partial<TopHolder>): TopHolder {
  return {
    wallet: "0xabc",
    name: "Top",
    pseudonym: "Holder",
    tokenId: "yes-token",
    outcomeIndex: 0,
    shares: 1_000_000,
    ...overrides
  };
}

function position(overrides: Partial<HolderPosition>): HolderPosition {
  return {
    wallet: "0xabc",
    tokenId: "yes-token",
    conditionId: "0xcondition",
    marketSlug: "fifwc-eng-gha-2026-06-25-eng",
    outcome: "Yes",
    shares: 1_000_000,
    avgPrice: 0.51,
    ...overrides
  };
}
