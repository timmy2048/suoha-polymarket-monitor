import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Trade } from "./filter.js";
import {
  classifyTargetMarket,
  isTargetHolderMarket,
  type HolderMarket,
  type HolderPosition,
  type MatchEvent,
  type TopHolder
} from "./holder.js";
import { createDefaultFetch } from "./http.js";
import type {
  SportsEventRecord,
  SportsMetadataRecord,
  SportsSeriesRecord,
  SportsTagRecord
} from "./sports.js";

export interface PolymarketTrade {
  proxyWallet?: string;
  side?: string;
  asset?: string;
  conditionId?: string;
  size?: number | string;
  price?: number | string;
  timestamp?: number | string;
  title?: string;
  slug?: string;
  eventSlug?: string;
  outcome?: string;
  outcomeIndex?: number | string;
  transactionHash?: string;
}

interface PolymarketGammaEvent extends SportsEventRecord {
  slug: string;
  title: string;
  startTime?: string;
  eventStartTime?: string;
  gameStartTime?: string;
  endDate?: string;
  markets?: PolymarketGammaMarket[];
}

interface PolymarketGammaMarket {
  slug?: string;
  question?: string;
  conditionId?: string;
  gameStartTime?: string;
  outcomes?: string;
  clobTokenIds?: string;
  groupItemTitle?: string;
}

export interface TradeQueryOptions {
  limit?: number;
  offset?: number;
  takerOnly?: boolean;
  filterType?: "CASH" | "TOKENS";
  filterAmount?: number;
  market?: string[];
  eventId?: string[];
  user?: string;
  side?: "BUY" | "SELL";
  start?: number;
  end?: number;
}

interface PolymarketHolderToken {
  token: string;
  holders?: PolymarketHolder[];
}

interface PolymarketHolder {
  proxyWallet: string;
  name?: string;
  pseudonym?: string;
  asset?: string;
  outcomeIndex?: number | string;
  amount?: number | string;
}

interface PolymarketPosition {
  proxyWallet?: string;
  asset?: string;
  conditionId?: string;
  slug?: string;
  outcome?: string;
  size?: number | string;
  avgPrice?: number | string;
  initialValue?: number | string;
}

export interface PolymarketClientOptions {
  endpoint?: string;
  gammaEndpoint?: string;
  dataEndpoint?: string;
  gamesPageUrl?: string;
  fallbackPageHtmlFetcher?: (url: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  retryDelayMs?: number;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
const execFileAsync = promisify(execFile);

export class PolymarketClient {
  private readonly endpoint: string;
  private readonly gammaEndpoint: string;
  private readonly dataEndpoint: string;
  private readonly gamesPageUrl: string;
  private readonly fallbackPageHtmlFetcher: (url: string) => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(options: PolymarketClientOptions = {}) {
    this.endpoint = options.endpoint ?? "https://data-api.polymarket.com/trades";
    this.gammaEndpoint = options.gammaEndpoint ?? "https://gamma-api.polymarket.com";
    this.dataEndpoint = options.dataEndpoint ?? "https://data-api.polymarket.com";
    this.gamesPageUrl = options.gamesPageUrl ?? "https://polymarket.com/sports/world-cup";
    this.fallbackPageHtmlFetcher = options.fallbackPageHtmlFetcher ?? fetchPageHtmlWithCurl;
    this.fetchImpl = options.fetchImpl ?? createDefaultFetch();
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  async fetchTradesByCash(minCashUsdc: number, limit = 100): Promise<Trade[]> {
    return this.fetchRecentTrades({ limit, filterType: "CASH", filterAmount: minCashUsdc });
  }

  async fetchLargeTrades(thresholdUsdc: number, limit = 100): Promise<Trade[]> {
    return this.fetchTradesByCash(thresholdUsdc, limit);
  }

  async fetchRecentTrades(options: TradeQueryOptions = {}): Promise<Trade[]> {
    const response = await this.fetchTradeRecords(options);
    if (!response.ok && response.status === 408 && (options.limit ?? 100) > 10) {
      const retryResponse = await this.fetchTradeRecords({ ...options, limit: 10 });
      return this.parseTradeResponse(retryResponse);
    }

    return this.parseTradeResponse(response);
  }

  async fetchWorldCupGameSlugs(): Promise<string[]> {
    let html: string;
    try {
      const response = await this.requestWithRetries(() =>
        this.fetchImpl(this.gamesPageUrl, {
          headers: {
            accept: "text/html",
            "user-agent": "Mozilla/5.0"
          }
        })
      );
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Polymarket games page failed with ${response.status}: ${body}`);
      }
      html = await response.text();
    } catch (error) {
      try {
        html = await this.fallbackPageHtmlFetcher(this.gamesPageUrl);
      } catch (fallbackError) {
        throw new Error(
          `Polymarket games page failed with fetch (${describeError(error)}) and fallback (${describeError(fallbackError)})`
        );
      }
    }

    const pageSlugs = extractWorldCupGameSlugs(html);
    if (pageSlugs.length > 0) {
      return pageSlugs;
    }

    try {
      const events = await this.fetchEventsByTagSlug("world-cup");
      return [...new Set(events.map((event) => event.slug).filter((slug): slug is string => /^fifwc-[a-z0-9]+-[a-z0-9]+-\d{4}-\d{2}-\d{2}$/.test(slug ?? "")))].sort();
    } catch {
      return [];
    }
  }

  async fetchMatchEvent(slug: string): Promise<MatchEvent | null> {
    const [baseEvent, moreEvent] = await Promise.all([this.fetchGammaEvent(slug), this.fetchGammaEvent(`${slug}-more-markets`)]);
    const event = baseEvent ?? moreEvent;
    if (!event) {
      return null;
    }

    const gameStartTime = event.gameStartTime ?? event.eventStartTime ?? event.startTime ?? event.endDate;
    if (!gameStartTime) {
      return null;
    }

    const markets = [...normalizeHolderMarkets(baseEvent, gameStartTime), ...normalizeHolderMarkets(moreEvent, gameStartTime)];
    return {
      slug: event.slug,
      title: event.title,
      gameStartTime,
      markets
    };
  }

  async fetchTopHolders(conditionId: string, limit = 1): Promise<TopHolder[]> {
    const url = new URL(`${this.dataEndpoint}/holders`);
    url.searchParams.set("market", conditionId);
    url.searchParams.set("limit", String(limit));
    const payload = (await this.fetchJson(url.toString())) as PolymarketHolderToken[];
    return payload.flatMap((group) =>
      (group.holders ?? []).slice(0, limit).map((holder) => ({
        wallet: holder.proxyWallet,
        name: holder.name,
        pseudonym: holder.pseudonym,
        tokenId: holder.asset ?? group.token,
        outcomeIndex: Number(holder.outcomeIndex),
        shares: Number(holder.amount)
      }))
    ).filter((holder) => holder.wallet && holder.tokenId && Number.isFinite(holder.outcomeIndex) && Number.isFinite(holder.shares));
  }

  async fetchHolderPositions(wallet: string, conditionId: string): Promise<HolderPosition[]> {
    const url = new URL(`${this.dataEndpoint}/positions`);
    url.searchParams.set("user", wallet);
    url.searchParams.set("market", conditionId);
    const payload = (await this.fetchJson(url.toString())) as PolymarketPosition[];
    return payload.map(normalizePosition).filter((position): position is HolderPosition => position !== null);
  }

  async fetchSportsMetadata(): Promise<SportsMetadataRecord[]> {
    return asArray(await this.fetchJson(`${this.gammaEndpoint}/sports`)) as SportsMetadataRecord[];
  }

  async fetchTagBySlug(slug: string): Promise<SportsTagRecord | null> {
    const payload = await this.fetchJson(`${this.gammaEndpoint}/tags/slug/${encodeURIComponent(slug)}`);
    if (Array.isArray(payload)) {
      return (payload[0] as SportsTagRecord | undefined) ?? null;
    }
    return payload && typeof payload === "object" ? (payload as SportsTagRecord) : null;
  }

  async fetchEventsByTagId(tagId: string): Promise<SportsEventRecord[]> {
    const url = new URL(`${this.gammaEndpoint}/events`);
    url.searchParams.set("tag_id", tagId);
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");
    url.searchParams.set("limit", "500");
    return asArray(await this.fetchJson(url.toString())) as SportsEventRecord[];
  }

  async fetchEventsByTagSlug(slug: string): Promise<SportsEventRecord[]> {
    const url = new URL(`${this.gammaEndpoint}/events`);
    url.searchParams.set("tag_slug", slug);
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");
    url.searchParams.set("limit", "500");
    return asArray(await this.fetchJson(url.toString())) as SportsEventRecord[];
  }

  async fetchSeriesBySlug(slug: string): Promise<SportsSeriesRecord[]> {
    const url = new URL(`${this.gammaEndpoint}/series`);
    url.searchParams.set("slug", slug);
    url.searchParams.set("limit", "100");
    return asArray(await this.fetchJson(url.toString())) as SportsSeriesRecord[];
  }

  private async fetchTradeRecords(options: TradeQueryOptions): Promise<Response> {
    const url = new URL(this.endpoint);
    setQueryNumber(url, "limit", options.limit);
    setQueryNumber(url, "offset", options.offset);
    if (options.takerOnly !== undefined) url.searchParams.set("takerOnly", String(options.takerOnly));
    if (options.filterType) url.searchParams.set("filterType", options.filterType);
    setQueryNumber(url, "filterAmount", options.filterAmount);
    if (options.market?.length) url.searchParams.set("market", options.market.join(","));
    if (options.eventId?.length) url.searchParams.set("eventId", options.eventId.join(","));
    if (options.user) url.searchParams.set("user", options.user);
    if (options.side) url.searchParams.set("side", options.side);
    setQueryNumber(url, "start", options.start);
    setQueryNumber(url, "end", options.end);

    return this.requestWithRetries(() =>
      this.fetchImpl(url.toString(), {
        headers: { accept: "application/json", "user-agent": "Mozilla/5.0" }
      })
    );
  }

  private async fetchGammaEvent(slug: string): Promise<PolymarketGammaEvent | null> {
    const url = new URL(`${this.gammaEndpoint}/events`);
    url.searchParams.set("slug", slug);
    const payload = await this.fetchJson(url.toString());
    if (Array.isArray(payload)) {
      return (payload[0] as PolymarketGammaEvent | undefined) ?? null;
    }
    return payload && typeof payload === "object" ? (payload as PolymarketGammaEvent) : null;
  }

  private async fetchJson(url: string): Promise<unknown> {
    const response = await this.requestWithRetries(() =>
      this.fetchImpl(url, {
        headers: { accept: "application/json", "user-agent": "Mozilla/5.0" }
      })
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Polymarket API failed with ${response.status}: ${body}`);
    }
    return response.json();
  }

  private async requestWithRetries(request: () => Promise<Response>): Promise<Response> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await request();
        if (!isRetryableResponse(response) || attempt === this.maxRetries) {
          return response;
        }

        await this.waitBeforeRetry(attempt, `HTTP ${response.status}`);
      } catch (error) {
        if (attempt === this.maxRetries) {
          throw error;
        }

        await this.waitBeforeRetry(attempt, describeError(error));
      }
    }

    throw new Error("Polymarket trades request failed after retries");
  }

  private async waitBeforeRetry(attempt: number, reason: string): Promise<void> {
    const delayMs = this.retryDelayMs * (attempt + 1);
    console.warn(
      `[${new Date().toISOString()}] Polymarket trades request failed (${reason}), retrying attempt ${attempt + 2}/${
        this.maxRetries + 1
      } in ${delayMs}ms`
    );

    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }

  private async parseTradeResponse(response: Response): Promise<Trade[]> {
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Polymarket trades API failed with ${response.status}: ${body}`);
    }

    const payload = (await response.json()) as PolymarketTrade[] | { value?: PolymarketTrade[] };
    const records = Array.isArray(payload) ? payload : (payload.value ?? []);
    return records.map(normalizePolymarketTrade).filter((trade): trade is Trade => trade !== null);
  }
}

export function extractWorldCupGameSlugs(html: string): string[] {
  return [...new Set([...html.matchAll(/\bfifwc-[a-z0-9]+-[a-z0-9]+-\d{4}-\d{2}-\d{2}\b/g)].map((match) => match[0]))].sort();
}

async function fetchPageHtmlWithCurl(url: string): Promise<string> {
  const { stdout } = await execFileAsync("curl", ["-L", "--compressed", "-sS", "--max-time", "45", url], {
    encoding: "utf8",
    maxBuffer: 12 * 1024 * 1024,
    windowsHide: true
  });
  return stdout;
}

function isRetryableResponse(response: Response): boolean {
  return response.status === 408 || response.status >= 500;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizePolymarketTrade(record: PolymarketTrade): Trade | null {
  const size = Number(record.size);
  const price = Number(record.price);
  const timestamp = Number(record.timestamp);

  if (
    !record.proxyWallet ||
    !record.side ||
    !Number.isFinite(size) ||
    !Number.isFinite(price) ||
    !Number.isFinite(timestamp) ||
    !record.title ||
    !record.slug ||
    !record.eventSlug ||
    !record.transactionHash
  ) {
    return null;
  }

  return {
    proxyWallet: record.proxyWallet,
    side: record.side,
    size,
    price,
    timestamp,
    title: record.title,
    slug: record.slug,
    eventSlug: record.eventSlug,
    outcome: record.outcome,
    asset: record.asset,
    conditionId: record.conditionId?.toLowerCase(),
    outcomeIndex: Number.isFinite(Number(record.outcomeIndex)) ? Number(record.outcomeIndex) : undefined,
    transactionHash: record.transactionHash
  };
}

function normalizeHolderMarkets(event: PolymarketGammaEvent | null, fallbackGameStartTime: string): HolderMarket[] {
  if (!event) {
    return [];
  }

  return (event.markets ?? [])
    .map((market) => {
      const type = classifyTargetMarket(market);
      const outcomes = parseJsonStringArray(market.outcomes);
      const clobTokenIds = parseJsonStringArray(market.clobTokenIds);
      if (
        !type ||
        !isTargetHolderMarket({ type, slug: market.slug }) ||
        !market.slug ||
        !market.question ||
        !market.conditionId ||
        outcomes.length === 0 ||
        clobTokenIds.length === 0
      ) {
        return null;
      }

      return {
        eventSlug: event.slug,
        eventTitle: event.title,
        gameStartTime: market.gameStartTime ?? event.gameStartTime ?? event.eventStartTime ?? event.startTime ?? event.endDate ?? fallbackGameStartTime,
        slug: market.slug,
        question: market.question,
        conditionId: market.conditionId,
        type,
        outcomes,
        clobTokenIds
      };
    })
    .filter((market): market is HolderMarket => market !== null);
}

function normalizePosition(record: PolymarketPosition): HolderPosition | null {
  const shares = Number(record.size);
  const avgPrice = Number(record.avgPrice);
  if (
    !record.proxyWallet ||
    !record.asset ||
    !record.conditionId ||
    !record.slug ||
    !record.outcome ||
    !Number.isFinite(shares) ||
    !Number.isFinite(avgPrice)
  ) {
    return null;
  }

  return {
    wallet: record.proxyWallet,
    tokenId: record.asset,
    conditionId: record.conditionId,
    marketSlug: record.slug,
    outcome: record.outcome,
    shares,
    avgPrice,
    initialValue: Number.isFinite(Number(record.initialValue)) ? Number(record.initialValue) : undefined
  };
}

function parseJsonStringArray(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object" && Array.isArray((value as { data?: unknown }).data)) {
    return (value as { data: unknown[] }).data;
  }
  return [];
}

function setQueryNumber(url: URL, key: string, value: number | undefined): void {
  if (value !== undefined) {
    url.searchParams.set(key, String(value));
  }
}
