import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  ClipboardList,
  Sparkles,
  RefreshCw,
  Radio,
  Timer,
  Info
} from 'lucide-react'
import type { ClassroomQuestion } from '@shared/types'
import { Card, CapChip, Empty, Notice } from '../components/ui'

export interface QuizSceneProps {
  onAskAi: (question: ClassroomQuestion) => void
  onGoExtract: () => void
}

/**
 * 章节作业 / 课堂练习场景。
 *
 * 只展示真实提取到的题目；未提取到时给出明确空态与操作指引。
 * 每题提供「问 AI」入口，答案与解析在 AI 页给出，不在此自动勾选。
 */
export function QuizScene({ onAskAi, onGoExtract }: QuizSceneProps): ReactNode {
  const [questions, setQuestions] = useState<ClassroomQuestion[]>([])
  const [msg, setMsg] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const extract = useCallback(async () => {
    setLoading(true)
    setMsg(null)
    try {
      const qs = await window.coursehub.question.extract('testbed')
      setQuestions(qs.ok ? qs.data.questions : [])
      if (qs.ok && qs.data.questions.length === 0) {
        setMsg('未提取到题目。请先切到「平台浏览 → 测试台」打开授权测试页。')
      } else if (!qs.ok) {
        setMsg(`提取失败：${qs.error.code} ${qs.error.message}`)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void extract()
  }, [extract])

  return (
    <div style={{ maxWidth: 880, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card
        title="课堂练习检测"
        action={
          <button type="button" className="btn" onClick={() => void extract()} disabled={loading} data-testid="quiz-refresh">
            <RefreshCw size={13} className={loading ? 'spin' : undefined} />
            重新提取
          </button>
        }
      >
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <CapChip state="unverified" reason="真实平台随堂题检测未在真实课堂验证" />
          <span className="chip chip-neutral">
            <Radio size={11} /> 事件推送优先
          </span>
          <span className="chip chip-neutral">
            <Timer size={11} /> 剩余时长未知则明确显示未知
          </span>
        </div>

        {msg && (
          <div style={{ marginBottom: 12 }}>
            <Notice tone="warn">{msg}</Notice>
          </div>
        )}

        {questions.length === 0 ? (
          <Empty
            icon={<ClipboardList size={22} />}
            text="尚未提取到题目。切到「平台浏览 → 测试台」打开授权测试页后，此处会列出真实提取到的题干与选项。"
          />
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {questions.map((q, i) => (
              <li
                key={q.id}
                style={{
                  padding: 16,
                  borderRadius: 'var(--r-block)',
                  background: 'var(--ch-subtle)',
                  border: '1px solid var(--ch-border)'
                }}
                data-question={q.id}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                  <span className="chip chip-neutral">第 {i + 1} 题</span>
                  <span className="chip chip-tint">{q.questionType}</span>
                  {q.endsAt ? (
                    <span className="chip chip-emerald">截止 {new Date(q.endsAt).toLocaleTimeString()}</span>
                  ) : (
                    <span className="chip">剩余时间未知</span>
                  )}
                </div>

                <p style={{ fontSize: 12.5, margin: '0 0 10px', lineHeight: 1.7 }}>
                  {q.extractedText ?? '（页面未提供可提取的题干文本）'}
                </p>

                {q.options.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                    {q.options.map((o) => (
                      <span key={o.key} className="chip">
                        {o.key}. {o.label.trim()}
                      </span>
                    ))}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ fontSize: 11 }}
                    onClick={() => onAskAi(q)}
                  >
                    <Sparkles size={13} />
                    问 AI
                  </button>
                  <button type="button" className="btn" style={{ fontSize: 11 }} onClick={onGoExtract}>
                    去测试页做受控交互
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="使用边界">
        <Notice tone="warn">
          <Info size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: -1 }} />
          模型给出答案<strong>不等于</strong>页面已填写或已提交。
          <br />
          真实独立计分作业与考试<strong>不接入</strong>自动提交链路；
          受控表单交互只在授权测试页生效，且每次都会修改页面前需你确认。
        </Notice>
      </Card>
    </div>
  )
}
