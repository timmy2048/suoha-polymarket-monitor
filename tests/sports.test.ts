import { describe, expect, it } from "vitest";
import { buildSportsCatalog, matchesSportsCatalog, type SportsCatalogClient, type SportsEventRecord } from "../src/sports.js";
import type { Trade } from "../src/filter.js";

describe("sports catalog", () => {
  it("resolves a direct sport path through its tag and market condition IDs", async () => {
    const event = eventRecord("world-cup-event", "0xcondition");
    const client = fakeClient({
      tags: { "world-cup": { id: 10, slug: "world-cup" } },
      tagEvents: { "world-cup": [event] }
    });

    const catalog = await buildSportsCatalog(client, ["world-cup"]);

    expect(catalog.scopes[0]).toMatchObject({ path: "world-cup", conditionIds: ["0xcondition"] });
    expect(matchesSportsCatalog(trade({ conditionId: "0xcondition" }), catalog)).toBe(true);
  });

  it("normalizes /games paths and includes series events for leagues", async () => {
    const event = eventRecord("atp-event", "0xatp");
    const client = fakeClient({ series: { atp: [{ slug: "atp", events: [event] }] } });

    const catalog = await buildSportsCatalog(client, ["atp/games"]);

    expect(catalog.scopes[0]?.path).toBe("atp/games");
    expect(catalog.conditionIds.has("0xatp")).toBe(true);
  });

  it("resolves user-friendly aliases to the actual Polymarket series slug", async () => {
    const event = eventRecord("mlc-game", "0xmlc");
    const client = fakeClient({ series: { "major-league-cricket": [{ slug: "major-league-cricket", events: [event] }] } });

    const catalog = await buildSportsCatalog(client, ["mlc"]);

    expect(catalog.conditionIds.has("0xmlc")).toBe(true);
  });

  it("uses search only for scopes without a tag or series", async () => {
    const event = eventRecord("bkbsn-game", "0xbsn");
    const client = fakeClient({ searchEvents: { bsn: [event] } });

    const catalog = await buildSportsCatalog(client, ["bsn"]);

    expect(catalog.conditionIds.has("0xbsn")).toBe(true);
  });

  it("expands the sports root through metadata tag IDs", async () => {
    const event = eventRecord("nba-event", "0xnba");
    const client = fakeClient({ metadata: [{ sport: "basketball", tags: "101, 102" }], tagIdEvents: { "101": [event] } });

    const catalog = await buildSportsCatalog(client, ["sports"]);

    expect(catalog.conditionIds.has("0xnba")).toBe(true);
  });

  it("fails closed when a path cannot be resolved", async () => {
    const catalog = await buildSportsCatalog(fakeClient(), ["unknown/games"]);
    expect(catalog.conditionIds.size).toBe(0);
    expect(matchesSportsCatalog(trade({ eventSlug: "unknown-event" }), catalog)).toBe(false);
  });
});

function eventRecord(slug: string, conditionId: string): SportsEventRecord {
  return { slug, markets: [{ slug: `${slug}-market`, conditionId }] };
}

function trade(overrides: Partial<Trade>): Trade {
  return {
    proxyWallet: "0xabc",
    side: "BUY",
    size: 100,
    price: 0.5,
    timestamp: 1,
    title: "Sports market",
    slug: "market",
    eventSlug: "event",
    transactionHash: "0xtx",
    ...overrides
  };
}

function fakeClient(input: {
  metadata?: Array<{ sport?: string; tags?: string; series?: string }>;
  tags?: Record<string, { id?: string | number; slug?: string }>;
  tagEvents?: Record<string, SportsEventRecord[]>;
  tagIdEvents?: Record<string, SportsEventRecord[]>;
  series?: Record<string, Array<{ slug?: string; events?: SportsEventRecord[] }>>;
  searchEvents?: Record<string, SportsEventRecord[]>;
} = {}): SportsCatalogClient {
  return {
    fetchSportsMetadata: async () => input.metadata ?? [],
    fetchTagBySlug: async (slug) => input.tags?.[slug] ?? null,
    fetchEventsByTagId: async (id) => input.tagIdEvents?.[id] ?? [],
    fetchEventsByTagSlug: async (slug) => input.tagEvents?.[slug] ?? [],
    fetchSeriesBySlug: async (slug) => input.series?.[slug] ?? [],
    fetchEventsBySearch: async (query) => input.searchEvents?.[query] ?? []
  };
}
