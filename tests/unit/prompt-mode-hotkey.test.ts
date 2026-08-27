import { describe, expect, it } from "vitest";
import { getNextPromptModeForHotkey } from "../../src/lib/promptModeHotkey";

describe("getNextPromptModeForHotkey", () => {
  it("switches minimal to active", () => {
    expect(getNextPromptModeForHotkey("minimal")).toBe("active");
  });

  it("switches active to minimal", () => {
    expect(getNextPromptModeForHotkey("active")).toBe("minimal");
  });

  it("locks custom mode", () => {
    expect(getNextPromptModeForHotkey("custom")).toBeNull();
  });
});
