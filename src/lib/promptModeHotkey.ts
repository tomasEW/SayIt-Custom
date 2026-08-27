import type { PromptMode, PresetPromptMode } from "../types/settings";

/**
 * Resolve a dedicated mode-toggle hotkey press.
 *
 * Only Minimal <-> Active are hotkey-switchable. Custom is intentionally
 * locked: leaving Custom requires an explicit settings action so a recording
 * shortcut can never silently discard the user's custom refinement mode.
 */
export function getNextPromptModeForHotkey(
  currentMode: PromptMode,
): PresetPromptMode | null {
  if (currentMode === "custom") return null;
  return currentMode === "minimal" ? "active" : "minimal";
}
