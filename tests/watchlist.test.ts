import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWatchlist, parseWatchlist } from "../src/watchlist.js";

describe("watchlist", () => {
  it("normalizes scopes and wallet addresses", () => {
    expect(
      parseWatchlist({
        largeTradeScopes: ["World-Cup", "world-cup", "tennis/games"],
        wallets: [{ address: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD", label: "Trader", enabled: true }]
      })
    ).toEqual({
      largeTradeScopes: ["world-cup", "tennis/games"],
      wallets: [{ address: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", label: "Trader", enabled: true }]
    });
  });

  it("defaults missing optional collections and wallet enabled state", () => {
    expect(parseWatchlist({})).toEqual({ largeTradeScopes: [], wallets: [] });
    expect(parseWatchlist({ wallets: [{ address: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" }] }).wallets[0]?.enabled).toBe(true);
  });

  it("rejects malformed wallet addresses", () => {
    expect(() => parseWatchlist({ wallets: [{ address: "not-an-address" }] })).toThrow();
  });

  it("loads a JSON watchlist from disk", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "suoha-watchlist-"));
    try {
      await mkdir(path.join(directory, "config"));
      const file = path.join(directory, "config", "watchlist.json");
      await writeFile(file, JSON.stringify({ largeTradeScopes: ["nba/games"] }));
      await expect(loadWatchlist(file)).resolves.toEqual({ largeTradeScopes: ["nba/games"], wallets: [] });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
