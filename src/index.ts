import { readConfig, type AppConfig } from "./config.js";
import { scanCombinedOnce, runCombinedMonitor } from "./appMonitor.js";
import { ConsoleNotifier, DingTalkNotifier, RoutedNotifier, type Notifier } from "./notifier.js";
import { PolymarketClient } from "./polymarket.js";
import { AlertStateStore } from "./state.js";

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  const config = readConfig();
  const stateStore = await AlertStateStore.load(config.stateFile);
  const notifier = createNotifier(config, once);

  if (once) {
    const alerts = await scanCombinedOnce(config, { client: new PolymarketClient(), notifier, stateStore });
    console.log(`combined scan complete, alerts=${alerts.length}`);
    return;
  }

  await sendStartupNotifications(config, notifier);
  console.log(
    `[${new Date().toISOString()}] combined monitor started, thresholdUsdc=${config.thresholdUsdc}, largePollSeconds=${
      config.pollIntervalMs / 1000
    }, addressEnabled=${config.addressMonitorEnabled}, addressPollSeconds=${config.addressPollIntervalMs / 1000}, holderPollSeconds=${
      config.holderPollIntervalMs / 1000
    }, catalogRefreshMinutes=${config.sportsCatalogRefreshMs / 60_000}`
  );
  await runCombinedMonitor(config, { client: new PolymarketClient(), notifier, stateStore });
}

function createNotifier(config: AppConfig, once: boolean): Notifier {
  const largeNotifier = config.largeTradeWebhookUrl
    ? new DingTalkNotifier({
        webhookUrl: config.largeTradeWebhookUrl,
        secret: config.largeTradeSecret,
        keyword: config.largeTradeKeyword
      })
    : new ConsoleNotifier();

  if (!once && !config.largeTradeWebhookUrl) {
    throw new Error("DINGTALK_LARGE_TRADE_WEBHOOK_URL or legacy DINGTALK_WEBHOOK_URL is required for continuous monitoring.");
  }

  const addressNotifier = config.addressWebhookUrl
    ? new DingTalkNotifier({
        webhookUrl: config.addressWebhookUrl,
        secret: config.addressSecret,
        keyword: config.addressKeyword
      })
    : once
      ? new ConsoleNotifier()
      : undefined;

  if (!once && config.addressMonitorEnabled && !addressNotifier) {
    throw new Error("DINGTALK_ADDRESS_WEBHOOK_URL is required when ADDRESS_MONITOR_ENABLED=true.");
  }

  return new RoutedNotifier(largeNotifier, addressNotifier);
}

async function sendStartupNotifications(config: AppConfig, notifier: Notifier): Promise<void> {
  await notifier.sendStartup?.({
    channel: "large-trade",
    thresholdUsdc: config.thresholdUsdc,
    holderChangeAlertUsdc: config.holderChangeAlertUsdc,
    prematchMonitorMinutes: config.prematchMonitorMinutes,
    matchMonitorDurationMinutes: config.matchMonitorDurationMinutes,
    holderPollIntervalMs: config.holderPollIntervalMs,
    holderRankLimit: config.holderRankLimit,
    scheduleRefreshTimeLocal: config.scheduleRefreshTimeLocal,
    minTradeUsdc: config.minTradeUsdc,
    cumulativeWindowSeconds: config.cumulativeWindowSeconds,
    pollIntervalMs: config.pollIntervalMs,
    addressPollIntervalMs: config.addressPollIntervalMs,
    addressAggregationWindowMs: config.addressAggregationWindowMs,
    sportsCatalogRefreshMs: config.sportsCatalogRefreshMs,
    worldCupEventSlugs: config.worldCupEventSlugs,
    worldCupEventPrefixes: config.worldCupEventPrefixes,
    holderEventScopePaths: config.holderEventScopePaths,
    holderSportWindows: config.holderSportWindows,
    holderMarketTypes: config.holderMarketTypes
  });

}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
