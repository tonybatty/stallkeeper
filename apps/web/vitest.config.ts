import vue from '@vitejs/plugin-vue';
import { defineProject } from 'vitest/config';
export default defineProject({ plugins: [vue()], test: { name: 'web', environment: 'happy-dom', css: { include: [/\.vue/] }, include: ['src/**/*.test.ts', 'vite.config.test.ts'] } });
