/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // 相对 base:GitHub Pages 项目站(https://xlongdev.github.io/Deepread/)与
  // Tauri 的内嵌服务都能吃;绝对路径会把 Pages 部署的资源指到域名根上。
  base: './',
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // dev-only path to the local mock AI server (scripts/mock-ai-server.mjs)
      '/mock-ai': {
        target: 'http://localhost:8787',
        rewrite: (path) => path.replace(/^\/mock-ai/, ''),
      },
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      input: {
        // 第二个入口:桌面悬浮迷你条(独立 webview,只画胶囊)。
        // 与主窗口同仓同构,按入口拆包,主窗口不会为它多付一分钱。
        index: 'index.html',
        mini: 'mini.html',
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
})
