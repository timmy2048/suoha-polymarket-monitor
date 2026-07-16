import { describe, expect, it } from "vitest";
import { formatMonitorWindow, formatUtcAndBeijing } from "../src/time.js";

describe("time formatting", () => {
  it("formats UTC kickoff times with explicit Beijing time", () => {
    expect(formatUtcAndBeijing("2026-06-25T20:00:00Z")).toBe(
      "2026-06-25T20:00:00.000Z UTC / 2026-06-26 04:00:00 Asia/Shanghai"
    );
  });

  it("computes monitoring windows from absolute UTC timestamps", () => {
    expect(formatMonitorWindow("2026-06-25T20:00:00Z", 30, 105)).toEqual({
      start: "2026-06-25T19:30:00.000Z UTC / 2026-06-26 03:30:00 Asia/Shanghai",
      kickoff: "2026-06-25T20:00:00.000Z UTC / 2026-06-26 04:00:00 Asia/Shanghai",
      end: "2026-06-25T21:45:00.000Z UTC / 2026-06-26 05:45:00 Asia/Shanghai"
    });
  });
});
