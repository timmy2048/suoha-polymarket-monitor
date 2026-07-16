import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const optionalUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().url().optional()
);

const envSchema = z.object({
  THRESHOLD_USDC: z.coerce.number().positive().default(500_000),
  HOLDER_CHANGE_ALERT_USDC: z.coerce.number().positive().default(50_000),
  PREMATCH_MONITOR_MINUTES: z.coerce.number().int().positive().default(30),
  MATCH_MONITOR_DURATION_MINUTES: z.coerce.number().int().positive().default(105),
  HOLDER_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  SCHEDULE_REFRESH_MODE: z.enum(["daily"]).default("daily"),
  SCHEDULE_REFRESH_TIME_LOCAL: z.string().default("00:05"),
  HOLDER_RANK_LIMIT: z.coerce.number().int().positive().default(1),
  HOLDER_EVENT_SCOPE_PATHS: z.string().default("world-cup"),
  HOLDER_SPORT_WINDOWS: z.string().default("soccer:30:105,basketball:30:180,tennis:30:240,baseball:30:240,hockey:30:150,football:30:210"),
  LARGE_TRADE_THRESHOLD_USDC: z.coerce.number().positive().optional(),
  LARGE_TRADE_MIN_CANDIDATE_USDC: z.coerce.number().positive().optional(),
  LARGE_TRADE_CUMULATIVE_WINDOW_SECONDS: z.coerce.number().int().positive().optional(),
  LARGE_TRADE_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().optional(),
  MIN_TRADE_USDC: z.coerce.number().positive().default(50_000),
  TRADE_FETCH_LIMIT: z.coerce.number().int().positive().default(500),
  CUMULATIVE_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),
  WATCHLIST_FILE: z.string().default("config/watchlist.json"),
  ADDRESS_SPORTS_SCOPE_PATHS: z.string().default("sports"),
  SPORTS_CATALOG_REFRESH_SECONDS: z.coerce.number().int().positive().default(900),
  ADDRESS_MONITOR_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  ADDRESS_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),
  ADDRESS_AGGREGATION_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),
  ADDRESS_LOOKBACK_OVERLAP_SECONDS: z.coerce.number().int().nonnegative().default(180),
  ADDRESS_TRADE_FETCH_LIMIT: z.coerce.number().int().positive().max(10_000).default(1_000),
  WORLD_CUP_EVENT_SLUGS: z.string().default(""),
  WORLD_CUP_EVENT_PREFIXES: z.string().default("fifwc-"),
  DINGTALK_LARGE_TRADE_WEBHOOK_URL: optionalUrl,
  DINGTALK_LARGE_TRADE_SECRET: z.string().optional(),
  DINGTALK_LARGE_TRADE_KEYWORD: z.string().default("跟单"),
  DINGTALK_ADDRESS_WEBHOOK_URL: optionalUrl,
  DINGTALK_ADDRESS_SECRET: z.string().optional(),
  DINGTALK_ADDRESS_KEYWORD: z.string().default("sport"),
  DINGTALK_WEBHOOK_URL: optionalUrl,
  DINGTALK_SECRET: z.string().optional(),
  DATA_DIR: z.string().default("data")
});

export interface AppConfig {
  thresholdUsdc: number;
  holderChangeAlertUsdc: number;
  prematchMonitorMinutes: number;
  matchMonitorDurationMinutes: number;
  holderPollIntervalMs: number;
  scheduleRefreshMode: "daily";
  scheduleRefreshTimeLocal: string;
  holderRankLimit: number;
  holderEventScopePaths: string[];
  holderSportWindows: Record<string, HolderSportWindow>;
  minTradeUsdc: number;
  tradeFetchLimit: number;
  cumulativeWindowSeconds: number;
  pollIntervalMs: number;
  watchlistFile: string;
  addressSportsScopePaths: string[];
  sportsCatalogRefreshMs: number;
  addressMonitorEnabled: boolean;
  addressPollIntervalMs: number;
  addressAggregationWindowMs: number;
  addressLookbackOverlapSeconds: number;
  addressTradeFetchLimit: number;
  worldCupEventSlugs: string[];
  worldCupEventPrefixes: string[];
  largeTradeWebhookUrl?: string;
  largeTradeSecret?: string;
  dingTalkWebhookUrl?: string;
  dingTalkSecret?: string;
  largeTradeKeyword: string;
  addressWebhookUrl?: string;
  addressSecret?: string;
  addressKeyword: string;
  stateFile: string;
  alertsFile: string;
  addressAlertsFile: string;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const dataDir = path.resolve(parsed.DATA_DIR);
  const largeTradeThresholdUsdc = parsed.LARGE_TRADE_THRESHOLD_USDC ?? parsed.THRESHOLD_USDC;
  const minTradeUsdc = parsed.LARGE_TRADE_MIN_CANDIDATE_USDC ?? parsed.MIN_TRADE_USDC;
  const cumulativeWindowSeconds = parsed.LARGE_TRADE_CUMULATIVE_WINDOW_SECONDS ?? parsed.CUMULATIVE_WINDOW_SECONDS;
  const pollIntervalSeconds = parsed.LARGE_TRADE_POLL_INTERVAL_SECONDS ?? parsed.POLL_INTERVAL_SECONDS;

  return {
    thresholdUsdc: largeTradeThresholdUsdc,
    holderChangeAlertUsdc: parsed.HOLDER_CHANGE_ALERT_USDC,
    prematchMonitorMinutes: parsed.PREMATCH_MONITOR_MINUTES,
    matchMonitorDurationMinutes: parsed.MATCH_MONITOR_DURATION_MINUTES,
    holderPollIntervalMs: parsed.HOLDER_POLL_INTERVAL_SECONDS * 1000,
    scheduleRefreshMode: parsed.SCHEDULE_REFRESH_MODE,
    scheduleRefreshTimeLocal: parsed.SCHEDULE_REFRESH_TIME_LOCAL,
    holderRankLimit: parsed.HOLDER_RANK_LIMIT,
    holderEventScopePaths: splitCsv(parsed.HOLDER_EVENT_SCOPE_PATHS),
    holderSportWindows: parseHolderSportWindows(parsed.HOLDER_SPORT_WINDOWS),
    minTradeUsdc,
    tradeFetchLimit: parsed.TRADE_FETCH_LIMIT,
    cumulativeWindowSeconds,
    pollIntervalMs: pollIntervalSeconds * 1000,
    watchlistFile: path.resolve(parsed.WATCHLIST_FILE),
    addressSportsScopePaths: splitCsv(parsed.ADDRESS_SPORTS_SCOPE_PATHS),
    sportsCatalogRefreshMs: parsed.SPORTS_CATALOG_REFRESH_SECONDS * 1000,
    addressMonitorEnabled: parsed.ADDRESS_MONITOR_ENABLED,
    addressPollIntervalMs: parsed.ADDRESS_POLL_INTERVAL_SECONDS * 1000,
    addressAggregationWindowMs: parsed.ADDRESS_AGGREGATION_WINDOW_SECONDS * 1000,
    addressLookbackOverlapSeconds: parsed.ADDRESS_LOOKBACK_OVERLAP_SECONDS,
    addressTradeFetchLimit: parsed.ADDRESS_TRADE_FETCH_LIMIT,
    worldCupEventSlugs: splitCsv(parsed.WORLD_CUP_EVENT_SLUGS),
    worldCupEventPrefixes: splitCsv(parsed.WORLD_CUP_EVENT_PREFIXES),
    largeTradeWebhookUrl: parsed.DINGTALK_LARGE_TRADE_WEBHOOK_URL ?? parsed.DINGTALK_WEBHOOK_URL,
    largeTradeSecret: parsed.DINGTALK_LARGE_TRADE_SECRET ?? parsed.DINGTALK_SECRET,
    dingTalkWebhookUrl: parsed.DINGTALK_LARGE_TRADE_WEBHOOK_URL ?? parsed.DINGTALK_WEBHOOK_URL,
    dingTalkSecret: parsed.DINGTALK_LARGE_TRADE_SECRET ?? parsed.DINGTALK_SECRET,
    largeTradeKeyword: parsed.DINGTALK_LARGE_TRADE_KEYWORD,
    addressWebhookUrl: parsed.DINGTALK_ADDRESS_WEBHOOK_URL,
    addressSecret: parsed.DINGTALK_ADDRESS_SECRET,
    addressKeyword: parsed.DINGTALK_ADDRESS_KEYWORD,
    stateFile: path.join(dataDir, "state.json"),
    alertsFile: path.join(dataDir, "alerts.ndjson"),
    addressAlertsFile: path.join(dataDir, "address-alerts.ndjson")
  };
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export interface HolderSportWindow {
  prematchMinutes: number;
  postMatchMinutes: number;
}

function parseHolderSportWindows(value: string): Record<string, HolderSportWindow> {
  const windows: Record<string, HolderSportWindow> = {};
  for (const entry of value.split(",").map((item) => item.trim()).filter(Boolean)) {
    const [sport, prematch, postMatch] = entry.split(":").map((item) => item.trim().toLowerCase());
    const prematchMinutes = Number(prematch);
    const postMatchMinutes = Number(postMatch);
    if (!sport || !Number.isInteger(prematchMinutes) || prematchMinutes < 0 || !Number.isInteger(postMatchMinutes) || postMatchMinutes <= 0) {
      throw new Error(`Invalid HOLDER_SPORT_WINDOWS entry: ${entry}`);
    }
    windows[sport] = { prematchMinutes, postMatchMinutes };
  }
  if (Object.keys(windows).length === 0) {
    throw new Error("HOLDER_SPORT_WINDOWS must contain at least one sport window");
  }
  return windows;
}
