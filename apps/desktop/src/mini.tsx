import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@deepread/design-system/tokens.css'
import './styles/global.css'
import { MiniBarWindow } from './features/reader/MiniBarWindow'

/**
 * 桌面悬浮条的入口(第二个 webview)。与 main.tsx 平行,只挂这一块界面 ——
 * 书架、阅读器、后端探测都不该在这里发生。
 */
const container = document.getElementById('root')
if (!container) {
  throw new Error('Root container #root is missing in mini.html')
}

createRoot(container).render(
  <StrictMode>
    <MiniBarWindow />
  </StrictMode>,
)
