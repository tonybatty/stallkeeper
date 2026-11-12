import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';

const envDir = '../..';

export default defineConfig(({ mode }) => {
  const apiPort = loadEnv(mode, envDir, '').PORT || 3000;
  return { envDir, plugins: [vue()], server: { port: 5173, strictPort: true, proxy: { '/api': `http://localhost:${apiPort}` } } };
});
