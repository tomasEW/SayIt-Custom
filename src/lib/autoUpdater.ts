import { invoke } from "@tauri-apps/api/core";

export interface UpdateCheckResult {
  status: "up-to-date" | "update-available" | "error";
  version?: string;
  error?: string;
}

/**
 * SayIt Custom 不追蹤官方 SayIt updater。
 *
 * Fork 版若繼續使用官方 release endpoint，可能把自訂版本覆蓋回上游版本。
 * 因此 v0.1 將自動更新明確停用；之後若需要，可再接自己的 release channel。
 */
export async function checkForAppUpdate(): Promise<UpdateCheckResult> {
  console.log("[autoUpdater] Disabled in SayIt Custom");
  return { status: "up-to-date" };
}

export async function downloadUpdate(): Promise<void> {
  throw new Error("Auto-update is disabled in SayIt Custom");
}

export async function installAndRelaunch(): Promise<void> {
  throw new Error("Auto-update is disabled in SayIt Custom");
}

/**
 * 保留既有 API 形狀，避免 UI 呼叫端在 v0.1 需要大改；實際不會下載官方更新。
 */
export async function downloadInstallAndRelaunch(): Promise<void> {
  throw new Error("Auto-update is disabled in SayIt Custom");
}

/**
 * 目前未使用；保留 invoke import 的相容入口，待後續若建立自有 updater channel 時使用。
 */
export async function restartCustomApp(): Promise<void> {
  await invoke("request_app_restart");
}
