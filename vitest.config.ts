import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { projects: ['apps/*/vitest.config.ts', 'tools/capture/vitest.config.ts'] } });
