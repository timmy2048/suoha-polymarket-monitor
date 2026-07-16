import { describe, expect, it } from "vitest";
import {
  buildTradeKey,
  isEventDateCurrentOrFuture,
  isWorldCupTrade,
  meetsCashThreshold,
  tradeCashValue,
  type Trade
} from "../src/filter.js";

const baseTrade: Trade = {
  proxyWallet: "0xabc",
  side: "BUY",
  size: 1_100_000,
  price: 0.99,
  timestamp: 1_781_917_805,
  title: "Will Brazil win on 2026-06-19?",
  slug: "fifwc-bra-hai-2026-06-19-bra",
  eventSlug: "fifwc-bra-hai-2026-06-19",
  outcome: "Yes",
  transactionHash: "0xhash"
};

describe("trade filtering", () => {
  it("matches World Cup markets by fifwc slug prefix", () => {
    expect(
      isWorldCupTrade(baseTrade, {
        eventSlugs: [],
        slugPrefixes: ["fifwc-"]
      })
    ).toBe(true);
  });

  it("does not match the outright World Cup winner event by default", () => {
    expect(
      isWorldCupTrade(
        { ...baseTrade, eventSlug: "world-cup-winner", slug: "brazil-world-cup-winner" },
        { eventSlugs: [], slugPrefixes: ["fifwc-"] }
      )
    ).toBe(false);
  });

  it("rejects non-World Cup markets", () => {
    expect(
      isWorldCupTrade(
        { ...baseTrade, eventSlug: "us-iran-deal", slug: "us-iran-deal-text-released" },
        { eventSlugs: [], slugPrefixes: ["fifwc-"] }
      )
    ).toBe(false);
  });

  it("uses size times price as the cash threshold", () => {
    expect(tradeCashValue(baseTrade)).toBeCloseTo(1_089_000);
    expect(meetsCashThreshold(baseTrade, 1_000_000)).toBe(true);
    expect(meetsCashThreshold({ ...baseTrade, price: 0.5 }, 1_000_000)).toBe(false);
  });

  it("rejects trades from past event dates", () => {
    expect(isEventDateCurrentOrFuture(baseTrade, "2026-06-24")).toBe(false);
  });

  it("keeps trades from current and future event dates", () => {
    expect(
      isEventDateCurrentOrFuture(
        { ...baseTrade, eventSlug: "fifwc-eng-gha-2026-06-24", slug: "fifwc-eng-gha-2026-06-24-eng" },
        "2026-06-24"
      )
    ).toBe(true);
    expect(
      isEventDateCurrentOrFuture(
        { ...baseTrade, eventSlug: "fifwc-eng-gha-2026-06-25", slug: "fifwc-eng-gha-2026-06-25-eng" },
        "2026-06-24"
      )
    ).toBe(true);
  });

  it("builds stable dedupe keys from transaction and market fields", () => {
    expect(buildTradeKey(baseTrade)).toBe("0xhash|fifwc-bra-hai-2026-06-19-bra|BUY|1100000|0.99");
  });
});
