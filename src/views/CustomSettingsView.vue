<script setup lang="ts">
import SettingsView from "./SettingsView.vue";
import ModeToggleHotkeySetting from "../components/ModeToggleHotkeySetting.vue";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
</script>

<template>
  <div>
    <div class="px-6 pt-6">
      <Card>
        <CardHeader class="border-b border-border">
          <CardTitle class="text-base">SayIt Custom 快捷鍵</CardTitle>
        </CardHeader>
        <CardContent class="pt-4">
          <ModeToggleHotkeySetting />
        </CardContent>
      </Card>
    </div>
    <SettingsView />
  </div>
</template>
