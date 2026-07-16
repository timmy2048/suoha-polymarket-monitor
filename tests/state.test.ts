import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AlertStateStore } from "../src/state.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "suoha-state-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("AlertStateStore", () => {
  it("persists seen trade keys across store instances", async () => {
    const stateFile = path.join(tempDir, "state.json");
    const first = await AlertStateStore.load(stateFile);

    expect(first.has("trade-1")).toBe(false);
    await first.markSeen("trade-1");

    const second = await AlertStateStore.load(stateFile);
    expect(second.has("trade-1")).toBe(true);
  });

  it("appends alert history as ndjson", async () => {
    const stateFile = path.join(tempDir, "state.json");
    const historyFile = path.join(tempDir, "alerts.ndjson");
    const store = await AlertStateStore.load(stateFile);

    await store.appendAlert(historyFile, { key: "trade-1", title: "World Cup Winner" });
    await store.appendAlert(historyFile, { key: "trade-2", title: "Will Brazil win?" });

    const lines = (await readFile(historyFile, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ key: "trade-1" });
    expect(JSON.parse(lines[1])).toMatchObject({ key: "trade-2" });
  });

  it("persists holder alert cost state across store instances", async () => {
    const stateFile = path.join(tempDir, "state.json");
    const first = await AlertStateStore.load(stateFile);

    await first.markHolderAlert("event|market|token|0xabc", {
      wallet: "0xabc",
      marketSlug: "market",
      outcomeTokenId: "token",
      outcome: "Yes",
      lastAlertedCostUsdc: 500_000,
      shares: 1_000_000,
      avgPrice: 0.5,
      lastAlertedAt: "2026-06-25T00:00:00Z"
    });

    const second = await AlertStateStore.load(stateFile);
    expect(second.getHolderAlert("event|market|token|0xabc")).toMatchObject({
      lastAlertedCostUsdc: 500_000,
      shares: 1_000_000,
      avgPrice: 0.5
    });
  });

  it("persists address cursors, dedupe keys, and aggregation buckets", async () => {
    const stateFile = path.join(tempDir, "state.json");
    const first = await AlertStateStore.load(stateFile);
    await first.markAddressCursor("0xABC", 200);
    await first.markAddressTrade("trade-key", 200);
    await first.markAddressInitial("aggregate-key");
    await first.setAddressAggregate("aggregate-key", {
      wallet: "0xabc",
      marketSlug: "market",
      eventSlug: "event",
      side: "BUY",
      totalSize: 10,
      totalCashValue: 5,
      tradeCount: 1,
      firstTimestamp: 200,
      lastTimestamp: 200,
      transactionHashes: ["0xtx"],
      bucketStartedAt: 200
    });

    const second = await AlertStateStore.load(stateFile);
    expect(second.getAddressCursor("0xabc")).toBe(200);
    expect(second.hasAddressTrade("trade-key")).toBe(true);
    expect(second.hasAddressInitial("aggregate-key")).toBe(true);
    expect(second.getAddressAggregate("aggregate-key")).toMatchObject({ totalCashValue: 5 });
  });
});
