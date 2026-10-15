/**
 * 课堂题目提取与受控测试动作规划。
 *
 * 权限分层（开发文档 §8.2）：
 * - 模型只能返回**意图**（TestActionPlan），不持有执行权。
 * - 本模块只做白名单映射，不接受任意 JS / 选择器表达式 / 跨站请求。
 * - 写页面的动作一律 requiresConfirmation。
 */

import type { ClassroomQuestion, QuestionOption, QuestionType, TestActionPlan } from './types'

/** 单次测试动作允许的最大操作数硬上限。 */
export const MAX_TEST_ACTIONS = 8

/** 允许被测试动作触及的题型白名单。 */
export const ALLOWED_TEST_QUESTION_TYPES: readonly QuestionType[] = [
  'single',
  'multiple',
  'judgement',
  'text'
]

export function isTestableType(type: QuestionType): boolean {
  return ALLOWED_TEST_QUESTION_TYPES.includes(type)
}

/**
 * 从受控 DOM 描述中提取题目。
 * 只接受结构化输入（由注入脚本从白名单选择器读出），不解析任意 HTML 字符串。
 */
export interface RawQuestionDom {
  id: string
  /** 题型线索：radio / checkbox / 单个 boolean 控件 / textarea */
  control: 'radio' | 'checkbox' | 'boolean' | 'text' | 'none'
  text: string | null
  options: readonly { key: string; label: string }[]
  multipleAllowed?: boolean
}

export function questionTypeFromControl(control: RawQuestionDom['control']): QuestionType {
  switch (control) {
    case 'radio':
      return 'single'
    case 'checkbox':
      return 'multiple'
    case 'boolean':
      return 'judgement'
    case 'text':
      return 'text'
    default:
      return 'unknown'
  }
}

export function normalizeQuestion(
  raw: RawQuestionDom,
  platformId: ClassroomQuestion['platformId'],
  sourceUrl: string | null,
  detectedAt: string
): ClassroomQuestion {
  const options: QuestionOption[] = raw.options
    .map((o) => ({ key: String(o.key).trim(), label: String(o.label ?? '').trim() }))
    .filter((o) => o.key.length > 0)

  return {
    id: raw.id,
    platformId,
    sourceUrl,
    questionType: questionTypeFromControl(raw.control),
    extractedText: raw.text && raw.text.trim().length > 0 ? raw.text.trim() : null,
    options,
    endsAt: null, // 平台未提供可靠结束时间时保持 null
    detectedAt,
    source: 'dom'
  }
}

/**
 * 把模型给出的「建议答案」映射到实际选项 key。
 *
 * 关键：映射失败必须返回空结果并说明原因，
 * 不能退化成「大概是第一个」或「按顺序取前 N 个」。
 */
export function mapAnswerToOptions(
  question: ClassroomQuestion,
  suggested: readonly string[]
): { mapping: Record<string, string>; unmatched: string[] } {
  const mapping: Record<string, string> = {}
  const unmatched: string[] = []

  // 归一化答案书写变体：'(B)'、'B.'、'b)、'B '、'B、' 等都应归到 'b'
  const norm = (s: string): string => {
    let v = s.trim().toLowerCase()
    // 去掉包裹的括号/方括号
    v = v.replace(/^[[(（[{【]\s*/, '').replace(/\s*[\])）\]}】]$/, '')
    // 去掉尾部的点号/顿号/分号等标点
    v = v.replace(/[.。,，、;；:：]+$/, '')
    // 去掉包围式引号
    v = v.replace(/^["'“‘]+/, '').replace(/["'”’]+$/, '')
    return v.trim()
  }

  for (const raw of suggested) {
    const target = norm(raw)
    if (!target) continue

    // 1) 直接命中选项 key
    const byKey = question.options.find((o) => norm(o.key) === target)
    if (byKey) {
      mapping[raw] = byKey.key
      continue
    }
    // 2) 命中选项文本（完全相等）
    const byLabel = question.options.find((o) => norm(o.label) === target)
    if (byLabel) {
      mapping[raw] = byLabel.key
      continue
    }
    // 3) 命中选项文本（包含关系），仅在唯一命中时接受。
    //    注意：若模型给的文本本身就是某个选项的子串（如「卷积」之于
    //    「卷积」/「卷积神经网络」），必须判为歧义并拒绝，不能偏向第一个。
    const partial = question.options.filter((o) => {
      const l = norm(o.label)
      return l.length > 0 && (l.includes(target) || target.includes(l))
    })
    // 存在完全相等项时它就是唯一确定答案，无需再看部分匹配
    const exact = question.options.filter((o) => norm(o.label) === target)
    if (exact.length === 1 && exact[0]) {
      mapping[raw] = exact[0].key
      continue
    }
    if (partial.length === 1 && partial[0]) {
      mapping[raw] = partial[0].key
      continue
    }
    unmatched.push(raw)
  }

  return { mapping, unmatched }
}

/**
 * 校验模型返回的选项映射是否符合题型约束。
 * 单选/判断返回多个 key 视为非法；不静默截断。
 */
export function validatePlanAgainstQuestion(
  plan: TestActionPlan,
  question: ClassroomQuestion
): { valid: boolean; reason: string | null } {
  if (!isTestableType(question.questionType)) {
    return { valid: false, reason: `题型 ${question.questionType} 不在测试白名单内` }
  }
  if (plan.maxOps > MAX_TEST_ACTIONS) {
    return { valid: false, reason: `maxOps ${plan.maxOps} 超过硬上限 ${MAX_TEST_ACTIONS}` }
  }
  const keys = plan.optionKeys
  const available = new Set(question.options.map((o) => o.key))
  const missing = keys.filter((k) => !available.has(k))
  if (missing.length > 0) {
    return { valid: false, reason: `选项 ${missing.join(',')} 不存在于该题目` }
  }
  if ((question.questionType === 'single' || question.questionType === 'judgement') && keys.length > 1) {
    return { valid: false, reason: `${question.questionType} 题只能选择一个选项，收到 ${keys.length} 个` }
  }
  if (question.questionType === 'text' && (plan.textValue === null || plan.textValue.length === 0)) {
    return { valid: false, reason: '文本题缺少 textValue' }
  }
  if (question.questionType !== 'text' && keys.length === 0) {
    return { valid: false, reason: `${question.questionType} 题缺少 optionKeys` }
  }
  return { valid: true, reason: null }
}

/** 构造测试动作计划。所有字段由本地代码填充，模型只提供 optionKeys/textValue。 */
export function buildTestPlan(input: {
  question: ClassroomQuestion
  optionKeys: readonly string[]
  textValue: string | null
  kind?: TestActionPlan['kind']
}): TestActionPlan {
  return {
    kind: input.kind ?? 'preview_fill',
    targetQuestionId: input.question.id,
    optionKeys: [...input.optionKeys],
    textValue: input.textValue,
    maxOps: Math.min(
      MAX_TEST_ACTIONS,
      Math.max(1, input.optionKeys.length + (input.textValue ? 1 : 0))
    )
  }
}
