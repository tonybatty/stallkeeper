import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/fraunces/latin-700.css';
import './styles.css';
import './open-counter.css';
import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import { reloadOnStaleChunk, routes } from './router.js';

const router = createRouter({ history: createWebHistory(), routes });
reloadOnStaleChunk(router);
createApp(App).use(router).mount('#app');
