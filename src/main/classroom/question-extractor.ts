/**
 * 课堂题目提取 + 受控测试交互执行。
 *
 * 权限分层（开发文档 §8.2）在此落地：
 * - 感知层：从隔离测试页按白名单选择器读出结构化题目。
 * - 规划层：模型/代码只产生 TestActionPlan，无执行权。
 * - 执行层：本模块在**隔离测试页**上执行白名单 DOM 操作。
 * - 确认层：任何改变页面数据的动作都要 requiresConfirmation。
 *
 * 明确不提供：任意 JS 执行、跨站 fetch、Shell、文件系统、无限点击。
 */

import type { ClassroomQuestion, PlatformId, TestActionPlan, QuestionOption } from '@shared/types'
import { normalizeQuestion, validatePlanAgainstQuestion, mapAnswerToOptions } from '@shared/question'
import type { RawQuestionDom } from '@shared/question'

/** 注入脚本：优先匹配测试台契约，其次穿透提取超星学习通等在线课堂题型。 */
const EXTRACT_SCRIPT = `(() => {
  // 1. 测试台契约节点（测试台 fixture 优先）
  const nodes = Array.from(document.querySelectorAll('[data-ch-question]'));
  if (nodes.length > 0) {
    const questions = nodes.map((node) => {
      const id = node.getAttribute('data-ch-question') || '';
      const control = node.getAttribute('data-ch-control') || 'none';
      const textEl = node.querySelector('[data-ch-text]');
      const optionEls = Array.from(node.querySelectorAll('[data-ch-option]'));
      return {
        id,
        control,
        text: textEl ? textEl.textContent : null,
        options: optionEls.map((el) => ({
          key: el.getAttribute('data-ch-option') || '',
          label: el.textContent || ''
        })),
        multipleAllowed: control === 'checkbox'
      };
    });
    return { questions };
  }

  // 2. 超星学习通及主流在线教育作业/课堂练习 DOM 结构
  let qNodes = Array.from(document.querySelectorAll(
    '.TiMu, div[class*="TiMu"], .questionLi, .question-item, .subject-item, [class*="question_item"], [class*="subject_item"]'
  ));
  if (qNodes.length === 0) {
    qNodes = Array.from(document.querySelectorAll('.Zy_TItle, .clearfix[class*="title"]'));
  }

  const questions = [];
  const seenIds = new Set();

  for (let idx = 0; idx < qNodes.length; idx++) {
    const node = qNodes[idx];
    // 仅当包含嵌套子题容器时跳过外层大题
    if (node.querySelector('.TiMu, div[class*="TiMu"], .questionLi, .question-item')) continue;

    const rawId = node.getAttribute('id') || node.getAttribute('data-id') || 'q-' + (idx + 1);
    if (seenIds.has(rawId)) continue;
    seenIds.add(rawId);

    const titleEl = node.querySelector('.Zy_TItle, .clearfix, .title, .stem, h3, [class*="title"], [class*="stem"]') || node;
    let stemText = '';
    if (titleEl) {
      const clone = titleEl.cloneNode(true);
      const toRemove = clone.querySelectorAll('ul, ol, .Zy_ulTop, .stem_answer, [class*="answer"], [class*="option"], [class*="btn"]');
      toRemove.forEach((el) => el.remove());
      stemText = (clone.textContent || '').trim();
    } else {
      stemText = (node.textContent || '').slice(0, 200).trim();
    }

    const hasCheckbox = node.querySelectorAll('input[type="checkbox"]').length > 0;
    const hasRadio = node.querySelectorAll('input[type="radio"]').length > 0;
    const hasTextarea = node.querySelectorAll('textarea').length > 0;
    const hasInputText = node.querySelectorAll('input[type="text"]').length > 0;

    let control = 'none';
    let multipleAllowed = false;
    if (hasCheckbox || /【?多选(题)?】?/.test(stemText)) {
      control = 'checkbox';
      multipleAllowed = true;
    } else if (/【?判断(题)?】?/.test(stemText) || (/(正确|错误|对|错)/.test(stemText) && !hasCheckbox && !hasTextarea)) {
      control = 'boolean';
    } else if (hasRadio || /【?单选(题)?】?/.test(stemText)) {
      control = 'radio';
    } else if (hasInputText || /【?填空(题)?】?/.test(stemText)) {
      control = 'text';
    } else if (hasTextarea || /【?(简答|问答|论述|主观)(题)?】?/.test(stemText)) {
      control = 'text';
    } else if (node.querySelectorAll('ul li, ol li').length > 0) {
      control = 'radio';
    }

    const optNodes = Array.from(node.querySelectorAll(
      'ul.Zy_ulTop li, ul.stem_answer li, .Zy_ulTop li, [class*="answer"] li, [class*="option"] li, ul li'
    ));

    const options = [];
    if (optNodes.length > 0) {
      optNodes.forEach((optEl, oIdx) => {
        const text = (optEl.textContent || '').trim();
        const m = text.match(/^([A-G]|[0-9]|对|错|正确|错误)[\\.、\\s\\:：](.+)$/);
        let key = '';
        let label = '';
        if (m) {
          key = m[1];
          label = m[2].trim();
        } else {
          key = String.fromCharCode(65 + oIdx);
          label = text;
        }
        if (label) {
          options.push({ key, label });
        }
      });
    }

    if (control === 'boolean' && options.length === 0) {
      options.push({ key: 'A', label: '正确（对）' });
      options.push({ key: 'B', label: '错误（错）' });
    }

    if (stemText.length > 0) {
      questions.push({
        id: rawId,
        control,
        text: stemText,
        options,
        multipleAllowed
      });
    }
  }

  return { questions };
})()`

export async function extractQuestions(
  wc: Electron.WebContents,
  platformId: PlatformId = 'testbed'
): Promise<{ questions: ClassroomQuestion[]; error: string | null }> {
  if (wc.isDestroyed()) return { questions: [], error: 'NOT_FOUND: 页面已销毁' }
  try {
    const frames: Electron.WebFrameMain[] = []
    const collectFrames = (frame: Electron.WebFrameMain) => {
      frames.push(frame)
      for (const child of frame.frames) collectFrames(child)
    }
    collectFrames(wc.mainFrame)

    const allRaw: RawQuestionDom[] = []
    const seen = new Set<string>()

    for (const frame of frames) {
      try {
        const raw = (await frame.executeJavaScript(EXTRACT_SCRIPT, true)) as {
          questions?: RawQuestionDom[]
        }
        for (const q of raw?.questions ?? []) {
          if (!seen.has(q.id)) {
            seen.add(q.id)
            allRaw.push(q)
          }
        }
      } catch {
        /* 个别受限 frame 忽略 */
      }
    }

    const detectedAt = new Date().toISOString()
    const url = wc.getURL() || null
    const questions = allRaw.map((q) =>
      normalizeQuestion(q, platformId, url, detectedAt)
    )
    return { questions, error: null }
  } catch (e) {
    return {
      questions: [],
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

export interface TestActionResult {
  ok: boolean
  matchedSelectorCount: number
  previewText: string
  executed: boolean
  error: string | null
}

/** 只生成预览，不改页面。用于用户确认。 */
export async function previewTestAction(
  wc: Electron.WebContents,
  plan: TestActionPlan,
  question: ClassroomQuestion
): Promise<TestActionResult> {
  const check = validatePlanAgainstQuestion(plan, question)
  if (!check.valid) {
    return {
      ok: false,
      matchedSelectorCount: 0,
      previewText: '',
      executed: false,
      error: check.reason
    }
  }
  if (wc.isDestroyed()) {
    return { ok: false, matchedSelectorCount: 0, previewText: '', executed: false, error: 'NOT_FOUND' }
  }

  const script = `(() => {
    const qid = ${JSON.stringify(plan.targetQuestionId)};
    const node = document.querySelector('[data-ch-question="' + CSS.escape(qid) + '"]');
    if (!node) return { found: false };
    const options = Array.from(node.querySelectorAll('[data-ch-option]'));
    const textEl = node.querySelector('[data-ch-text]');
    return {
      found: true,
      optionCount: options.length,
      text: textEl ? textEl.textContent : null
    };
  })()`

  try {
    const res = (await wc.executeJavaScript(script, true)) as {
      found?: boolean
      optionCount?: number
      text?: string | null
    }
    if (!res?.found) {
      return {
        ok: false,
        matchedSelectorCount: 0,
        previewText: '',
        executed: false,
        error: 'NOT_FOUND: 测试页未找到该题目节点'
      }
    }
    return {
      ok: true,
      matchedSelectorCount: res.optionCount ?? 0,
      previewText: res.text ?? '(无题干文本)',
      executed: false,
      error: null
    }
  } catch (e) {
    return {
      ok: false,
      matchedSelectorCount: 0,
      previewText: '',
      executed: false,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

/**
 * 执行测试填充。**必须已获得用户确认**（confirmed=true 才执行）。
 * 只点击 data-ch-option 控件与填写 data-ch-textarea，不触发任何提交按钮。
 */
export async function executeTestAction(
  wc: Electron.WebContents,
  plan: TestActionPlan,
  question: ClassroomQuestion,
  confirmed: boolean
): Promise<TestActionResult> {
  if (!confirmed) {
    return {
      ok: false,
      matchedSelectorCount: 0,
      previewText: '',
      executed: false,
      error: '需要用户确认后才能修改页面数据'
    }
  }
  if (wc.isDestroyed()) {
    return { ok: false, matchedSelectorCount: 0, previewText: '', executed: false, error: 'NOT_FOUND' }
  }

  const check = validatePlanAgainstQuestion(plan, question)
  if (!check.valid) {
    return { ok: false, matchedSelectorCount: 0, previewText: '', executed: false, error: check.reason }
  }

  // 硬上限：操作数不得超过 maxOps
  const opCount = plan.optionKeys.length + (plan.textValue ? 1 : 0)
  if (opCount > plan.maxOps || opCount > 8) {
    return {
      ok: false,
      matchedSelectorCount: 0,
      previewText: '',
      executed: false,
      error: `操作数 ${opCount} 超过上限 ${Math.min(plan.maxOps, 8)}`
    }
  }

  const script = `(() => {
    const qid = ${JSON.stringify(plan.targetQuestionId)};
    const keys = ${JSON.stringify(plan.optionKeys)};
    const textValue = ${JSON.stringify(plan.textValue)};
    const node = document.querySelector('[data-ch-question="' + CSS.escape(qid) + '"]');
    if (!node) return { ok:false, reason:'question-not-found', count:0 };

    let count = 0;
    const optionEls = Array.from(node.querySelectorAll('[data-ch-option]'));
    for (const key of keys) {
      const el = optionEls.find((e) => e.getAttribute('data-ch-option') === key);
      if (!el) continue;
      const input = el.querySelector('input');
      if (input) {
        if (!input.checked) { input.checked = true; }
        input.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
      count++;
    }
    if (typeof textValue === 'string') {
      const ta = node.querySelector('[data-ch-textarea]');
      if (ta) {
        ta.value = textValue;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        count++;
      }
    }
    // 回读 DOM 确认，而不是假设成功
    const readBack = Array.from(node.querySelectorAll('input:checked')).map((i) => {
      const wrap = i.closest('[data-ch-option]');
      return wrap ? wrap.getAttribute('data-ch-option') : null;
    }).filter(Boolean);
    const ta2 = node.querySelector('[data-ch-textarea]');
    return { ok: true, count, readBack, textReadBack: ta2 ? ta2.value : null };
  })()`

  try {
    const res = (await wc.executeJavaScript(script, true)) as {
      ok?: boolean
      reason?: string
      count?: number
      readBack?: string[]
      textReadBack?: string | null
    }
    if (!res?.ok) {
      return {
        ok: false,
        matchedSelectorCount: 0,
        previewText: '',
        executed: false,
        error: res?.reason ?? '执行失败'
      }
    }
    // 用 DOM 回读值作为最终事实
    const readBack = res.readBack ?? []
    const expected = [...plan.optionKeys].sort()
    const actual = [...readBack].sort()
    const optionsMatch = JSON.stringify(expected) === JSON.stringify(actual)
    const textMatch = plan.textValue === null || res.textReadBack === plan.textValue

    if (!optionsMatch || !textMatch) {
      return {
        ok: false,
        matchedSelectorCount: res.count ?? 0,
        previewText: `回读选项 [${actual.join(',')}]，期望 [${expected.join(',')}]`,
        executed: true,
        error: 'DOM 回读与预期不一致，已如实报告'
      }
    }

    return {
      ok: true,
      matchedSelectorCount: res.count ?? 0,
      previewText: `已设置选项 [${actual.join(',')}]${plan.textValue ? ' + 文本' : ''}`,
      executed: true,
      error: null
    }
  } catch (e) {
    return {
      ok: false,
      matchedSelectorCount: 0,
      previewText: '',
      executed: false,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

/** 把模型建议答案映射到本题选项，供 UI 展示映射结果与不确定性。 */
export function suggestMapping(
  question: ClassroomQuestion,
  suggested: readonly string[]
): { mapping: Record<string, string>; unmatched: string[]; allKeys: string[] } {
  const { mapping, unmatched } = mapAnswerToOptions(question, suggested)
  return {
    mapping,
    unmatched,
    allKeys: Object.values(mapping)
  }
}

export type { QuestionOption }
