import type { Trade } from "./filter.js";

export interface SportsMarketRecord {
  conditionId?: string;
  condition_id?: string;
  slug?: string;
  question?: string;
  groupItemTitle?: string;
  sportsMarketType?: string;
  line?: number | string;
  gameStartTime?: string;
  eventStartTime?: string;
  startTime?: string;
  endDate?: string;
}

export interface SportsEventRecord {
  id?: string | number;
  slug?: string;
  title?: string;
  sport?: string | { sport?: string };
  startTime?: string;
  eventStartTime?: string;
  gameStartTime?: string;
  endDate?: string;
  active?: boolean;
  closed?: boolean;
  markets?: SportsMarketRecord[];
}

export interface SportsTagRecord {
  id?: string | number;
  slug?: string;
}

export interface SportsSeriesRecord {
  slug?: string;
  events?: SportsEventRecord[];
}

export interface SportsMetadataRecord {
  sport?: string;
  tags?: string;
  series?: string;
}

export interface SportsCatalogClient {
  fetchSportsMetadata(): Promise<SportsMetadataRecord[]>;
  fetchTagBySlug(slug: string): Promise<SportsTagRecord | null>;
  fetchEventsByTagId(tagId: string): Promise<SportsEventRecord[]>;
  fetchEventsByTagSlug(slug: string): Promise<SportsEventRecord[]>;
  fetchSeriesBySlug(slug: string): Promise<SportsSeriesRecord[]>;
  fetchEventsBySearch?(query: string): Promise<SportsEventRecord[]>;
}

export interface SportsScope {
  path: string;
  events: SportsEventRecord[];
  conditionIds: string[];
  eventSlugs: string[];
  marketSlugs: string[];
}

export interface SportsCatalog {
  refreshedAt: string;
  scopes: SportsScope[];
  conditionIds: Set<string>;
  eventSlugs: Set<string>;
  marketSlugs: Set<string>;
}

export async function buildSportsCatalog(client: SportsCatalogClient, scopePaths: string[]): Promise<SportsCatalog> {
  const normalizedPaths = [...new Set(scopePaths.map(normalizeScopePath).filter(Boolean))];
  const scopes = await mapWithConcurrency(normalizedPaths, 4, async (path) => {
    const events = await resolveScopeEvents(client, path);
    return {
      path,
      events,
      conditionIds: unique(
        events
          .flatMap((event) => (event.markets ?? []).map(marketConditionId))
          .filter((value): value is string => Boolean(value))
      ),
      eventSlugs: unique(events.map((event) => event.slug?.toLowerCase()).filter((value): value is string => Boolean(value))),
      marketSlugs: unique(
        events
          .flatMap((event) => event.markets ?? [])
          .map((market) => market.slug?.toLowerCase())
          .filter((value): value is string => Boolean(value))
      )
    } satisfies SportsScope;
  });

  return {
    refreshedAt: new Date().toISOString(),
    scopes,
    conditionIds: new Set(scopes.flatMap((scope) => scope.conditionIds)),
    eventSlugs: new Set(scopes.flatMap((scope) => scope.eventSlugs)),
    marketSlugs: new Set(scopes.flatMap((scope) => scope.marketSlugs))
  };
}

export function matchesSportsCatalog(trade: Trade, catalog: SportsCatalog): boolean {
  return (
    (trade.conditionId ? catalog.conditionIds.has(trade.conditionId.toLowerCase()) : false) ||
    catalog.eventSlugs.has(trade.eventSlug.toLowerCase()) ||
    catalog.marketSlugs.has(trade.slug.toLowerCase())
  );
}

export function normalizeScopePath(value: string): string {
  return value.trim().toLowerCase().replace(/^\/+|\/+$/g, "");
}

const SCOPE_ALIASES: Record<string, string[]> = {
  "mlc": ["major-league-cricket"],
  "international": ["international", "international-cricket"],
  "lpl": ["lanka-premier-league"],
  "shpageeza": ["cricshpageeza"],
  "atp-doubles": ["atp-doubles"],
  "wta-doubles": ["wta-doubles"],
  "bsn": ["bsn"],
  "liga-mx": ["mex-2025", "mex-2026"],
  "australia-cup": ["soccer-auc"],
  "primera-division-argentina": ["primera-divisin-argentina", "arg-2025", "arg-2026"],
  "uel": ["uel", "uel-2025", "uel-2026"],
  "uefa-europa-conference-league": ["europa-conference-league"],
  "brazil-serie-a": ["brazil-serie-a"]
};

const SEARCH_SCOPE_ALIASES: Record<string, string> = {
  "shpageeza": "shpageeza",
  "bsn": "bsn"
};

export function expandScopeAliases(scopePath: string): string[] {
  const normalized = normalizeScopePath(scopePath);
  const parts = normalized.split("/").filter((part) => part && part !== "games");
  const leaf = parts.at(-1);
  if (!leaf) {
    return [];
  }

  const aliases = SCOPE_ALIASES[leaf] ?? [leaf];
  return [...new Set(aliases)];
}

export function scopeSearchQuery(scopePath: string): string | undefined {
  const normalized = normalizeScopePath(scopePath);
  const parts = normalized.split("/").filter((part) => part && part !== "games");
  const leaf = parts.at(-1);
  return leaf ? SEARCH_SCOPE_ALIASES[leaf] : undefined;
}

async function resolveScopeEvents(client: SportsCatalogClient, scopePath: string): Promise<SportsEventRecord[]> {
  if (scopePath === "sports") {
    const metadata = await client.fetchSportsMetadata();
    const tagCounts = new Map<string, number>();
    for (const item of metadata) {
      for (const tagId of (item.tags ?? "").split(",").map((tag) => tag.trim()).filter(Boolean)) {
        tagCounts.set(tagId, (tagCounts.get(tagId) ?? 0) + 1);
      }
    }
    const allMetadataTagIds = [...tagCounts.entries()]
      .filter(([, count]) => metadata.length > 0 && count === metadata.length)
      .map(([tagId]) => tagId);
    const tagIds = allMetadataTagIds.length > 0 ? allMetadataTagIds : [...tagCounts.keys()];
    const events = await Promise.all(tagIds.map((tagId) => client.fetchEventsByTagId(tagId)));
    return uniqueEvents(events.flat());
  }

  const aliases = expandScopeAliases(scopePath);
  if (aliases.length === 0) {
    return [];
  }

  const resolved = await Promise.all(
    aliases.map(async (alias) => {
      const [tag, series] = await Promise.all([
        client.fetchTagBySlug(alias).catch(() => null),
        client.fetchSeriesBySlug(alias).catch(() => [])
      ]);
      let tagEvents = tag?.id === undefined
        ? await client.fetchEventsByTagSlug(alias).catch(() => [])
        : await client.fetchEventsByTagId(String(tag.id)).catch(() => []);
      if (tag?.id !== undefined && tagEvents.length === 0) {
        tagEvents = await client.fetchEventsByTagSlug(alias).catch(() => []);
      }
      return [...tagEvents, ...series.flatMap((item) => item.events ?? [])];
    })
  );

  const events = resolved.flat();
  if (events.length > 0 || !client.fetchEventsBySearch) {
    return uniqueEvents(events);
  }

  const query = scopeSearchQuery(scopePath);
  if (!query) {
    return uniqueEvents(events);
  }
  return uniqueEvents(await client.fetchEventsBySearch(query).catch(() => []));
}

function marketConditionId(market: SportsMarketRecord): string | undefined {
  const value = market.conditionId ?? market.condition_id;
  return value?.toLowerCase();
}

function uniqueEvents(events: SportsEventRecord[]): SportsEventRecord[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = String(event.id ?? event.slug ?? JSON.stringify(event));
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

async function mapWithConcurrency<T, R>(values: T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) {
        return;
      }
      results[index] = await mapper(values[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}
