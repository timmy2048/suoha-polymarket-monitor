import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildDingTalkWebhookUrl,
  DingTalkNotifier,
  formatDingTalkMarkdown,
  formatStartupMarkdown
} from "../src/notifier.js";
import type { Alert } from "../src/monitor.js";

const largeAlert: Alert = {
  key: "0xhash|fifwc-bra-hai-2026-06-19-bra|BUY|1100000|0.99",
  kind: "single",
  channel: "large-trade",
  cashValue: 1_089_000,
  marketUrl: "https://polymarket.com/event/fifwc-bra-hai-2026-06-19",
  trade: {
    proxyWallet: "0xabc",
    side: "BUY",
    size: 1_100_000,
    price: 0.99,
    timestamp: 1_781_917_805,
    title: "Will Brazil win on 2026-06-19?",
    slug: "fifwc-bra-hai-2026-06-19-bra",
    eventSlug: "fifwc-bra-hai-2026-06-19",
    outcome: "Yes",
    transactionHash: "0xhash"
  }
};

const addressAlert: Alert = {
  key: "address|wallet|market|asset|BUY|initial",
  kind: "address-initial",
  channel: "address-trade",
  cashValue: 120,
  marketUrl: "https://polymarket.com/event/tennis-match",
  address: {
    wallet: "0xwallet",
    walletLabel: "tracked-wallet",
    side: "BUY",
    stage: "initial",
    eventSlug: "tennis-match",
    marketSlug: "tennis-match-winner",
    marketTitle: "Tennis match winner",
    outcome: "Yes",
    totalSize: 200,
    totalCashValue: 120,
    tradeCount: 1,
    firstTimestamp: 1_781_917_805,
    lastTimestamp: 1_781_917_805,
    transactionHashes: ["0xaddress-tx"],
    marketUrl: "https://polymarket.com/event/tennis-match",
    walletUrl: "https://polymarket.com/profile/0xwallet"
  }
};

describe("DingTalk notifier", () => {
  it("formats complete large trade markdown details", () => {
    const message = formatDingTalkMarkdown(largeAlert);

    expect(message.title).toBe("跟单 Polymarket 大额成交提醒");
    expect(message.text).toContain("跟单");
    expect(message.text).toContain("Will Brazil win on 2026-06-19?");
    expect(message.text).toContain("BUY");
    expect(message.text).toContain("1,089,000.00 USDC");
    expect(message.text).toContain("0xabc");
    expect(message.text).toContain("0xhash");
    expect(message.text).toContain("[打开市场]");
  });

  it("makes address BUY and initial stage explicit", () => {
    const message = formatDingTalkMarkdown(addressAlert, "sport");

    expect(message.title).toBe("[BUY][首仓] sport Polymarket Sports 地址成交");
    expect(message.text).toContain("**BUY | 首仓**");
    expect(message.text).toContain("tracked-wallet (0xwallet)");
  });

  it("adds DingTalk signature parameters when a secret is configured", () => {
    const timestamp = 1_700_000_000_000;
    const secret = "SEC123";
    const expectedSign = encodeURIComponent(
      crypto.createHmac("sha256", secret).update(`${timestamp}\n${secret}`).digest("base64")
    );

    const url = buildDingTalkWebhookUrl("https://oapi.dingtalk.com/robot/send?access_token=abc", secret, timestamp);

    expect(url).toBe(
      `https://oapi.dingtalk.com/robot/send?access_token=abc&timestamp=${timestamp}&sign=${expectedSign}`
    );
  });

  it("posts markdown payload to DingTalk webhook", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "ok"
    });
    const notifier = new DingTalkNotifier({
      webhookUrl: "https://example.test/dingtalk",
      fetchImpl: fetchMock
    });

    await notifier.send(largeAlert);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/dingtalk",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: expect.stringContaining('"msgtype":"markdown"')
      })
    );
  });

  it("throws diagnostic errors when DingTalk rejects a message", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "bad request"
    });
    const notifier = new DingTalkNotifier({
      webhookUrl: "https://example.test/dingtalk",
      fetchImpl: fetchMock
    });

    await expect(notifier.send(largeAlert)).rejects.toThrow("DingTalk webhook failed with 400: bad request");
  });

  it("checks DingTalk business errors even when HTTP status is 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ errcode: 310000, errmsg: "keyword not found" })
    });
    const notifier = new DingTalkNotifier({
      webhookUrl: "https://example.test/dingtalk",
      fetchImpl: fetchMock
    });

    await expect(notifier.send(largeAlert)).rejects.toThrow("errcode 310000: keyword not found");
  });

  it("formats startup notification with monitor settings", () => {
    const message = formatStartupMarkdown({
      channel: "large-trade",
      thresholdUsdc: 500_000,
      minTradeUsdc: 50_000,
      cumulativeWindowSeconds: 300,
      pollIntervalMs: 30_000,
      worldCupEventSlugs: [],
      worldCupEventPrefixes: ["fifwc-"]
    });

    expect(message.text).toContain("跟单");
    expect(message.text).toContain("500,000.00 USDC");
    expect(message.text).toContain("大额轮询: 30 秒");
  });
});
