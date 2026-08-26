import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockCheck = vi.fn();
const mockInvoke = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: mockCheck,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

describe("autoUpdater.ts — SayIt Custom isolation", () => {
  beforeEach(() => {
    vi.resetModules();
    mockCheck.mockReset();
    mockInvoke.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("[P0] checkForAppUpdate 永遠回報 up-to-date 且不呼叫官方 updater", async () => {
    const { checkForAppUpdate } = await import("../../src/lib/autoUpdater");
    const result = await checkForAppUpdate();

    expect(result).toEqual({ status: "up-to-date" });
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("[P0] downloadUpdate 明確拒絕官方下載", async () => {
    const { downloadUpdate } = await import("../../src/lib/autoUpdater");
    await expect(downloadUpdate()).rejects.toThrow(
      "Auto-update is disabled in SayIt Custom",
    );
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("[P0] installAndRelaunch 與一鍵更新都明確拒絕官方安裝", async () => {
    const { installAndRelaunch, downloadInstallAndRelaunch } = await import(
      "../../src/lib/autoUpdater",
    );

    await expect(installAndRelaunch()).rejects.toThrow(
      "Auto-update is disabled in SayIt Custom",
    );
    await expect(downloadInstallAndRelaunch()).rejects.toThrow(
      "Auto-update is disabled in SayIt Custom",
    );
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("[P1] restartCustomApp 保留自有重啟入口", async () => {
    const { restartCustomApp } = await import("../../src/lib/autoUpdater");
    await restartCustomApp();
    expect(mockInvoke).toHaveBeenCalledWith("request_app_restart");
  });
});
