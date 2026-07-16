import type { Trade } from "./filter.js";

export interface SportsMarketRecord {
  conditionId?: string;
  condition_id?: string;
  slug?: string;
}

export interface SportsEventRecord {
  id?: string | number;
  slug?: string;
  title?: string;
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
  const scopes: SportsScope[] = [];

  for (const path of normalizedPaths) {
    const events = await resolveScopeEvents(client, path);
    scopes.push({
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
    });
  }

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

  const parts = scopePath.split("/").filter((part) => part && part !== "games");
  const leaf = parts.at(-1);
  if (!leaf) {
    return [];
  }

  const [tag, tagEvents, series] = await Promise.all([
    client.fetchTagBySlug(leaf).catch(() => null),
    client.fetchEventsByTagSlug(leaf).catch(() => []),
    client.fetchSeriesBySlug(leaf).catch(() => [])
  ]);

  const tagEventsById = tag?.id === undefined ? [] : await client.fetchEventsByTagId(String(tag.id)).catch(() => []);
  return uniqueEvents([...tagEvents, ...tagEventsById, ...series.flatMap((item) => item.events ?? [])]);
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
