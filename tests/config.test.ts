import { describe, expect, it } from "vitest";
import { readConfig } from "../src/config.js";

describe("configuration defaults", () => {
  it("loads generic trade, sports catalog, address, and DingTalk defaults", () => {
    const config = readConfig({
      DATA_DIR: "data"
    });

    expect(config.thresholdUsdc).toBe(500_000);
    expect(config.holderChangeAlertUsdc).toBe(50_000);
    expect(config.prematchMonitorMinutes).toBe(30);
    expect(config.matchMonitorDurationMinutes).toBe(105);
    expect(config.holderPollIntervalMs).toBe(60_000);
    expect(config.scheduleRefreshMode).toBe("daily");
    expect(config.scheduleRefreshTimeLocal).toBe("00:05");
    expect(config.holderRankLimit).toBe(1);
    expect(config.holderEventScopePaths).toEqual(["world-cup"]);
    expect(config.holderSportWindows).toMatchObject({
      soccer: { prematchMinutes: 30, postMatchMinutes: 105 },
      basketball: { prematchMinutes: 30, postMatchMinutes: 180 },
      tennis: { prematchMinutes: 30, postMatchMinutes: 240 }
    });
    expect(config.minTradeUsdc).toBe(50_000);
    expect(config.tradeFetchLimit).toBe(500);
    expect(config.cumulativeWindowSeconds).toBe(300);
    expect(config.pollIntervalMs).toBe(30_000);
    expect(config.watchlistFile.endsWith("config\\watchlist.json") || config.watchlistFile.endsWith("config/watchlist.json")).toBe(true);
    expect(config.addressSportsScopePaths).toEqual(["sports"]);
    expect(config.sportsCatalogRefreshMs).toBe(900_000);
    expect(config.addressMonitorEnabled).toBe(false);
    expect(config.addressPollIntervalMs).toBe(30_000);
    expect(config.addressAggregationWindowMs).toBe(300_000);
    expect(config.addressLookbackOverlapSeconds).toBe(180);
    expect(config.addressTradeFetchLimit).toBe(1_000);
    expect(config.largeTradeKeyword).toBe("跟单");
    expect(config.addressKeyword).toBe("sport");
    expect(config.worldCupEventSlugs).toEqual([]);
    expect(config.worldCupEventPrefixes).toEqual(["fifwc-"]);
  });
});
