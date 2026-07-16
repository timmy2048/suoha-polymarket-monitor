import { readFile } from "node:fs/promises";
import { z } from "zod";

const walletSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "wallet address must be a 0x-prefixed 40-byte hex address"),
  label: z.string().trim().min(1).max(120).optional(),
  enabled: z.boolean().default(true)
});

const watchlistSchema = z.object({
  largeTradeScopes: z.array(z.string().trim().min(1)).default([]),
  wallets: z.array(walletSchema).default([])
});

export interface WatchedWallet {
  address: string;
  label?: string;
  enabled: boolean;
}

export interface Watchlist {
  largeTradeScopes: string[];
  wallets: WatchedWallet[];
}

export function parseWatchlist(value: unknown): Watchlist {
  const parsed = watchlistSchema.parse(value);
  return {
    largeTradeScopes: [...new Set(parsed.largeTradeScopes.map((scope) => scope.toLowerCase()))],
    wallets: parsed.wallets.map((wallet) => ({
      ...wallet,
      address: wallet.address.toLowerCase()
    }))
  };
}

export async function loadWatchlist(filePath: string): Promise<Watchlist> {
  const raw = await readFile(filePath, "utf8");
  return parseWatchlist(JSON.parse(raw) as unknown);
}
