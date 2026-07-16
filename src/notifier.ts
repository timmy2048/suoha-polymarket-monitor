import crypto from "node:crypto";
import type { Alert } from "./monitor.js";
import { formatUtcAndBeijing } from "./time.js";

export type AlertChannel = "large-trade" | "address-trade";

export interface Notifier {
  send(alert: Alert): Promise<void>;
  sendStartup?(settings: StartupNotificationSettings): Promise<void>;
}

export interface DingTalkNotifierOptions {
  webhookUrl: string;
  secret?: string;
  keyword?: string;
  fetchImpl?: typeof fetch;
}

export interface DingTalkMarkdownPayload {
  title: string;
  text: string;
}

export interface StartupNotificationSettings {
  channel?: AlertChannel;
  thresholdUsdc: number;
  holderChangeAlertUsdc?: number;
  prematchMonitorMinutes?: number;
  matchMonitorDurationMinutes?: number;
  holderPollIntervalMs?: number;
  holderRankLimit?: number;
  scheduleRefreshTimeLocal?: string;
  minTradeUsdc?: number;
  cumulativeWindowSeconds?: number;
  pollIntervalMs: number;
  addressPollIntervalMs?: number;
  addressAggregationWindowMs?: number;
  sportsCatalogRefreshMs?: number;
  worldCupEventSlugs?: string[];
  worldCupEventPrefixes?: string[];
  holderEventScopePaths?: string[];
  holderSportWindows?: Record<string, { prematchMinutes: number; postMatchMinutes: number }>;
}

const LARGE_TRADE_KEYWORD = "\u8ddf\u5355";

export class DingTalkNotifier implements Notifier {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: DingTalkNotifierOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(alert: Alert): Promise<void> {
    await this.postMarkdown(formatDingTalkMarkdown(alert, this.options.keyword ?? LARGE_TRADE_KEYWORD));
  }

  async sendStartup(settings: StartupNotificationSettings): Promise<void> {
    await this.postMarkdown(formatStartupMarkdown(settings));
  }

  private async postMarkdown(markdown: DingTalkMarkdownPayload): Promise<void> {
    const url = buildDingTalkWebhookUrl(this.options.webhookUrl, this.options.secret);
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msgtype: "markdown", markdown })
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`DingTalk webhook failed with ${response.status}: ${body}`);
    }

    const result = parseDingTalkResult(body);
    if (result && result.errcode !== 0) {
      throw new Error(`DingTalk webhook rejected message with errcode ${result.errcode}: ${result.errmsg ?? "unknown error"}`);
    }
  }
}

function parseDingTalkResult(body: string): { errcode: number; errmsg?: string } | null {
  if (!body.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(body) as { errcode?: unknown; errmsg?: unknown };
    if (typeof parsed.errcode !== "number") {
      return null;
    }
    return {
      errcode: parsed.errcode,
      errmsg: typeof parsed.errmsg === "string" ? parsed.errmsg : undefined
    };
  } catch {
    return null;
  }
}

export class RoutedNotifier implements Notifier {
  constructor(
    private readonly largeTradeNotifier: Notifier,
    private readonly addressNotifier?: Notifier
  ) {}

  async send(alert: Alert): Promise<void> {
    if (alert.channel === "address-trade") {
      if (!this.addressNotifier) {
        throw new Error("Address notifier is not configured");
      }
      await this.addressNotifier.send(alert);
      return;
    }
    await this.largeTradeNotifier.send(alert);
  }

  async sendStartup(settings: StartupNotificationSettings): Promise<void> {
    if (settings.channel === "address-trade") {
      await this.addressNotifier?.sendStartup?.(settings);
      return;
    }
    await this.largeTradeNotifier.sendStartup?.(settings);
  }
}

export class ConsoleNotifier implements Notifier {
  async send(alert: Alert): Promise<void> {
    const keyword = alert.channel === "address-trade" ? "sport" : LARGE_TRADE_KEYWORD;
    console.log(formatDingTalkMarkdown(alert, keyword).text);
  }

  async sendStartup(settings: StartupNotificationSettings): Promise<void> {
    console.log(formatStartupMarkdown(settings).text);
  }
}

export function buildDingTalkWebhookUrl(webhookUrl: string, secret?: string, timestamp = Date.now()): string {
  if (!secret) {
    return webhookUrl;
  }

  const url = new URL(webhookUrl);
  const sign = crypto.createHmac("sha256", secret).update(`${timestamp}\n${secret}`).digest("base64");
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("sign", sign);
  return url.toString();
}

export function formatDingTalkMarkdown(alert: Alert, keyword = LARGE_TRADE_KEYWORD): DingTalkMarkdownPayload {
  if (alert.channel === "address-trade" || alert.address) {
    return formatAddressMarkdown(alert, keyword);
  }
  if (alert.kind === "holder") {
    return formatHolderMarkdown(alert, keyword);
  }
  if (!alert.trade) {
    throw new Error(`Alert ${alert.key} is missing trade details`);
  }

  const { trade } = alert;
  const title = `${keyword} Polymarket \u5927\u989d\u6210\u4ea4\u63d0\u9192`;
  const side = trade.side.toUpperCase();
  const outcome = trade.outcome ? ` ${trade.outcome}` : "";
  const cumulativeLines =
    alert.kind === "cumulative"
      ? [
          `- \u7d2f\u8ba1\u7a97\u53e3: ${(alert.windowSeconds ?? 0) / 60} \u5206\u949f`,
          `- \u6210\u4ea4\u7b14\u6570: ${alert.tradeCount ?? 0}`,
          `- \u9996\u7b14\u65f6\u95f4: ${formatUtcAndBeijing(new Date((alert.firstTradeTimestamp ?? trade.timestamp) * 1000))}`,
          `- \u6700\u65b0\u65f6\u95f4: ${formatUtcAndBeijing(new Date((alert.latestTradeTimestamp ?? trade.timestamp) * 1000))}`
        ]
      : [];

  return {
    title,
    text: [
      `## ${title}`,
      "",
      `**${side}${outcome}**`,
      `- \u7c7b\u578b: ${alert.kind === "cumulative" ? "\u62c6\u5355\u7d2f\u8ba1" : "\u5355\u7b14\u6210\u4ea4"}`,
      `- \u5e02\u573a: ${trade.title}`,
      `- \u6210\u4ea4\u91d1\u989d: ${formatNumber(alert.cashValue)} USDC`,
      `- \u4efd\u989d: ${formatNumber(trade.size)}`,
      `- \u4ef7\u683c: ${trade.price}`,
      `- \u94b1\u5305: ${trade.proxyWallet}`,
      `- Event: ${trade.eventSlug}`,
      `- Market: ${trade.slug}`,
      `- Tx: ${trade.transactionHash}`,
      `- \u65f6\u95f4: ${formatUtcAndBeijing(new Date(trade.timestamp * 1000))}`,
      ...cumulativeLines,
      `- [\u6253\u5f00\u5e02\u573a](${alert.marketUrl})`
    ].join("\n")
  };
}

function formatHolderMarkdown(alert: Alert, keyword: string): DingTalkMarkdownPayload {
  if (!alert.holder) {
    throw new Error(`Alert ${alert.key} is missing holder details`);
  }
  const holder = alert.holder;
  const title = `${keyword} Polymarket Top Holder \u6301\u4ed3\u63d0\u9192`;
  const holderName = holder.holderName || holder.holderPseudonym || holder.wallet;
  const previous = holder.previousCostUsdc === undefined ? [] : [`- \u4e0a\u6b21\u63d0\u9192\u6210\u672c: ${formatNumber(holder.previousCostUsdc)} USDC`];
  const increase = holder.costIncreaseUsdc === undefined ? [] : [`- \u672c\u6b21\u589e\u52a0: ${formatNumber(holder.costIncreaseUsdc)} USDC`];

  return {
    title,
    text: [
      `## ${title}`,
      "",
      `- \u6bd4\u8d5b: ${holder.eventTitle}`,
      `- \u5f00\u8d5b\u65f6\u95f4: ${formatUtcAndBeijing(holder.gameStartTime)}`,
      `- \u76d8\u53e3\u7c7b\u578b: ${holder.marketType}`,
      `- \u5e02\u573a: ${holder.marketTitle}`,
      `- Outcome: ${holder.outcome}`,
      `- Top1: ${holderName}`,
      `- \u94b1\u5305: ${holder.wallet}`,
      `- \u4efd\u989d: ${formatNumber(holder.shares)}`,
      `- \u5e73\u5747\u4e70\u5165\u4ef7: ${holder.avgPrice}`,
      `- \u6301\u4ed3\u6210\u672c: ${formatNumber(holder.costUsdc)} USDC`,
      ...previous,
      ...increase,
      `- Event: ${holder.eventSlug}`,
      `- Market: ${holder.marketSlug}`,
      `- Token: ${holder.outcomeTokenId}`,
      `- [\u6253\u5f00\u5e02\u573a](${holder.marketUrl})`,
      `- [\u6253\u5f00\u5730\u5740](${holder.walletUrl})`
    ].join("\n")
  };
}

function formatAddressMarkdown(alert: Alert, keyword: string): DingTalkMarkdownPayload {
  if (!alert.address) {
    throw new Error(`Alert ${alert.key} is missing address details`);
  }
  const address = alert.address;
  const stage = address.stage === "initial" ? (address.side === "BUY" ? "\u9996\u4ed3" : "\u9996\u7b14") : address.side === "BUY" ? "\u52a0\u4ed3" : "\u7ee7\u7eed\u5356\u51fa";
  const title = `[${address.side}][${stage}] ${keyword} Polymarket Sports \u5730\u5740\u6210\u4ea4`;
  const txText = address.transactionHashes.slice(0, 10).join(", ");

  return {
    title,
    text: [
      `## ${title}`,
      "",
      `**${address.side} | ${stage}**`,
      `- \u94b1\u5305: ${address.walletLabel ? `${address.walletLabel} (${address.wallet})` : address.wallet}`,
      `- \u5e02\u573a: ${address.marketTitle}`,
      `- \u6807\u7684: ${address.outcome ?? "unknown"}`,
      `- \u6210\u4ea4\u91d1\u989d: ${formatNumber(address.totalCashValue)} USDC`,
      `- \u6210\u4ea4\u4efd\u989d: ${formatNumber(address.totalSize)}`,
      `- \u6210\u4ea4\u7b14\u6570: ${address.tradeCount}`,
      `- \u9996\u7b14\u65f6\u95f4: ${formatUtcAndBeijing(new Date(address.firstTimestamp * 1000))}`,
      `- \u6700\u65b0\u65f6\u95f4: ${formatUtcAndBeijing(new Date(address.lastTimestamp * 1000))}`,
      `- Event: ${address.eventSlug}`,
      `- Market: ${address.marketSlug}`,
      `- Tx: ${txText}`,
      `- [\u6253\u5f00\u5e02\u573a](${address.marketUrl})`,
      `- [\u6253\u5f00\u5730\u5740](${address.walletUrl})`
    ].join("\n")
  };
}

export function formatStartupMarkdown(settings: StartupNotificationSettings): DingTalkMarkdownPayload {
  const title = settings.channel === "address-trade" ? "sport Polymarket \u5730\u5740\u76d1\u63a7\u5df2\u542f\u52a8" : `${LARGE_TRADE_KEYWORD} Polymarket \u76d1\u63a7\u5df2\u542f\u52a8`;
  return {
    title,
    text: [
      `## ${title}`,
      "",
      "- \u72b6\u6001: \u76d1\u63a7\u5df2\u542f\u52a8",
      `- \u76d1\u63a7\u901a\u9053: ${settings.channel ?? "large-trade"}`,
      `- \u5927\u989d\u9608\u503c: ${formatNumber(settings.thresholdUsdc)} USDC`,
      `- \u5927\u989d\u8f6e\u8be2: ${(settings.pollIntervalMs ?? 0) / 1000} \u79d2`,
      `- \u5730\u5740\u8f6e\u8be2: ${(settings.addressPollIntervalMs ?? 0) / 1000} \u79d2`,
      `- \u5730\u5740\u805a\u5408\u7a97\u53e3: ${(settings.addressAggregationWindowMs ?? 0) / 60_000} \u5206\u949f`,
      `- Sports \u76ee\u5f55\u5237\u65b0: ${(settings.sportsCatalogRefreshMs ?? 0) / 60_000} \u5206\u949f`,
      `- Top Holder \u8f6e\u8be2: ${(settings.holderPollIntervalMs ?? 0) / 1000} \u79d2`,
      `- Top Holder \u8d5b\u524d\u7a97\u53e3: ${settings.prematchMonitorMinutes ?? 0} \u5206\u949f`,
      `- Top Holder \u6bd4\u8d5b\u7a97\u53e3: ${settings.matchMonitorDurationMinutes ?? 0} \u5206\u949f`,
      `- Top Holder \u8d5b\u4e8b\u8303\u56f4: ${(settings.holderEventScopePaths ?? []).join(", ") || "default"}`,
      `- Top Holder \u65f6\u95f4\u89c4\u5219: ${formatSportWindows(settings.holderSportWindows)}`,
      `- Holder \u589e\u91cf\u63d0\u9192: ${formatNumber(settings.holderChangeAlertUsdc ?? 0)} USDC`,
      `- \u542f\u52a8\u65f6\u95f4: ${formatUtcAndBeijing(new Date())}`
    ].join("\n")
  };
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function formatSportWindows(windows: StartupNotificationSettings["holderSportWindows"]): string {
  if (!windows) {
    return "default";
  }
  return Object.entries(windows)
    .map(([sport, window]) => `${sport}:${window.prematchMinutes}/${window.postMatchMinutes}`)
    .join(", ");
}
