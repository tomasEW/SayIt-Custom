import { describe, expect, it } from "vitest";
import { collapseAsrRepetition } from "../../src/lib/asrCleanup";

describe("collapseAsrRepetition", () => {
  it("[P0] collapses a repeated Whisper phrase", () => {
    expect(collapseAsrRepetition("謝謝觀看謝謝觀看謝謝觀看謝謝觀看")).toBe("謝謝觀看");
  });

  it("[P0] preserves normal two-time emphasis", () => {
    expect(collapseAsrRepetition("這個非常非常重要")).toBe("這個非常非常重要");
  });

  it("[P0] collapses a three-time repeated lead-in only", () => {
    expect(collapseAsrRepetition("我覺得我覺得我覺得這個方案可行")).toBe("我覺得這個方案可行");
  });

  it("[P1] leaves non-adjacent repetition intact", () => {
    expect(collapseAsrRepetition("我覺得這個方案，我覺得可以試試")).toBe("我覺得這個方案，我覺得可以試試");
  });
});
