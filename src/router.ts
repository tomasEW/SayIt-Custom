import { createRouter, createWebHashHistory } from "vue-router";
import DashboardView from "./views/DashboardView.vue";
import HistoryView from "./views/HistoryView.vue";
import DictionaryView from "./views/DictionaryView.vue";
import CustomSettingsView from "./views/CustomSettingsView.vue";
import FeatureGuideView from "./views/FeatureGuideView.vue";

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", redirect: "/dashboard" },
    { path: "/dashboard", component: DashboardView },
    { path: "/history", component: HistoryView },
    { path: "/dictionary", component: DictionaryView },
    { path: "/settings", component: CustomSettingsView },
    { path: "/guide", component: FeatureGuideView },
  ],
});

export default router;
