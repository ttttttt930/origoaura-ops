import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * L6 表现层构建配置。
 *
 * 关键点：
 *  · base = './'   —— 产物必须能在 GitHub Pages 的仓库子路径下工作（C6）；
 *  · alias @origo/core —— 直接指向内核源码，保证前端与管道消费的是**同一份**口径；
 *  · 不打 Node polyfill —— 浏览器端只允许 WebCrypto（见 eslint 的 web 规则）。
 */
export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@origo/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
});
