/**
 * 章节真实任务组件检查器（Task Inspector）。
 *
 * 核心目标（开发规范 §1、§6）：
 * 1. 严格区隔「课程章节节点」与「章节内部任务附件」。
 * 2. 进入实际学习通页面（或测试台）后，无侵入跨 Frame 检查页面内部真实加载的任务组件。
 * 3. 区分并识别：
 *    - HTML5 视频任务 (video)
 *    - 文档与课件任务 (doc)
 *    - 章节测验与作业 (quiz)
 *    - 阅读或其他学习资源 (read)
 *    - 混合类型章节 (mixed - 同一章节包含多种附件)
 *    - 未识别类型 (unknown)
 * 4. 字段全部具有真实来源（dom_element / iframe_probe），绝不编造，置信度标记为 high。
 */

import type { ChapterAttachment, TaskDetectionMethod, TaskType } from '@shared/types'

export interface ChapterInspectionResult {
  chapterId: string
  taskType: TaskType
  detectionMethod: TaskDetectionMethod
  confidence: 'high' | 'medium' | 'low'
  attachments: ChapterAttachment[]
  inspectedAt: string
}

export function buildInspectionScript(chapterId: string): string {
  return `(() => {
  const chapterId = ${JSON.stringify(chapterId)};
  const attachments = [];

  const inspectDoc = (doc, frameUrl = '') => {
    if (!doc) return;

    // 1. 检查真实 HTML5 <video> 元素
    const videos = Array.from(doc.querySelectorAll('video'));
    for (let i = 0; i < videos.length; i++) {
      const v = videos[i];
      const src = v.currentSrc || v.src || '';
      const hasSrc = src && !src.startsWith('blob:null') && !src.startsWith('about:');
      const hasDuration = Number.isFinite(v.duration) && v.duration > 0;
      const rect = v.getBoundingClientRect ? v.getBoundingClientRect() : { width: 0, height: 0 };
      const isVisible = rect.width > 60 && rect.height > 40;

      // 只要具备媒体源、时长或基本可视尺寸，即确认为 HTML5 视频组件
      if (hasSrc || hasDuration || isVisible || v.readyState >= 1) {
        attachments.push({
          chapterId,
          taskId: v.id || v.getAttribute('data-task') || (chapterId + '-video-' + (i + 1)),
          taskType: 'video',
          title: v.getAttribute('title') || 'HTML5 视频任务组件',
          sourceUrl: src || frameUrl || null,
          source: 'dom_element',
          detectionMethod: 'dom_element',
          confidence: 'high'
        });
      }
    }

    // 2. 检查测验 / 作业 / 题目组件
    const questions = doc.querySelectorAll('[data-ch-question], .questionLi, .Cy_TItle, form[action*="work"], .TiMu');
    if (questions.length > 0) {
      attachments.push({
        chapterId,
        taskId: chapterId + '-quiz',
        taskType: 'quiz',
        title: '章节测验与作业组件 (' + questions.length + ' 题)',
        sourceUrl: frameUrl || null,
        source: 'dom_element',
        detectionMethod: 'dom_element',
        confidence: 'high'
      });
    }

    // 3. 检查文档 / 课件 / PDF / Office 阅读组件
    const docContainers = doc.querySelectorAll('.doc-viewer, .panDoc, .panPDF, #panDoc, .pdf-container, embed[type*="pdf"]');
    if (docContainers.length > 0) {
      attachments.push({
        chapterId,
        taskId: chapterId + '-doc',
        taskType: 'doc',
        title: '在线文档与课件组件',
        sourceUrl: frameUrl || null,
        source: 'dom_element',
        detectionMethod: 'dom_element',
        confidence: 'high'
      });
    }

    // 4. 检查阅读与文本学习组件
    const readContainers = doc.querySelectorAll('.read-content, .article-content, #articleContent, .ans-cc');
    if (readContainers.length > 0 && questions.length === 0 && videos.length === 0) {
      attachments.push({
        chapterId,
        taskId: chapterId + '-read',
        taskType: 'read',
        title: '在线阅读学习资源',
        sourceUrl: frameUrl || null,
        source: 'dom_element',
        detectionMethod: 'dom_element',
        confidence: 'high'
      });
    }
  };

  // 检查主文档
  try {
    inspectDoc(document, window.location.href);
  } catch (_) {}

  // 跨 Frame 检查同源 iframe
  try {
    const iframes = Array.from(document.querySelectorAll('iframe'));
    for (const f of iframes) {
      const src = f.src || f.getAttribute('src') || '';
      // 检查 iframe 自身特征
      if (src.includes('video') || src.includes('ananas/modules/video')) {
        attachments.push({
          chapterId,
          taskId: chapterId + '-iframe-video',
          taskType: 'video',
          title: '超星视频播放 Frame',
          sourceUrl: src,
          source: 'iframe_probe',
          detectionMethod: 'iframe_probe',
          confidence: 'high'
        });
      } else if (src.includes('work') || src.includes('quiz') || src.includes('test')) {
        attachments.push({
          chapterId,
          taskId: chapterId + '-iframe-quiz',
          taskType: 'quiz',
          title: '超星测验/作业 Frame',
          sourceUrl: src,
          source: 'iframe_probe',
          detectionMethod: 'iframe_probe',
          confidence: 'high'
        });
      } else if (src.includes('pdf') || src.includes('document') || src.includes('office') || src.includes('doc')) {
        attachments.push({
          chapterId,
          taskId: chapterId + '-iframe-doc',
          taskType: 'doc',
          title: '超星文档课件 Frame',
          sourceUrl: src,
          source: 'iframe_probe',
          detectionMethod: 'iframe_probe',
          confidence: 'high'
        });
      }

      try {
        const subDoc = f.contentDocument || f.contentWindow?.document;
        if (subDoc) inspectDoc(subDoc, src);
      } catch (_) {}
    }
  } catch (_) {}

  return attachments;
})()`
}

/**
 * 在 WebContents 及其 FrameSubtree 中深度执行页面组件检查。
 */
export async function inspectChapterInWebContents(
  wc: Electron.WebContents,
  chapterId: string
): Promise<ChapterInspectionResult> {
  const inspectedAt = new Date().toISOString()
  if (wc.isDestroyed()) {
    return {
      chapterId,
      taskType: 'unknown',
      detectionMethod: 'uninspected',
      confidence: 'low',
      attachments: [],
      inspectedAt
    }
  }

  const script = buildInspectionScript(chapterId)
  const allAttachments: ChapterAttachment[] = []
  const seenIds = new Set<string>()

  // 1. 在主 Frame 执行检查
  try {
    const mainList = (await wc.executeJavaScript(script, true)) as ChapterAttachment[]
    if (Array.isArray(mainList)) {
      for (const a of mainList) {
        if (!seenIds.has(a.taskId)) {
          seenIds.add(a.taskId)
          allAttachments.push(a)
        }
      }
    }
  } catch {
    // 忽略主 frame 执行单步错误
  }

  // 2. 深度穿透全部子 Frame 执行检查（兼容超星多层 ananas 架构）
  if (wc.mainFrame?.framesInSubtree) {
    for (const frame of wc.mainFrame.framesInSubtree) {
      if (frame === wc.mainFrame || frame.isDestroyed()) continue
      try {
        const subList = (await frame.executeJavaScript(script, true)) as ChapterAttachment[]
        if (Array.isArray(subList)) {
          for (const a of subList) {
            if (!seenIds.has(a.taskId)) {
              seenIds.add(a.taskId)
              allAttachments.push(a)
            }
          }
        }
      } catch {
        // 忽略处于跨域或导航中的单个 frame
      }
    }
  }

  // 3. 汇总判定整体 taskType
  const types = new Set(allAttachments.map((a) => a.taskType))
  let derivedType: TaskType = 'unknown'
  let detectionMethod: TaskDetectionMethod = 'uninspected'

  if (types.size === 0) {
    derivedType = 'unknown'
    detectionMethod = 'uninspected'
  } else if (types.size > 1) {
    derivedType = 'mixed'
    detectionMethod = allAttachments[0]!.detectionMethod
  } else if (types.has('video')) {
    derivedType = 'video'
    detectionMethod = 'dom_element'
  } else if (types.has('doc')) {
    derivedType = 'doc'
    detectionMethod = 'dom_element'
  } else if (types.has('quiz')) {
    derivedType = 'quiz'
    detectionMethod = 'dom_element'
  } else if (types.has('read')) {
    derivedType = 'read'
    detectionMethod = 'dom_element'
  } else {
    derivedType = 'other'
    detectionMethod = 'dom_element'
  }

  return {
    chapterId,
    taskType: derivedType,
    detectionMethod,
    confidence: allAttachments.length > 0 ? 'high' : 'low',
    attachments: allAttachments,
    inspectedAt
  }
}
