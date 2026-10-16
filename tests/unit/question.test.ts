/**
 * 题目提取归一化、选项映射与受控动作校验测试。
 *
 * 重点：映射失败必须如实报告，不得退化为猜测。
 */

import { describe, it, expect } from 'vitest'
import {
  normalizeQuestion,
  mapAnswerToOptions,
  validatePlanAgainstQuestion,
  buildTestPlan,
  isTestableType,
  questionTypeFromControl,
  MAX_TEST_ACTIONS
} from '@shared/question'
import type { ClassroomQuestion } from '@shared/types'

const NOW = '2026-10-15T00:00:00.000Z'

function single(): ClassroomQuestion {
  return normalizeQuestion(
    {
      id: 'q1',
      control: 'radio',
      text: '缓解梯度消失最常用的激活函数是？',
      options: [
        { key: 'A', label: 'Sigmoid' },
        { key: 'B', label: 'ReLU' },
        { key: 'C', label: 'Tanh' },
        { key: 'D', label: 'Step' }
      ]
    },
    'testbed',
    'file:///fixture',
    NOW
  )
}

describe('题型识别', () => {
  it('由显式控件类型决定，不靠选项数量猜', () => {
    expect(questionTypeFromControl('radio')).toBe('single')
    expect(questionTypeFromControl('checkbox')).toBe('multiple')
    expect(questionTypeFromControl('boolean')).toBe('judgement')
    expect(questionTypeFromControl('text')).toBe('text')
    expect(questionTypeFromControl('none')).toBe('unknown')
  })

  it('unknown 题型不可测试', () => {
    expect(isTestableType('unknown')).toBe(false)
    expect(isTestableType('single')).toBe(true)
    expect(isTestableType('multiple')).toBe(true)
    expect(isTestableType('judgement')).toBe(true)
    expect(isTestableType('text')).toBe(true)
  })
})

describe('normalizeQuestion', () => {
  it('提取题干与选项', () => {
    const q = single()
    expect(q.questionType).toBe('single')
    expect(q.extractedText).toBe('缓解梯度消失最常用的激活函数是？')
    expect(q.options).toHaveLength(4)
  })

  it('空题干为 null 而非空串', () => {
    const q = normalizeQuestion(
      { id: 'q', control: 'radio', text: '   ', options: [] },
      'testbed',
      null,
      NOW
    )
    expect(q.extractedText).toBeNull()
  })

  it('未提供可靠结束时间时 endsAt 为 null', () => {
    expect(single().endsAt).toBeNull()
  })

  it('丢弃空 key 的选项', () => {
    const q = normalizeQuestion(
      { id: 'q', control: 'radio', text: 't', options: [{ key: '', label: 'x' }, { key: 'A', label: 'y' }] },
      'testbed',
      null,
      NOW
    )
    expect(q.options.map((o) => o.key)).toEqual(['A'])
  })
})

describe('mapAnswerToOptions', () => {
  it('直接按 key 命中', () => {
    const r = mapAnswerToOptions(single(), ['B'])
    expect(r.mapping).toEqual({ B: 'B' })
    expect(r.unmatched).toEqual([])
  })

  it('支持 (A) / A. / a 等书写变体', () => {
    for (const form of ['(B)', 'B.', 'b', ' B ']) {
      expect(mapAnswerToOptions(single(), [form]).mapping[form]).toBe('B')
    }
  })

  it('按选项文本命中', () => {
    const r = mapAnswerToOptions(single(), ['ReLU'])
    expect(Object.values(r.mapping)).toEqual(['B'])
  })

  it('无法匹配时如实报告，不猜测', () => {
    const r = mapAnswerToOptions(single(), ['Zzz'])
    expect(r.mapping).toEqual({})
    expect(r.unmatched).toEqual(['Zzz'])
  })

  it('部分匹配命中多个时不接受，避免误选', () => {
    // 「卷积」既非任一选项的完全文本，又同时是两个选项的子串 -> 歧义，必须拒绝
    const q = normalizeQuestion(
      {
        id: 'q',
        control: 'radio',
        text: 't',
        options: [
          { key: 'A', label: '卷积神经网络' },
          { key: 'B', label: '卷积核' }
        ]
      },
      'testbed',
      null,
      NOW
    )
    const r = mapAnswerToOptions(q, ['卷积'])
    expect(r.mapping).toEqual({})
    expect(r.unmatched).toEqual(['卷积'])
  })

  it('完全相等优先于部分匹配，不产生歧义', () => {
    const q = normalizeQuestion(
      {
        id: 'q',
        control: 'radio',
        text: 't',
        options: [
          { key: 'A', label: '卷积' },
          { key: 'B', label: '卷积神经网络' }
        ]
      },
      'testbed',
      null,
      NOW
    )
    // 「卷积」与 A 完全相等，应确定映射到 A
    const r = mapAnswerToOptions(q, ['卷积'])
    expect(Object.values(r.mapping)).toEqual(['A'])
    expect(r.unmatched).toEqual([])
  })

  it('空建议返回空结果', () => {
    expect(mapAnswerToOptions(single(), [])).toEqual({ mapping: {}, unmatched: [] })
  })
})

describe('validatePlanAgainstQuestion 白名单约束', () => {
  it('合法单选计划通过', () => {
    const plan = buildTestPlan({ question: single(), optionKeys: ['B'], textValue: null })
    expect(validatePlanAgainstQuestion(plan, single())).toEqual({ valid: true, reason: null })
  })

  it('单选多选被拒（不静默截断）', () => {
    const plan = buildTestPlan({ question: single(), optionKeys: ['A', 'B'], textValue: null })
    const r = validatePlanAgainstQuestion(plan, single())
    expect(r.valid).toBe(false)
    expect(r.reason).toContain('只能选择一个')
  })

  it('不存在的选项被拒', () => {
    const plan = buildTestPlan({ question: single(), optionKeys: ['Z'], textValue: null })
    const r = validatePlanAgainstQuestion(plan, single())
    expect(r.valid).toBe(false)
    expect(r.reason).toContain('不存在')
  })

  it('文本题缺少 textValue 被拒', () => {
    const q = normalizeQuestion(
      { id: 'qt', control: 'text', text: '简述', options: [] },
      'testbed',
      null,
      NOW
    )
    const plan = buildTestPlan({ question: q, optionKeys: [], textValue: null })
    expect(validatePlanAgainstQuestion(plan, q).valid).toBe(false)
  })

  it('非文本题缺 optionKeys 被拒', () => {
    const plan = buildTestPlan({ question: single(), optionKeys: [], textValue: null })
    expect(validatePlanAgainstQuestion(plan, single()).valid).toBe(false)
  })

  it('unknown 题型不在白名单被拒', () => {
    const q = normalizeQuestion(
      { id: 'qu', control: 'none', text: '?', options: [] },
      'testbed',
      null,
      NOW
    )
    const plan = buildTestPlan({ question: q, optionKeys: [], textValue: null })
    expect(validatePlanAgainstQuestion(plan, q).valid).toBe(false)
  })

  it('maxOps 超硬上限被拒', () => {
    const plan = { ...buildTestPlan({ question: single(), optionKeys: ['B'], textValue: null }), maxOps: 999 }
    expect(validatePlanAgainstQuestion(plan, single()).valid).toBe(false)
  })
})

describe('buildTestPlan 操作数上限', () => {
  it('maxOps 不超过硬上限', () => {
    const plan = buildTestPlan({
      question: single(),
      optionKeys: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'],
      textValue: 'x'
    })
    expect(plan.maxOps).toBeLessThanOrEqual(MAX_TEST_ACTIONS)
  })

  it('默认 kind 为 preview_fill（先预览不直接改页面）', () => {
    const plan = buildTestPlan({ question: single(), optionKeys: ['B'], textValue: null })
    expect(plan.kind).toBe('preview_fill')
  })
})

describe('超星学习通题型识别与归一化', () => {
  it('单选、多选、判断、简答题型精准归一化', () => {
    const singleQ = normalizeQuestion(
      {
        id: 'cx-q1',
        control: 'radio',
        text: '下列关于反向传播算法的描述中，最准确的是？',
        options: [
          { key: 'A', label: '利用链式法则计算梯度' },
          { key: 'B', label: '无需前向传播' }
        ]
      },
      'chaoxing',
      'https://mooc1.chaoxing.com/exam/test',
      NOW
    )
    expect(singleQ.questionType).toBe('single')
    expect(singleQ.platformId).toBe('chaoxing')
    expect(singleQ.options).toHaveLength(2)

    const multiQ = normalizeQuestion(
      {
        id: 'cx-q2',
        control: 'checkbox',
        text: '以下哪些技术可有效缓解过拟合？',
        multipleAllowed: true,
        options: [
          { key: 'A', label: 'Dropout 随机失活' },
          { key: 'B', label: 'L2 正则化' },
          { key: 'C', label: '数据增强' }
        ]
      },
      'chaoxing',
      'https://mooc1.chaoxing.com/exam/test',
      NOW
    )
    expect(multiQ.questionType).toBe('multiple')
    expect(multiQ.options).toHaveLength(3)

    const judgeQ = normalizeQuestion(
      {
        id: 'cx-q3',
        control: 'boolean',
        text: '判断：卷积神经网络具有局部连接特性。',
        options: [
          { key: 'A', label: '正确' },
          { key: 'B', label: '错误' }
        ]
      },
      'chaoxing',
      'https://mooc1.chaoxing.com/exam/test',
      NOW
    )
    expect(judgeQ.questionType).toBe('judgement')

    const essayQ = normalizeQuestion(
      {
        id: 'cx-q4',
        control: 'text',
        text: '简述 Transformer 架构中自注意力机制的核心公式。',
        options: []
      },
      'chaoxing',
      'https://mooc1.chaoxing.com/exam/test',
      NOW
    )
    expect(essayQ.questionType).toBe('text')
    expect(essayQ.options).toEqual([])
  })
})
