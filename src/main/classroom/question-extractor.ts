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

/**
 * 注入脚本：优先匹配测试台契约，其次穿透提取超星学习通等在线课堂题型。
 *
 * 扩展覆盖范围（v2）：
 * - 超星随堂测验：.TiMu / .questionLi / .quesItem / .questionRoot
 * - 超星在线作业：.testpaper_content .mark_item / .mark_item / .stem_wrap
 * - 通配类名：[class*="question_item"] / [class*="questionItem"] 等
 * - 题干提取：多 STEM_SELECTORS 策略，逐一尝试
 * - 选项提取：支持 A. / A、/ (A) / 无前缀自动分配
 * - 诊断信息：frameUrl / bodyClass / candidateCount（排障用，无敏感数据）
 */
const EXTRACT_SCRIPT = `(() => {
  const clean = (s) => (s ? String(s).replace(/[\\r\\n\\t]+/g, ' ').replace(/\\s+/g, ' ').trim() : '');

  // 1. 测试台契约节点（测试台 fixture 优先）
  const nodes = Array.from(document.querySelectorAll('[data-ch-question]'));
  if (nodes.length > 0) {
    const questions = nodes.map((node) => {
      const id = node.getAttribute('data-ch-question') || '';
      const control = node.getAttribute('data-ch-control') || 'none';
      const textEl = node.querySelector('[data-ch-text]');
      const optionEls = Array.from(node.querySelectorAll('[data-ch-option]'));
      const imgNodes = Array.from(node.querySelectorAll('img'));
      const images = imgNodes.map((img) => img.src || img.getAttribute('src')).filter(Boolean);
      const rect = node.getBoundingClientRect();
      const dimensions = {
        height: Math.round(rect.height),
        width: Math.round(rect.width),
        scrollHeight: Math.round(node.scrollHeight || rect.height),
        isOverflow: rect.height > (window.innerHeight || 800),
        top: Math.round(rect.top),
        left: Math.round(rect.left)
      };
      return {
        id,
        control,
        text: textEl ? clean(textEl.textContent) : null,
        options: optionEls.map((el) => ({
          key: el.getAttribute('data-ch-option') || '',
          label: clean(el.textContent)
        })),
        images,
        dimensions,
        multipleAllowed: control === 'checkbox'
      };
    });
    return { questions, _debug: { source: 'testbed', frameUrl: location.href, candidateCount: nodes.length } };
  }

  // 2. 超星学习通及主流在线教育作业/课堂练习 DOM 结构
  // 选择器按精确程度从高到低排列，避免误匹配容器
  const CANDIDATE_SELECTORS = [
    '.TiMu',
    'div[class*="TiMu"]',
    '.questionLi',
    '.question-item',
    '.subject-item',
    '.quesItem',
    '.questionRoot',
    '.testpaper_content .mark_item',
    '.mark_item',
    '.stem_wrap',
    '[class*="question_item"]',
    '[class*="subject_item"]',
    '[class*="quesItem"]',
    '[class*="questionWrap"]',
    '[class*="questionItem"]'
  ].join(', ');

  let qNodes = Array.from(document.querySelectorAll(CANDIDATE_SELECTORS));

  // 回退：宽泛选择器
  if (qNodes.length === 0) {
    qNodes = Array.from(document.querySelectorAll('.Zy_TItle, .clearfix[class*="title"]'));
  }

  // 诊断信息（供排障，不含用户答案或 Cookie）
  const _debug = {
    source: 'chaoxing',
    frameUrl: location.href,
    candidateCount: qNodes.length,
    bodyClass: document.body.className.slice(0, 120),
    firstH3: (document.querySelector('h3') || {}).textContent
      ? document.querySelector('h3').textContent.slice(0, 60) : null
  };

  const questions = [];
  const seenIds = new Set();

  for (let idx = 0; idx < qNodes.length; idx++) {
    const node = qNodes[idx];

    // 跳过外层容器（内部还有题目节点）
    const innerQ = node.querySelector(
      '.TiMu, div[class*="TiMu"], .questionLi, .question-item, .quesItem, .mark_item'
    );
    if (innerQ) continue;

    const rawId = (
      node.getAttribute('id') ||
      node.getAttribute('data-id') ||
      node.getAttribute('data-questionid') ||
      node.getAttribute('data-qid') ||
      ('q-' + (idx + 1))
    );
    if (seenIds.has(rawId)) continue;
    seenIds.add(rawId);

    // 题干提取：按优先级逐一尝试 STEM_SELECTORS
    const STEM_SELECTORS = [
      '.Zy_TItle', '.clearfix', '.stem', '.stem_wrap',
      '.questionTitle', '.question_title', '.questionStem', '.ques_stem',
      '.mark_item_stem', 'p.stem', '.title',
      'h3', '[class*="title"]', '[class*="stem"]', '[class*="question_text"]'
    ];
    let titleEl = null;
    for (var si = 0; si < STEM_SELECTORS.length; si++) {
      titleEl = node.querySelector(STEM_SELECTORS[si]);
      if (titleEl) break;
    }
    if (!titleEl) titleEl = node;

    let stemText = '';
    if (titleEl) {
      const clone = titleEl.cloneNode(true);
      const toRemove = clone.querySelectorAll(
        'ul, ol, .Zy_ulTop, .stem_answer, [class*="answer"], [class*="option"],' +
        ' [class*="btn"], input, label, .mark_item_opts'
      );
      toRemove.forEach(function(el) { el.parentNode && el.parentNode.removeChild(el); });
      stemText = clean(clone.textContent);
    }

    // 题型识别（多信号综合判断）
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

    // 选项提取：多选择器策略
    const OPT_SELECTORS = [
      'ul.Zy_ulTop li', 'ul.stem_answer li', '.Zy_ulTop li',
      '[class*="answer"] li', '[class*="option"] li',
      '.mark_item_opts li', '.questionOptions li',
      '.optionItem', '[class*="optionItem"]',
      'ul li', 'ol li'
    ].join(', ');

    const optNodes = Array.from(node.querySelectorAll(OPT_SELECTORS));

    const options = [];
    if (optNodes.length > 0) {
      optNodes.forEach(function(optEl, oIdx) {
        const text = clean(optEl.textContent);
        // 兼容多种 key 格式：A. / A、/ (A) / A B（空格分隔）
        const m = text.match(/^([A-G]|[0-9]|对|错|正确|错误)[\\.\\u3002\\uff0c\\uff0c\\u3001\\s\\uff1a\\uff09\\u0029\\uff08\\u0028\\u003a]+(.+)$/);
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
          options.push({ key: key, label: label });
        }
      });
    }

    if (control === 'boolean' && options.length === 0) {
      options.push({ key: 'A', label: '正确（对）' });
      options.push({ key: 'B', label: '错误（错）' });
    }

    const imgNodes = Array.from(node.querySelectorAll('img'));
    const images = imgNodes
      .map(function(img) { return img.src || img.getAttribute('src'); })
      .filter(function(src) { return Boolean(src) && !src.includes('space.gif') && !src.includes('icon'); });

    const rect = node.getBoundingClientRect();
    const scrollHeight = node.scrollHeight || Math.round(rect.height);
    const isOverflow = rect.height > (window.innerHeight || 800) || scrollHeight > (window.innerHeight || 800);
    const dimensions = {
      height: Math.round(rect.height),
      width: Math.round(rect.width),
      scrollHeight: Math.round(scrollHeight),
      isOverflow: isOverflow,
      top: Math.round(rect.top),
      left: Math.round(rect.left)
    };

    if (stemText.length > 0) {
      questions.push({
        id: rawId,
        control: control,
        text: stemText,
        options: options,
        images: images,
        dimensions: dimensions,
        multipleAllowed: multipleAllowed
      });
    }
  }

  return { questions: questions, _debug: _debug };
})()`

export interface ExtractDebugInfo {
  source: string
  frameUrl: string
  candidateCount: number
  bodyClass?: string
  firstH3?: string | null
}

export async function extractQuestions(
  wc: Electron.WebContents,
  platformId: PlatformId = 'testbed'
): Promise<{ questions: ClassroomQuestion[]; error: string | null; debugInfo: ExtractDebugInfo[] }> {
  if (wc.isDestroyed()) return { questions: [], error: 'NOT_FOUND: 页面已销毁', debugInfo: [] }
  try {
    const frames: Electron.WebFrameMain[] = []
    const collectFrames = (frame: Electron.WebFrameMain) => {
      frames.push(frame)
      for (const child of frame.frames) collectFrames(child)
    }
    collectFrames(wc.mainFrame)

    const allRaw: RawQuestionDom[] = []
    const seen = new Set<string>()
    const debugInfoList: ExtractDebugInfo[] = []

    for (const frame of frames) {
      try {
        const raw = (await frame.executeJavaScript(EXTRACT_SCRIPT, true)) as {
          questions?: RawQuestionDom[]
          _debug?: ExtractDebugInfo
        }
        if (raw?._debug) {
          debugInfoList.push(raw._debug)
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
    return { questions, error: null, debugInfo: debugInfoList }
  } catch (e) {
    return {
      questions: [],
      error: e instanceof Error ? e.message : String(e),
      debugInfo: []
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
