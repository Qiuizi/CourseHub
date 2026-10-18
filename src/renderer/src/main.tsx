import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles/index.css'

// 捕获渲染进程全局未处理异常，并记录到主进程脱敏日志
window.addEventListener('error', (event) => {
  try {
    if (window.coursehub?.diagnostics?.recordError) {
      void window.coursehub.diagnostics.recordError({
        module: 'renderer',
        type: 'window_onerror',
        code: 'UNHANDLED_WINDOW_ERROR',
        summary: event.message || '未捕获前端脚本异常',
        data: { filename: event.filename, lineno: event.lineno, colno: event.colno },
        stack: event.error?.stack
      })
    }
  } catch {}
})

window.addEventListener('unhandledrejection', (event) => {
  try {
    if (window.coursehub?.diagnostics?.recordError) {
      const reason = event.reason
      void window.coursehub.diagnostics.recordError({
        module: 'renderer',
        type: 'window_unhandled_rejection',
        code: 'UNHANDLED_PROMISE_REJECTION',
        summary: String(reason instanceof Error ? reason.message : reason),
        stack: reason instanceof Error ? reason.stack : undefined
      })
    }
  } catch {}
})

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
