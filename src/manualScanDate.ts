import { readConfig } from "./config.js";
import { createHolderCostAlert, type HolderCostAlert } from "./holder.js";
import { refreshHolderSchedule, type Alert } from "./monitor.js";
import { ConsoleNotifier, DingTalkNotifier, type Notifier } from "./notifier.js";
import { PolymarketClient } from "./polymarket.js";

interface QualifyingAlert {
  alert: HolderCostAlert;
  summary: Record<string, unknown>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const targetLocalDate = args.date ?? localDateKey(new Date());
  const sendToDingTalk = args.send ?? false;
  const delayMs = args.delayMs ?? 3_500;

  const config = readConfig();
  const client = new PolymarketClient();
  const notifier = createNotifier(config.dingTalkWebhookUrl, config.dingTalkSecret, sendToDingTalk);
  const schedule = await refreshHolderSchedule(client, config.holderEventScopePaths);
  const matches = schedule.filter((match) => localDateKey(new Date(match.gameStartTime)) === targetLocalDate);
  const qualifying: QualifyingAlert[] = [];
  const skipped: Record<string, unknown>[] = [];
  const positionCache = new Map<string, Awaited<ReturnType<PolymarketClient["fetchHolderPositions"]>>>();
  let marketsChecked = 0;
  let holderCandidates = 0;

  for (const match of matches) {
    for (const market of match.markets) {
      marketsChecked += 1;
      let holders: Awaited<ReturnType<PolymarketClient["fetchTopHolders"]>> = [];
      try {
        holders = await client.fetchTopHolders(market.conditionId, config.holderRankLimit);
      } catch (error) {
        skipped.push({ eventSlug: match.slug, marketSlug: market.slug, reason: `holders failed: ${describeError(error)}` });
        continue;
      }

      for (const holder of holders) {
        holderCandidates += 1;
        const cacheKey = `${holder.wallet.toLowerCase()}|${market.conditionId}`;
        let positions = positionCache.get(cacheKey);
        if (!positions) {
          try {
            positions = await client.fetchHolderPositions(holder.wallet, market.conditionId);
            positionCache.set(cacheKey, positions);
          } catch (error) {
            skipped.push({
              eventSlug: match.slug,
              marketSlug: market.slug,
              wallet: holder.wallet,
              token: holder.tokenId,
              reason: `positions failed: ${describeError(error)}`
            });
            continue;
          }
        }

        const position = positions.find((item) => item.tokenId === holder.tokenId);
        if (!position) {
          skipped.push({
            eventSlug: match.slug,
            marketSlug: market.slug,
            wallet: holder.wallet,
            token: holder.tokenId,
            reason: "missing position cost data"
          });
          continue;
        }

        const holderAlert = createHolderCostAlert({
          market: {
            ...market,
            eventTitle: `【手动扫描 北京时间${targetLocalDate}】${market.eventTitle}`,
            question: `【手动扫描 符合>=${config.thresholdUsdc} USDC】${market.question}`
          },
          holder,
          position
        });
        if (!holderAlert) {
          skipped.push({
            eventSlug: match.slug,
            marketSlug: market.slug,
            wallet: holder.wallet,
            token: holder.tokenId,
            reason: "invalid cost data"
          });
          continue;
        }

        if (holderAlert.costUsdc >= config.thresholdUsdc) {
          qualifying.push({
            alert: holderAlert,
            summary: {
              eventSlug: holderAlert.eventSlug,
              eventTitle: market.eventTitle,
              kickoffUtc: holderAlert.gameStartTime,
              kickoffBeijing: formatBeijing(new Date(holderAlert.gameStartTime)),
              marketType: holderAlert.marketType,
              marketSlug: holderAlert.marketSlug,
              marketTitle: market.question,
              outcome: holderAlert.outcome,
              wallet: holderAlert.wallet,
              holderName: holderAlert.holderName || holderAlert.holderPseudonym || null,
              shares: holderAlert.shares,
              avgPrice: holderAlert.avgPrice,
              costUsdc: holderAlert.costUsdc,
              token: holderAlert.outcomeTokenId
            }
          });
        }
      }
    }
  }

  qualifying.sort((left, right) => right.alert.costUsdc - left.alert.costUsdc);

  let dingtalkSent = 0;
  if (sendToDingTalk) {
    for (const item of qualifying) {
      await notifier.send(createManualAlert(item.alert, targetLocalDate));
      dingtalkSent += 1;
      await sleep(delayMs);
    }
  }

  console.log(
    JSON.stringify(
      {
        targetLocalDate,
        thresholdUsdc: config.thresholdUsdc,
        stateWritten: false,
        sendToDingTalk,
        dingtalkSent,
        totalScheduleMatches: schedule.length,
        matchedLocalDateCount: matches.length,
        matches: matches.map((match) => ({
          slug: match.slug,
          title: match.title,
          kickoffUtc: match.gameStartTime,
          kickoffBeijing: formatBeijing(new Date(match.gameStartTime)),
          markets: match.markets.length
        })),
        marketsChecked,
        holderCandidates,
        qualifyingCount: qualifying.length,
        qualifying: qualifying.map((item) => item.summary),
        skippedCount: skipped.length,
        skippedSample: skipped.slice(0, 20)
      },
      null,
      2
    )
  );
}

function createNotifier(webhookUrl: string | undefined, secret: string | undefined, sendToDingTalk: boolean): Notifier {
  if (sendToDingTalk && webhookUrl) {
    return new DingTalkNotifier({ webhookUrl, secret });
  }

  if (sendToDingTalk && !webhookUrl) {
    throw new Error("DINGTALK_WEBHOOK_URL is required when --send is used.");
  }

  return new ConsoleNotifier();
}

function createManualAlert(holderAlert: HolderCostAlert, targetLocalDate: string): Alert {
  return {
    key: `manual-scan-${targetLocalDate}|${holderAlert.key}|${Date.now()}`,
    kind: "holder",
    cashValue: holderAlert.costUsdc,
    marketUrl: holderAlert.marketUrl,
    holder: holderAlert
  };
}

function parseArgs(args: string[]): { date?: string; send?: boolean; delayMs?: number } {
  const parsed: { date?: string; send?: boolean; delayMs?: number } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--date") {
      parsed.date = args[index + 1];
      index += 1;
    } else if (arg === "--send") {
      parsed.send = true;
    } else if (arg === "--delay-ms") {
      parsed.delayMs = Number(args[index + 1]);
      index += 1;
    }
  }

  if (parsed.date && !/^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) {
    throw new Error(`Invalid --date value: ${parsed.date}`);
  }
  if (parsed.delayMs !== undefined && (!Number.isFinite(parsed.delayMs) || parsed.delayMs < 0)) {
    throw new Error(`Invalid --delay-ms value: ${parsed.delayMs}`);
  }
  return parsed;
}

function localDateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function formatBeijing(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23"
  }).format(date);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
