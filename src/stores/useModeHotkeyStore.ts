import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { emit } from "@tauri-apps/api/event";
import { load } from "@tauri-apps/plugin-store";
import type { TriggerKey } from "../types/settings";
import { isComboTriggerKey, isCustomTriggerKey } from "../types/settings";
import {
  getComboTriggerKeyDisplayName,
  getKeyDisplayName,
} from "../lib/keycodeMap";
import { HOTKEY_MODE_TOGGLE_CONFIG } from "../composables/useTauriEvents";

const STORE_NAME = "settings.json";
const MODE_HOTKEY_KEY = "modeToggleHotkeyTriggerKey";
const MODE_HOTKEY_DOM_CODE_KEY = "modeToggleHotkeyDomCode";

export const useModeHotkeyStore = defineStore("mode-hotkey", () => {
  const triggerKey = ref<TriggerKey | null>(null);
  const domCode = ref("");
  const isLoaded = ref(false);
  const isAssigned = computed(() => triggerKey.value !== null);

  async function syncToRust(key: TriggerKey | null) {
    await emit(HOTKEY_MODE_TOGGLE_CONFIG, key);
  }

  async function loadSettings() {
    if (isLoaded.value) return;
    const store = await load(STORE_NAME);
    triggerKey.value = (await store.get<TriggerKey>(MODE_HOTKEY_KEY)) ?? null;
    domCode.value = (await store.get<string>(MODE_HOTKEY_DOM_CODE_KEY)) ?? "";
    isLoaded.value = true;
    await syncToRust(triggerKey.value);
  }

  async function saveTriggerKey(key: TriggerKey, keyDomCode = "") {
    const store = await load(STORE_NAME);
    await store.set(MODE_HOTKEY_KEY, key);
    await store.set(MODE_HOTKEY_DOM_CODE_KEY, keyDomCode);
    await store.save();
    triggerKey.value = key;
    domCode.value = keyDomCode;
    await syncToRust(key);
  }

  async function clearTriggerKey() {
    const store = await load(STORE_NAME);
    await store.delete(MODE_HOTKEY_KEY);
    await store.delete(MODE_HOTKEY_DOM_CODE_KEY);
    await store.save();
    triggerKey.value = null;
    domCode.value = "";
    await syncToRust(null);
  }

  function getDisplayName(): string {
    const key = triggerKey.value;
    if (!key) return "";
    if (typeof key === "string") {
      const labels: Record<string, string> = {
        fn: "Fn",
        option: "Option (⌥)",
        rightOption: "Right Option (⌥)",
        command: "Command (⌘)",
        rightAlt: "Right Alt",
        leftAlt: "Left Alt",
        control: "Control (⌃)",
        rightControl: "Right Control",
        shift: "Shift (⇧)",
      };
      return labels[key] ?? key;
    }
    if (isComboTriggerKey(key)) return getComboTriggerKeyDisplayName(key);
    if (isCustomTriggerKey(key)) {
      return domCode.value
        ? getKeyDisplayName(domCode.value)
        : `Key ${key.custom.keycode}`;
    }
    return "";
  }

  return {
    triggerKey,
    domCode,
    isLoaded,
    isAssigned,
    loadSettings,
    saveTriggerKey,
    clearTriggerKey,
    getDisplayName,
  };
});
