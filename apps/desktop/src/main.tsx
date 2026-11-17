import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { applyInitialAppTheme } from '@deepread/design-system'
import '@deepread/design-system/tokens.css'
import './styles/global.css'
import { App } from './App'

// 首次 paint 前把明暗落到 <html>:深色系统下等 React 挂载再切会白闪一帧。
// Tauri 的 CSP 只有 `script-src 'self'`,所以这一步在入口模块里,不写成内联脚本。
applyInitialAppTheme()

const container = document.getElementById('root')
if (!container) {
  throw new Error('Root container #root is missing in index.html')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
