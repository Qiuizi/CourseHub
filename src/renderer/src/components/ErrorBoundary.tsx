import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[CourseHub Renderer Crash]', error, errorInfo)
    try {
      if (window.coursehub?.diagnostics?.recordError) {
        void window.coursehub.diagnostics.recordError({
          module: 'renderer',
          type: 'react_error_boundary',
          code: 'REACT_RENDER_CRASH',
          summary: error.message || 'React 渲染异常',
          stack: error.stack || errorInfo.componentStack || undefined
        })
      }
    } catch {
      // 容错防止次生异常
    }
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          style={{
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--ch-page, #f0f4f9)',
            color: 'var(--ch-text, #1f1f1f)',
            padding: 24,
            textAlign: 'center',
            boxSizing: 'border-box'
          }}
        >
          <div
            style={{
              maxWidth: 480,
              background: 'var(--ch-surface, #ffffff)',
              borderRadius: 'var(--r-card, 24px)',
              padding: 32,
              border: '1px solid var(--ch-border, #e2e8f0)',
              boxShadow: 'var(--sh-card, 0 1px 3px 0 rgb(15 23 42 / 0.07))',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 16
            }}
          >
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: '50%',
                background: '#fee2e2',
                color: '#b91c1c',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <AlertTriangle size={24} />
            </div>
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 6px' }}>
                页面渲染遇到了小问题
              </h2>
              <p style={{ fontSize: 12, color: 'var(--ch-text-2, #444746)', margin: 0, lineHeight: 1.6 }}>
                现场脱敏诊断已被自动记录。已保存你的学习记录与课程缓存，无需担心数据丢失。
              </p>
            </div>

            {this.state.error && (
              <pre
                style={{
                  background: 'var(--ch-subtle, #f8fafc)',
                  padding: '10px 14px',
                  borderRadius: 'var(--r-block, 16px)',
                  fontSize: 11,
                  fontFamily: 'ui-monospace, monospace',
                  color: '#b91c1c',
                  maxWidth: '100%',
                  overflowX: 'auto',
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  textAlign: 'left'
                }}
              >
                {this.state.error.message}
              </pre>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => window.location.reload()}
              >
                <RotateCw size={14} />
                重新加载界面
              </button>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
