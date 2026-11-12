import { h } from 'vue';
import type { Router, RouteRecordRaw } from 'vue-router';
import DemoView from './views/DemoView.vue';
import LoginView from './views/LoginView.vue';
import ClosingView from './views/ClosingView.vue';
import FeedView from './views/FeedView.vue';
import OwnerView from './views/OwnerView.vue';
import SettingsView from './views/SettingsView.vue';

import BuyerView from './views/BuyerView.vue';
import BrowseView from './views/BrowseView.vue';
import ItemFormView from './views/ItemFormView.vue';
import ItemsView from './views/ItemsView.vue';
import TagsView from './views/TagsView.vue';
import NotFoundView from './views/NotFoundView.vue';

const loadFailed = 'load-failed';
export const routes: RouteRecordRaw[] = [
  { path: '/demo', component: DemoView },
  { path: '/', component: BrowseView },
  { path: '/i/:code', component: BuyerView },
  { path: '/owner/items', component: ItemsView },
  { path: '/owner/items/new', component: ItemFormView },
  { path: '/owner/items/:id', component: ItemFormView },
  { path: '/owner/tags', component: TagsView },
  { path: '/owner/login', component: LoginView },
  { path: '/owner/closing', component: ClosingView },
  { path: '/owner/feed', component: FeedView },
  // Lazy, because AG Studio is about 2 MB compressed and only an owner on this page should fetch it.
  { path: '/owner/ledger', component: () => import('./views/LedgerView.vue'), meta: { compactTitlebar: true } },
  { path: '/owner/settings', component: SettingsView },
  { path: '/owner', component: OwnerView },
  { path: '/:pathMatch(.*)*', component: NotFoundView },
  // Reached by name only, because the record above takes every unknown address first. It keeps the address that failed, so the owner tabs show and a refresh tries that page again.
  { path: '/:pathMatch(.*)*', name: loadFailed, component: { render: () => h('main', { class: 'page' }, h('p', { role: 'alert' }, 'This page could not load. Refresh to try again.')) } },
];

// A tab opened before a deploy asks for the old build's Ledger chunk, which no longer exists, so the import fails and the click does nothing.
// One full load of the target fetches the new build. The stored path stops a reload loop when the chunk fails for any other reason.
const reloadKey = 'stallkeeper-chunk-reload';
const staleChunk = /dynamically imported module|module script failed|Unable to preload CSS/i;
export function reloadOnStaleChunk(router: Router, navigate = (path: string) => window.location.assign(path)) {
  router.onError((error, to) => {
    try {
      if (error instanceof Error && staleChunk.test(error.message) && sessionStorage.getItem(reloadKey) !== to.fullPath) { sessionStorage.setItem(reloadKey, to.fullPath); navigate(to.fullPath); return; }
    } catch { /* Without storage there is no loop guard, so the page is not reloaded. */ }
    console.error('Page could not load', error);
    // A page whose code fails on the first navigation leaves nothing below the title bar, so the failure gets a page of its own.
    // A failed click keeps the page the owner was on, which still works.
    if (!router.currentRoute.value.matched.length) void router.replace({ name: loadFailed, params: { pathMatch: to.path.slice(1).split('/') }, query: to.query, hash: to.hash }).catch(() => undefined);
  });
  // Showing the failure is not a recovery, so it leaves the guard set.
  router.afterEach((to, _from, failure) => { if (!failure && to.name !== loadFailed) try { sessionStorage.removeItem(reloadKey); } catch { /* Nothing stored. */ } });
}
