import { describe, expect, it, vi } from "vitest";
import { extractWorldCupGameSlugs, PolymarketClient } from "../src/polymarket.js";

describe("PolymarketClient", () => {
  it("retries transient network failures before returning trades", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          {
            proxyWallet: "0xabc",
            side: "BUY",
            size: 1100000,
            price: 0.99,
            timestamp: 1781917805,
            title: "Will Brazil win on 2026-06-19?",
            slug: "fifwc-bra-hai-2026-06-19-bra",
            eventSlug: "fifwc-bra-hai-2026-06-19",
            outcome: "Yes",
            transactionHash: "0xhash"
          }
        ]
      });
    const client = new PolymarketClient({
      endpoint: "https://example.test/trades",
      fetchImpl: fetchMock,
      retryDelayMs: 0
    });

    const trades = await client.fetchLargeTrades(1_000_000, 100);

    expect(trades).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries 5xx responses before returning trades", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => '{"error":"internal server error"}'
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          {
            proxyWallet: "0xabc",
            side: "BUY",
            size: 1100000,
            price: 0.99,
            timestamp: 1781917805,
            title: "Will Brazil win on 2026-06-19?",
            slug: "fifwc-bra-hai-2026-06-19-bra",
            eventSlug: "fifwc-bra-hai-2026-06-19",
            outcome: "Yes",
            transactionHash: "0xhash"
          }
        ]
      });
    const client = new PolymarketClient({
      endpoint: "https://example.test/trades",
      fetchImpl: fetchMock,
      retryDelayMs: 0
    });

    const trades = await client.fetchLargeTrades(1_000_000, 100);

    expect(trades).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to a smaller limit when the trades API times out", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 408,
        text: async () => '{"error":"Request timed out. Please try again."}'
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          {
            proxyWallet: "0xabc",
            side: "BUY",
            size: 1100000,
            price: 0.99,
            timestamp: 1781917805,
            title: "Will Brazil win on 2026-06-19?",
            slug: "fifwc-bra-hai-2026-06-19-bra",
            eventSlug: "fifwc-bra-hai-2026-06-19",
            outcome: "Yes",
            transactionHash: "0xhash"
          }
        ]
      });
    const client = new PolymarketClient({
      endpoint: "https://example.test/trades",
      fetchImpl: fetchMock,
      maxRetries: 0
    });

    const trades = await client.fetchLargeTrades(1_000_000, 100);

    expect(trades).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("limit=100");
    expect(String(fetchMock.mock.calls[1][0])).toContain("limit=10");
  });

  it("extracts unique World Cup match slugs from page html", () => {
    expect(
      extractWorldCupGameSlugs(
        "x fifwc-can-mar-2026-07-04 y fifwc-par-fra-2026-07-04 z fifwc-can-mar-2026-07-04 world-cup-winner"
      )
    ).toEqual(["fifwc-can-mar-2026-07-04", "fifwc-par-fra-2026-07-04"]);
  });

  it("falls back to a page html fetcher when the games page fetch fails", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const client = new PolymarketClient({
      gamesPageUrl: "https://example.test/world-cup",
      fetchImpl: fetchMock,
      fallbackPageHtmlFetcher: async () => "fifwc-can-mar-2026-07-04 fifwc-par-fra-2026-07-04",
      retryDelayMs: 0
    });

    await expect(client.fetchWorldCupGameSlugs()).resolves.toEqual(["fifwc-can-mar-2026-07-04", "fifwc-par-fra-2026-07-04"]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("accepts a Gamma event object and uses its kickoff time for holder monitoring", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          slug: "fifwc-ecu-ger-2026-06-25",
          title: "Ecuador vs. Germany",
          startTime: "2026-06-25T20:00:00Z",
          endDate: "2026-06-25T21:55:00Z",
          markets: [
            {
              slug: "fifwc-ecu-ger-2026-06-25-ecu",
              question: "Will Ecuador win on 2026-06-25?",
              conditionId: "0xcondition",
              outcomes: '["Yes","No"]',
              clobTokenIds: '["yes-token","no-token"]'
            }
          ]
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => []
      });
    const client = new PolymarketClient({
      gammaEndpoint: "https://example.test",
      fetchImpl: fetchMock,
      retryDelayMs: 0,
      maxRetries: 0
    });

    const match = await client.fetchMatchEvent("fifwc-ecu-ger-2026-06-25");

    expect(match?.gameStartTime).toBe("2026-06-25T20:00:00Z");
    expect(match?.markets[0]?.gameStartTime).toBe("2026-06-25T20:00:00Z");
  });
});
