import { describe, expect, it } from "vitest";
import {
  buildHolderAlertKey,
  classifyTargetMarket,
  createHolderCostAlert,
  getHolderSportWindow,
  holderCostUsdc,
  isMatchEventInMonitorWindow,
  isMatchInMonitorWindow,
  normalizeSport,
  isTargetHolderMarket,
  shouldAlertHolderCost,
  type HolderMarket,
  type HolderPosition,
  type TopHolder
} from "../src/holder.js";

describe("holder monitor rules", () => {
  it("activates from 30 minutes before kickoff until 105 minutes after kickoff", () => {
    const kickoff = "2026-06-25T12:00:00Z";

    expect(isMatchInMonitorWindow(kickoff, new Date("2026-06-25T11:29:59Z"), 30, 105)).toBe(false);
    expect(isMatchInMonitorWindow(kickoff, new Date("2026-06-25T11:30:00Z"), 30, 105)).toBe(true);
    expect(isMatchInMonitorWindow(kickoff, new Date("2026-06-25T13:45:00Z"), 30, 105)).toBe(true);
    expect(isMatchInMonitorWindow(kickoff, new Date("2026-06-25T13:45:01Z"), 30, 105)).toBe(false);
  });

  it("uses the configured window for each sport instead of the soccer duration", () => {
    const windows = {
      soccer: { prematchMinutes: 30, postMatchMinutes: 105 },
      basketball: { prematchMinutes: 30, postMatchMinutes: 180 },
      tennis: { prematchMinutes: 15, postMatchMinutes: 240 }
    };
    const basketball = { gameStartTime: "2026-06-25T12:00:00Z", sport: "nba" };
    const tennis = { gameStartTime: "2026-06-25T12:00:00Z", sport: "atp" };

    expect(normalizeSport("fifwc")).toBe("soccer");
    expect(normalizeSport("nba")).toBe("basketball");
    expect(getHolderSportWindow("atp", 30, 105, windows)).toEqual({ prematchMinutes: 15, postMatchMinutes: 240 });
    expect(isMatchEventInMonitorWindow(basketball, new Date("2026-06-25T14:59:59Z"), 30, 105, windows)).toBe(true);
    expect(isMatchEventInMonitorWindow(basketball, new Date("2026-06-25T15:00:01Z"), 30, 105, windows)).toBe(false);
    expect(isMatchEventInMonitorWindow(tennis, new Date("2026-06-25T11:45:00Z"), 30, 105, windows)).toBe(true);
  });

  it("classifies moneyline, spread, full totals, and team totals while rejecting futures", () => {
    expect(classifyTargetMarket({ slug: "fifwc-prt-uzb-2026-06-23-prt", question: "Will Portugal win on 2026-06-23?" })).toBe(
      "moneyline"
    );
    expect(classifyTargetMarket({ slug: "fifwc-prt-uzb-2026-06-23-draw", question: "Will Portugal vs. Uzbekistan end in a draw?" })).toBe(
      "moneyline"
    );
    expect(classifyTargetMarket({ slug: "fifwc-prt-uzb-2026-06-23-spread-home-1pt5", question: "Spread: Portugal (-1.5)" })).toBe(
      "spread"
    );
    expect(classifyTargetMarket({ slug: "fifwc-prt-uzb-2026-06-23-total-3pt5", question: "Portugal vs. Uzbekistan: O/U 3.5" })).toBe(
      "total"
    );
    expect(
      classifyTargetMarket({
        slug: "fifwc-prt-uzb-2026-06-23-team-total-home-1pt5",
        question: "Portugal vs. Uzbekistan: Portugal O/U 1.5"
      })
    ).toBe("total");
    expect(classifyTargetMarket({ slug: "will-spain-win-the-2026-fifa-world-cup", question: "Will Spain win the 2026 FIFA World Cup?" })).toBe(
      null
    );
  });

  it("keeps only moneyline, 1.5/2.5 spreads, and full-game totals from 1.5 through 7.5", () => {
    expect(isTargetHolderMarket({ type: "moneyline", slug: "fifwc-nor-fra-2026-06-26-nor" })).toBe(true);
    expect(isTargetHolderMarket({ type: "moneyline", slug: "fifwc-nor-fra-2026-06-26-draw" })).toBe(true);
    expect(isTargetHolderMarket({ type: "spread", slug: "fifwc-nor-fra-2026-06-26-spread-home-1pt5" })).toBe(true);
    expect(isTargetHolderMarket({ type: "spread", slug: "fifwc-nor-fra-2026-06-26-spread-away-2pt5" })).toBe(true);
    expect(isTargetHolderMarket({ type: "spread", slug: "fifwc-nor-fra-2026-06-26-spread-home-3pt5" })).toBe(false);
    expect(isTargetHolderMarket({ type: "total", slug: "fifwc-nor-fra-2026-06-26-total-1pt5" })).toBe(true);
    expect(isTargetHolderMarket({ type: "total", slug: "fifwc-nor-fra-2026-06-26-total-7pt5" })).toBe(true);
    expect(isTargetHolderMarket({ type: "total", slug: "fifwc-nor-fra-2026-06-26-total-8pt5" })).toBe(false);
    expect(isTargetHolderMarket({ type: "total", slug: "fifwc-nor-fra-2026-06-26-team-total-home-1pt5" })).toBe(false);
    expect(isTargetHolderMarket({ type: "total", slug: "fifwc-nor-fra-2026-06-26-first-half-total-1pt5" })).toBe(false);
    expect(isTargetHolderMarket({ type: "total", slug: "fifwc-nor-fra-2026-06-26-second-half-total-1pt5" })).toBe(false);
  });

  it("uses shares times average buy price as holder cost", () => {
    expect(holderCostUsdc(position({ shares: 1_000_000, avgPrice: 0.51 }))).toBe(510_000);
  });

  it("alerts first time over threshold and again only after 50k cost increase", () => {
    expect(shouldAlertHolderCost(499_999, undefined, 500_000, 50_000)).toBe(false);
    expect(shouldAlertHolderCost(500_000, undefined, 500_000, 50_000)).toBe(true);
    expect(
      shouldAlertHolderCost(
        540_000,
        {
          wallet: "0xabc",
          marketSlug: "m",
          outcomeTokenId: "t",
          outcome: "Yes",
          lastAlertedCostUsdc: 500_000,
          shares: 1_000_000,
          avgPrice: 0.5,
          lastAlertedAt: "2026-06-25T00:00:00Z"
        },
        500_000,
        50_000
      )
    ).toBe(false);
    expect(
      shouldAlertHolderCost(
        550_000,
        {
          wallet: "0xabc",
          marketSlug: "m",
          outcomeTokenId: "t",
          outcome: "Yes",
          lastAlertedCostUsdc: 500_000,
          shares: 1_000_000,
          avgPrice: 0.5,
          lastAlertedAt: "2026-06-25T00:00:00Z"
        },
        500_000,
        50_000
      )
    ).toBe(true);
  });

  it("builds holder alerts keyed by event, market, outcome token, and wallet", () => {
    const alert = createHolderCostAlert({
      market: market(),
      holder: holder(),
      position: position({ shares: 1_000_000, avgPrice: 0.51 })
    });

    expect(alert).toMatchObject({
      key: buildHolderAlertKey({
        eventSlug: "fifwc-eng-gha-2026-06-25",
        marketSlug: "fifwc-eng-gha-2026-06-25-eng",
        outcomeTokenId: "yes-token",
        wallet: "0xABC"
      }),
      costUsdc: 510_000,
      marketType: "moneyline",
      outcome: "Yes"
    });
  });
});

function market(): HolderMarket {
  return {
    eventSlug: "fifwc-eng-gha-2026-06-25",
    eventTitle: "England vs. Ghana",
    gameStartTime: "2026-06-25T12:00:00Z",
    slug: "fifwc-eng-gha-2026-06-25-eng",
    question: "Will England win on 2026-06-25?",
    conditionId: "0xcondition",
    type: "moneyline",
    outcomes: ["Yes", "No"],
    clobTokenIds: ["yes-token", "no-token"]
  };
}

function holder(): TopHolder {
  return {
    wallet: "0xABC",
    name: "Top",
    pseudonym: "Holder",
    tokenId: "yes-token",
    outcomeIndex: 0,
    shares: 1_000_000
  };
}

function position(overrides: Partial<HolderPosition>): HolderPosition {
  return {
    wallet: "0xABC",
    tokenId: "yes-token",
    conditionId: "0xcondition",
    marketSlug: "fifwc-eng-gha-2026-06-25-eng",
    outcome: "Yes",
    shares: 1_000_000,
    avgPrice: 0.51,
    ...overrides
  };
}
