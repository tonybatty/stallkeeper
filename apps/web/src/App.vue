<script setup lang="ts">
import { computed, watch } from 'vue';
import { useRoute } from 'vue-router';
import { appTitleHome } from './app-title.js';

const route = useRoute();
const compactTitlebar = computed(() => Boolean(route.meta.compactTitlebar));
const owner = computed(() => route.path.startsWith('/owner'));
const home = computed(() => owner.value ? '/owner' : appTitleHome.value);
// Every owner page but the login carries the same tabs. Print tags and an item's form sit under Items; settings and the closing report under Stall.
const tabs = [
  { to: '/owner', label: 'Stall' },
  { to: '/owner/items', label: 'Items', also: ['/owner/tags'] },
  { to: '/owner/feed', label: 'Feed' },
  { to: '/owner/ledger', label: 'Ledger' },
] as const;
const showTabs = computed(() => owner.value && !route.path.startsWith('/owner/login'));
const activeTab = computed(() => tabs.slice(1).find(tab => [tab.to, ...('also' in tab ? tab.also : [])].some(path => route.path.startsWith(path)))?.to ?? '/owner');
watch(() => route.path, () => { appTitleHome.value = '/'; }, { flush: 'sync', immediate: true });
</script>

<template>
  <header class="app-titlebar" :class="{ compact: compactTitlebar }">
    <div class="app-titlebar-inner">
      <RouterLink class="app-wordmark wordmark" :to="home">
        <svg class="app-mark" viewBox="3 5 34 35.5" aria-hidden="true" focusable="false">
          <path d="M3 13 9 5h22l6 8v2c0 6-8 6-8 0 0 6-9 6-9 0 0 6-9 6-9 0 0 6-8 6-8 0z" fill="currentColor" />
          <path d="M7 23v9h16l7 5v-5h3v-9" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linejoin="round" />
        </svg>Stallkeeper
      </RouterLink>
    </div>
    <nav v-if="showTabs" class="owner-tabs" aria-label="Owner">
      <RouterLink v-for="tab in tabs" :key="tab.to" :to="tab.to" :aria-current="activeTab === tab.to ? 'page' : undefined">{{ tab.label }}</RouterLink>
    </nav>
  </header>
  <RouterView />
</template>
