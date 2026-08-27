<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useModeHotkeyStore } from "../stores/useModeHotkeyStore";
import {
  HOTKEY_RECORDING_CAPTURED,
  HOTKEY_RECORDING_REJECTED,
  listenToEvent,
} from "../composables/useTauriEvents";
import type {
  RecordingCapturedPayload,
  RecordingRejectedPayload,
} from "../types/events";
import type { ComboTriggerKey, TriggerKey } from "../types/settings";
import { getDomCodeByKeycode, getKeyDisplayNameByKeycode } from "../lib/keycodeMap";

const settingsStore = useSettingsStore();
const modeHotkeyStore = useModeHotkeyStore();
const isRecording = ref(false);
const feedback = ref("");
const isError = ref(false);
let timeoutId: ReturnType<typeof setTimeout> | undefined;
let unlisteners: UnlistenFn[] = [];

const displayName = computed(() => modeHotkeyStore.getDisplayName());

function sameTriggerKey(a: TriggerKey | null | undefined, b: TriggerKey): boolean {
  return a != null && JSON.stringify(a) === JSON.stringify(b);
}

function cleanupListeners() {
  for (const unlisten of unlisteners) unlisten();
  unlisteners = [];
}

function stopRecording() {
  if (!isRecording.value) return;
  isRecording.value = false;
  clearTimeout(timeoutId);
  cleanupListeners();
  void invoke("cancel_hotkey_recording").catch(() => {});
}

async function saveCapturedKey(payload: RecordingCapturedPayload) {
  stopRecording();
  const domCode = getDomCodeByKeycode(payload.keycode) ?? "";
  const key: TriggerKey =
    payload.modifiers.length > 0
      ? ({
          combo: {
            modifiers: payload.modifiers,
            keycode: payload.keycode,
          },
        } satisfies ComboTriggerKey)
      : { custom: { keycode: payload.keycode } };

  if (sameTriggerKey(settingsStore.hotkeyConfig?.triggerKey, key)) {
    isError.value = true;
    feedback.value = "模式切換快捷鍵不能和錄音快捷鍵相同。";
    return;
  }

  try {
    await modeHotkeyStore.saveTriggerKey(key, domCode);
    isError.value = false;
    feedback.value = `模式切換快捷鍵已設為 ${
      domCode ? settingsStore.getKeyDisplayName(domCode) : getKeyDisplayNameByKeycode(payload.keycode)
    }`;
  } catch (error) {
    isError.value = true;
    feedback.value = error instanceof Error ? error.message : String(error);
  }
}

function handleRejected(payload: RecordingRejectedPayload) {
  stopRecording();
  isError.value = true;
  feedback.value =
    payload.reason === "esc_reserved"
      ? "Esc 為保留按鍵，不能作為模式切換快捷鍵。"
      : "無法使用這個快捷鍵。";
}

async function startRecording() {
  stopRecording();
  feedback.value = "";
  isError.value = false;
  isRecording.value = true;

  try {
    const [captured, rejected] = await Promise.all([
      listenToEvent<RecordingCapturedPayload>(HOTKEY_RECORDING_CAPTURED, (event) => {
        void saveCapturedKey(event.payload);
      }),
      listenToEvent<RecordingRejectedPayload>(HOTKEY_RECORDING_REJECTED, (event) => {
        handleRejected(event.payload);
      }),
    ]);
    unlisteners = [captured, rejected];
    await invoke("start_hotkey_recording");
    timeoutId = setTimeout(() => {
      if (!isRecording.value) return;
      stopRecording();
      isError.value = true;
      feedback.value = "等待按鍵逾時，請再試一次。";
    }, 10_000);
  } catch (error) {
    stopRecording();
    isError.value = true;
    feedback.value = error instanceof Error ? error.message : String(error);
  }
}

async function clearHotkey() {
  stopRecording();
  try {
    await modeHotkeyStore.clearTriggerKey();
    isError.value = false;
    feedback.value = "模式切換快捷鍵已清除。";
  } catch (error) {
    isError.value = true;
    feedback.value = error instanceof Error ? error.message : String(error);
  }
}

onMounted(() => {
  void modeHotkeyStore.loadSettings().catch((error) => {
    isError.value = true;
    feedback.value = error instanceof Error ? error.message : String(error);
  });
});

onBeforeUnmount(() => {
  stopRecording();
  cleanupListeners();
  clearTimeout(timeoutId);
});
</script>

<template>
  <div class="space-y-2 border-t border-border pt-4">
    <div class="flex items-center justify-between gap-4">
      <div>
        <Label>模式切換快捷鍵</Label>
        <p class="text-xs text-muted-foreground mt-1">
          僅切換 Minimal ↔ Active；Custom 模式不會被快捷鍵切走。錄音快捷鍵只負責錄音。
        </p>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <span v-if="modeHotkeyStore.isAssigned" class="text-sm font-medium">
          {{ displayName }}
        </span>
        <span v-else class="text-sm text-muted-foreground">未指派</span>
        <Button
          size="sm"
          :variant="isRecording ? 'destructive' : 'outline'"
          :class="{ 'animate-pulse': isRecording }"
          @click="isRecording ? stopRecording() : startRecording()"
        >
          {{ isRecording ? "請按快捷鍵…" : "錄製" }}
        </Button>
        <Button
          v-if="modeHotkeyStore.isAssigned"
          size="sm"
          variant="ghost"
          @click="clearHotkey"
        >
          清除
        </Button>
      </div>
    </div>
    <p v-if="feedback" class="text-xs" :class="isError ? 'text-destructive' : 'text-muted-foreground'">
      {{ feedback }}
    </p>
  </div>
</template>
