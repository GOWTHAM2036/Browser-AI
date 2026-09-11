import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getActiveProvider } from '../ai';
import { BrowserSettings } from '../../types';
import { observationScript } from './observer';

export interface QuizQuestionData {
  questionText: string;
  options: { id: string; text: string; value?: string; testId?: string }[];
  imageUrl?: string;
  scoreText?: string;
  progressText?: string;
  isCompleted?: boolean;
  hasSubmit?: boolean;
  hasNext?: boolean;
}

export interface QuizSolverCallbacks {
  onStatusUpdate: (status: string, currentStep: number) => void;
  onTimelineUpdate: (item: {
    id: string;
    timestamp: string;
    actionType: string;
    target: string;
    result: string;
    status: 'pending' | 'success' | 'error' | 'info';
  }) => void;
  onLog: (log: string) => void;
  onFinish: (result: string, success: boolean) => void;
  isCancelled: () => boolean;
  isPaused: () => boolean;
}

let activeQuizRunId: string | null = null;

export function cancelActiveQuizRun(): void {
  activeQuizRunId = null;
}

/** DOM extraction script to identify questions, options, images, and progress across main document & iframes */
export const quizExtractScript = `
(function() {
  try {
    window.onbeforeunload = null;
    document.onbeforeunload = null;
    if (document.body) document.body.onbeforeunload = null;
    try {
      Object.defineProperty(window, 'onbeforeunload', {
        get: function() { return null; },
        set: function() {},
        configurable: true
      });
    } catch(e0) {}
    window.addEventListener('beforeunload', function(e) {
      e.stopImmediatePropagation();
      e.stopPropagation();
      delete e.returnValue;
      e.returnValue = undefined;
    }, true);
  } catch(e) {}

  function sendIpc(payload) {
    try {
      try {
        window.onbeforeunload = null;
        document.onbeforeunload = null;
      } catch(eUnload) {}

      var rawStr = String(payload);
      var CHUNK_SIZE = 600;
      var total = Math.ceil(rawStr.length / CHUNK_SIZE) || 1;
      var msgId = 'quiz_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now().toString(36);

      if (total === 1 && encodeURIComponent(rawStr).length < 1500) {
        location.href = 'https://tauri-ipc-bridge/data?payload=' + encodeURIComponent(rawStr);
        return;
      }

      for (var i = 0; i < total; i++) {
        (function(idx) {
          setTimeout(function() {
            var slice = rawStr.substring(idx * CHUNK_SIZE, (idx + 1) * CHUNK_SIZE);
            var chunkUrl = 'https://tauri-ipc-bridge/chunk?id=' + encodeURIComponent(msgId) +
                           '&index=' + idx +
                           '&total=' + total +
                           '&data=' + encodeURIComponent(slice);
            location.href = chunkUrl;
          }, idx * 25);
        })(i);
      }
    } catch(e) {}
  }

  function getAllDocs() {
    var docs = [document];
    try {
      var iframes = document.querySelectorAll('iframe, frame');
      for (var f = 0; f < iframes.length; f++) {
        try {
          var fDoc = iframes[f].contentDocument || (iframes[f].contentWindow && iframes[f].contentWindow.document);
          if (fDoc && docs.indexOf(fDoc) === -1) {
            docs.push(fDoc);
            try {
              var subIframes = fDoc.querySelectorAll('iframe, frame');
              for (var sf = 0; sf < subIframes.length; sf++) {
                var sfDoc = subIframes[sf].contentDocument || (subIframes[sf].contentWindow && subIframes[sf].contentWindow.document);
                if (sfDoc && docs.indexOf(sfDoc) === -1) {
                  docs.push(sfDoc);
                }
              }
            } catch(e2) {}
          }
        } catch(e1) {}
      }
    } catch(e) {}
    return docs;
  }

  try {
    var docs = getAllDocs();
    var allPageText = '';
    for (var d = 0; d < docs.length; d++) {
      try {
        if (docs[d].body) {
          allPageText += ' ' + (docs[d].body.innerText || docs[d].body.textContent || '');
        }
      } catch(e) {}
    }

    // 1. Check for completion modal or results dialog
    var isCompleted = false;
    var completedPhrases = [
      'Congrats!', 'You did well', 'Practice Completed', 'Review Mistakes',
      'Assessment Completed', 'Quiz Completed', 'Test Submitted', 'Your Score:',
      'Submitted Successfully', 'Practice Finished', 'Test Finished'
    ];
    for (var cp = 0; cp < completedPhrases.length; cp++) {
      if (allPageText.includes(completedPhrases[cp])) {
        isCompleted = true;
        break;
      }
    }
    if (!isCompleted && allPageText.includes('Passed') && allPageText.includes('/')) {
      isCompleted = true;
    }

    // 2. Extract Question text
    var questionText = '';
    var qSelector = '#generic-question-wrapper-id, [class*="QuestionContent"], [class*="QuestionDescription"], [class*="question-container"], [data-testid="question-text"], [class*="QuestionText"], [class*="question-text"], [class*="questionText"], [class*="question_title"], [class*="Question_title"], [data-testid*="question"], [class*="question-title"], [class*="prompt"], [class*="mcq-question"], [class*="question_text"], .qtext, .questiontext, [class*="question-view"], [class*="problem-statement"], [class*="instruction"], [class*="question-body"], [class*="question-statement"], [class*="que"] .content, [role="heading"]';
    
    for (var d1 = 0; d1 < docs.length; d1++) {
      try {
        var qContainers = docs[d1].querySelectorAll(qSelector);
        if (qContainers.length > 0) {
          var text = (qContainers[0].innerText || qContainers[0].textContent || '').trim();
          if (text.length > 10) {
            questionText = text.slice(0, 2000);
            break;
          }
        }
      } catch(e) {}
    }

    if (!questionText) {
      // Fallback: extract heading or prominent question paragraph
      for (var d2 = 0; d2 < docs.length; d2++) {
        try {
          var headings = docs[d2].querySelectorAll('h1, h2, h3, h4, [class*="title"], [class*="content"] p, .question, .prompt, [role="main"] p, p');
          for (var h = 0; h < headings.length; h++) {
            var t = (headings[h].innerText || headings[h].textContent || '').trim();
            if (t.length > 15 && !t.includes('INSTRUCTIONS') && !t.includes('SCORE:') && !t.includes('Questions Attempted')) {
              questionText = t.slice(0, 2000);
              break;
            }
          }
          if (questionText) break;
        } catch(e) {}
      }
    }

    // 3. Extract Image URL if present (safely avoid gigantic base64 payloads)
    var imageUrl = '';
    var imgSelector = 'img[alt="image"], img[class*="question"], [class*="Question"] img, img[src*="APTITUDE_IMAGES"], img[src*="VENN"], img[src*="CUBES"], img[src*="amazonaws.com"], .question-container img, [class*="question"] img, img';
    for (var d3 = 0; d3 < docs.length; d3++) {
      try {
        var imgs = docs[d3].querySelectorAll(imgSelector);
        for (var im = 0; im < imgs.length; im++) {
          var src = imgs[im].src || imgs[im].getAttribute('src') || '';
          if (src && !src.includes('profile') && !src.includes('logo') && !src.includes('avatar') && !src.includes('icon') && !src.includes('data:image/svg')) {
            var rect = imgs[im].getBoundingClientRect();
            if (rect.width > 40 && rect.height > 40) {
              if (src.startsWith('data:')) {
                imageUrl = '[Embedded Image]';
              } else {
                imageUrl = src.length > 500 ? src.slice(0, 500) : src;
              }
              break;
            }
          }
        }
        if (imageUrl) break;
      } catch(e) {}
    }

    // 4. Extract Options (Multi-tier: DOM Selectors + Resilient Text Slicing)
    var options = [];
    var seenTexts = {};
    var ignoredPhrases = [
      'SUBMIT', 'SHOW ANSWER', 'SKIP', 'NEXT', 'SAVE & NEXT', 'PREVIOUS',
      'CLEAR', 'END PRACTICE', 'PRACTICE INSTRUCTIONS', 'MCQ PRACTICE',
      'QUESTIONS ATTEMPTED', 'CONFIRM', 'SUBMIT ANSWER'
    ];
    function isIgnored(t) {
      if (!t) return true;
      var up = t.toUpperCase();
      for (var ip = 0; ip < ignoredPhrases.length; ip++) {
        if (up === ignoredPhrases[ip] || up.startsWith('YOU CAN SKIP') || up.startsWith('QUESTIONS ATTEMPTED:')) return true;
      }
      return false;
    }

    function cleanOptionText(raw) {
      if (!raw) return '';
      var clean = raw.trim();
      clean = clean.replace(/^[○●◯⦿\u25CB\u25CF\u25EF\u2022\u25E6\s*-]+/, '').trim();
      clean = clean.replace(/^(\([A-Za-z0-9]+\)|[A-Za-z0-9]+[\.\)])\s*/, '').trim();
      return clean;
    }

    // Strategy A: DOM Selectors (labels, inputs, role="radio", choice lists)
    var optSelector = 'label, [role="radio"], [role="checkbox"], input[type="radio"], input[type="checkbox"], [class*="option" i], [class*="choice" i], [class*="radio" i], [class*="radioButton" i], [data-testid*="option" i], [data-testid*="choice" i], [data-testid*="radio" i], li[class*="choice" i], li[class*="option" i]';

    for (var d4 = 0; d4 < docs.length; d4++) {
      try {
        var optionLabels = docs[d4].querySelectorAll(optSelector);
        for (var o = 0; o < optionLabels.length; o++) {
          var el = optionLabels[o];
          var rawText = (el.innerText || el.textContent || '').trim();
          var testId = el.getAttribute('data-testid') || '';
          var inputEl = el.tagName === 'INPUT' ? el : el.querySelector('input');
          var val = inputEl ? inputEl.value : (el.getAttribute('value') || '');

          if (!rawText && testId) rawText = testId;
          if (!rawText && inputEl && inputEl.value && inputEl.value !== 'on') rawText = inputEl.value;
          if (!rawText && el.parentElement) {
            rawText = (el.parentElement.innerText || el.parentElement.textContent || '').trim();
          }

          var text = cleanOptionText(rawText);
          if (text && text.length > 0 && text.length < 300 && !isIgnored(text)) {
            if (text.split('\n').length > 2) continue;
            var lower = text.toLowerCase();
            if (!seenTexts[lower]) {
              seenTexts[lower] = true;
              options.push({
                id: (testId || text).slice(0, 150),
                text: text.slice(0, 300),
                value: (val || '').slice(0, 100),
                testId: (testId || '').slice(0, 100)
              });
            }
          }
          if (options.length >= 12) break;
        }
        if (options.length >= 12) break;
      } catch(e) {}
    }

    // Strategy B: Resilient Text-slicing Fallback (Between question text and Action Buttons)
    if (options.length < 2) {
      var textFallbackOptions = [];
      var docBodyText = allPageText;
      var qIndex = -1;
      if (questionText) {
        qIndex = docBodyText.indexOf(questionText);
        if (qIndex === -1 && questionText.length > 20) {
          qIndex = docBodyText.indexOf(questionText.slice(0, 25));
        }
      }

      var textAfterQ = qIndex !== -1 ? docBodyText.substring(qIndex + questionText.length) : docBodyText;
      var stopMarkers = ['SHOW ANSWER', 'SUBMIT', 'SKIP', 'You can skip', 'END PRACTICE', 'Questions Attempted'];
      var stopPos = -1;
      for (var sm = 0; sm < stopMarkers.length; sm++) {
        var p = textAfterQ.indexOf(stopMarkers[sm]);
        if (p !== -1 && (stopPos === -1 || p < stopPos)) {
          stopPos = p;
        }
      }

      var optionBlock = stopPos !== -1 ? textAfterQ.substring(0, stopPos) : textAfterQ.slice(0, 1000);
      var lines = optionBlock.split(/\r?\n/);
      for (var li = 0; li < lines.length; li++) {
        var cleanLine = cleanOptionText(lines[li]);
        if (cleanLine.length > 0 && cleanLine.length < 250 && !isIgnored(cleanLine)) {
          var lineLower = cleanLine.toLowerCase();
          if (!seenTexts[lineLower]) {
            seenTexts[lineLower] = true;
            textFallbackOptions.push({
              id: cleanLine.slice(0, 150),
              text: cleanLine.slice(0, 300),
              value: cleanLine.slice(0, 100),
              testId: ''
            });
          }
        }
      }

      if (textFallbackOptions.length >= 2) {
        options = textFallbackOptions;
      }
    }

    // 5. Extract Progress & Score
    var scoreMatch = allPageText.match(/SCORE:\s*(\d+)/i) || allPageText.match(/Score:\s*(\d+)/i) || allPageText.match(/Score:\s*(\d+\/\d+)/i);
    var scoreText = scoreMatch ? scoreMatch[1] : '';

    var progMatch = allPageText.match(/Questions Attempted:\s*(\d+\s*\/\s*\d+)/i) || allPageText.match(/Question\s*(\d+\s*of\s*\d+)/i) || allPageText.match(/(\d+\s*\/\s*\d+)/);
    var progressText = progMatch ? (progMatch[1] || progMatch[0]).replace(/\s+/g, '') : '';

    if (progMatch && progMatch[1]) {
      var parts = progMatch[1].split('/');
      if (parts.length === 2) {
        var doneNum = parseInt(parts[0].trim(), 10);
        var totalNum = parseInt(parts[1].trim(), 10);
        if (totalNum > 0 && doneNum >= totalNum && (allPageText.includes('Completed') || allPageText.includes('Review Mistakes'))) {
          isCompleted = true;
        }
      }
    }

    // 6. Check Action Buttons
    var hasSubmit = false;
    var hasNext = false;
    for (var d5 = 0; d5 < docs.length; d5++) {
      try {
        var buttons = Array.from(docs[d5].querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"], a[class*="btn"]'));
        if (buttons.some(function(b) {
          var t = (b.innerText || b.value || b.textContent || '').trim().toUpperCase();
          return t === 'SUBMIT' || t === 'SAVE & NEXT' || t === 'SUBMIT ANSWER' || t === 'CONFIRM';
        })) {
          hasSubmit = true;
        }
        if (buttons.some(function(b) {
          var t = (b.innerText || b.value || b.textContent || '').trim().toUpperCase();
          return t === 'NEXT' || t === 'NEXT QUESTION' || t === 'CONTINUE' || t === 'SUBMIT & NEXT';
        })) {
          hasNext = true;
        }
      } catch(e) {}
    }

    var data = {
      isCompleted: isCompleted,
      questionText: questionText,
      options: options,
      imageUrl: imageUrl,
      scoreText: scoreText,
      progressText: progressText,
      hasSubmit: hasSubmit,
      hasNext: hasNext
    };

    try { window.__QUIZ_SNAPSHOT__ = data; } catch(e) {}
    sendIpc('QUIZ_SNAPSHOT:' + JSON.stringify(data));
  } catch(err) {
    sendIpc('QUIZ_SNAPSHOT_ERROR:' + String(err));
  }
})();
`;

/** Parses general DOM observation snapshot into structured quiz data as a resilient fallback */
function parseObservationToQuizData(obs: { url?: string; title?: string; text?: string; elements?: any[] }): QuizQuestionData {
  const text = obs.text || '';
  const elements = obs.elements || [];

  // 1. Completion check
  const completedPhrases = [
    'Congrats!', 'You did well', 'Practice Completed', 'Review Mistakes',
    'Assessment Completed', 'Quiz Completed', 'Test Submitted', 'Your Score:',
    'Submitted Successfully', 'Practice Finished', 'Test Finished', 'All questions attempted'
  ];
  let isCompleted = completedPhrases.some(p => text.includes(p));
  if (!isCompleted && text.includes('Passed') && text.includes('/')) {
    isCompleted = true;
  }

  // 2. Options extraction
  const options: { id: string; text: string; value?: string; testId?: string }[] = [];
  const seenTexts = new Set<string>();

  for (const el of elements) {
    const isOptionRole = el.role === 'radio' || el.role === 'checkbox' || el.role === 'option';
    const isOptionTag = el.tag === 'input' && (el.type === 'radio' || el.type === 'checkbox');
    const isOptionName = typeof el.name === 'string' && (el.name.startsWith('[Radio]') || el.name.startsWith('[Checked Radio]') || el.name.startsWith('[Checkbox]'));

    if (isOptionRole || isOptionTag || isOptionName) {
      let optText = (el.text || el.name || el.value || '').trim();
      optText = optText.replace(/^\[(Checked )?(Radio|Checkbox)\]\s*/i, '').trim();
      optText = optText.replace(/^[○●◯⦿\u25CB\u25CF\u25EF\u2022\u25E6\s*-]+/, '').trim();
      optText = optText.replace(/^(\([A-Za-z0-9]+\)|[A-Za-z0-9]+[\.\)])\s*/, '').trim();
      if (optText && !seenTexts.has(optText.toLowerCase())) {
        seenTexts.add(optText.toLowerCase());
        options.push({
          id: el.id || optText,
          text: optText.slice(0, 300),
          value: el.value,
          testId: el.id
        });
      }
      if (options.length >= 12) break;
    }
  }

  // 3. Question text
  let questionText = '';
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 15);
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (!upper.includes('INSTRUCTION') && !upper.includes('QUESTIONS ATTEMPTED') && !upper.includes('SCORE:') && !upper.includes('MCQ PRACTICE')) {
      questionText = line.slice(0, 2000);
      break;
    }
  }

  // Resilient text-slicing fallback if elements didn't yield enough options
  if (options.length < 2 && text) {
    let qPos = -1;
    if (questionText) {
      qPos = text.indexOf(questionText);
      if (qPos === -1 && questionText.length > 20) {
        qPos = text.indexOf(questionText.slice(0, 25));
      }
    }
    const textAfterQ = qPos !== -1 ? text.substring(qPos + questionText.length) : text;
    const stopMarkers = ['SHOW ANSWER', 'SUBMIT', 'SKIP', 'You can skip', 'END PRACTICE', 'Questions Attempted'];
    let stopPos = -1;
    for (const marker of stopMarkers) {
      const p = textAfterQ.indexOf(marker);
      if (p !== -1 && (stopPos === -1 || p < stopPos)) {
        stopPos = p;
      }
    }
    const optionBlock = stopPos !== -1 ? textAfterQ.substring(0, stopPos) : textAfterQ.slice(0, 1000);
    const rawLines = optionBlock.split(/\r?\n/);
    for (const rawLine of rawLines) {
      let cleanLine = rawLine.trim();
      cleanLine = cleanLine.replace(/^[○●◯⦿\u25CB\u25CF\u25EF\u2022\u25E6\s*-]+/, '').trim();
      cleanLine = cleanLine.replace(/^(\([A-Za-z0-9]+\)|[A-Za-z0-9]+[\.\)])\s*/, '').trim();
      const upper = cleanLine.toUpperCase();
      if (
        cleanLine.length > 0 &&
        cleanLine.length < 250 &&
        upper !== 'SUBMIT' &&
        upper !== 'SHOW ANSWER' &&
        upper !== 'SKIP' &&
        !upper.startsWith('YOU CAN SKIP') &&
        !seenTexts.has(cleanLine.toLowerCase())
      ) {
        seenTexts.add(cleanLine.toLowerCase());
        options.push({
          id: cleanLine.slice(0, 150),
          text: cleanLine.slice(0, 300),
          value: cleanLine.slice(0, 100),
          testId: ''
        });
      }
    }
  }

  // 4. Action buttons
  let hasSubmit = false;
  let hasNext = false;
  for (const el of elements) {
    if (el.role === 'button' || el.tag === 'button') {
      const btnText = (el.text || el.name || '').toUpperCase();
      if (btnText.includes('SUBMIT') || btnText.includes('SAVE & NEXT') || btnText.includes('CONFIRM')) {
        hasSubmit = true;
      }
      if (btnText.includes('NEXT') || btnText.includes('CONTINUE')) {
        hasNext = true;
      }
    }
  }

  // 5. Progress & Score
  const scoreMatch = text.match(/SCORE:\s*(\d+)/i) || text.match(/Score:\s*(\d+)/i) || text.match(/Score:\s*(\d+\/\d+)/i);
  const scoreText = scoreMatch ? scoreMatch[1] : '';
  const progMatch = text.match(/Questions Attempted:\s*(\d+\s*\/\s*\d+)/i) || text.match(/Question\s*(\d+\s*of\s*\d+)/i) || text.match(/(\d+\s*\/\s*\d+)/);
  const progressText = progMatch ? (progMatch[1] || progMatch[0]).replace(/\s+/g, '') : '';

  return {
    questionText,
    options,
    imageUrl: '',
    scoreText,
    progressText,
    isCompleted,
    hasSubmit,
    hasNext
  };
}

/** Observer helper to get current quiz question state from webview */
export async function observeQuizPage(tabId: string): Promise<QuizQuestionData> {
  return new Promise(async (resolve, reject) => {
    const eventName = `page-content-tab-${tabId}`;
    let unlisten: (() => void) | null = null;
    let settled = false;

    const cleanup = () => {
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
      clearTimeout(timeout);
      clearTimeout(fallbackPollTimer1);
      clearTimeout(fallbackPollTimer2);
      clearTimeout(fallbackPollTimer3);
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      console.warn(`[QUIZ-OBSERVE-TIMEOUT] tabId=${tabId}, returning safe fallback question data`);
      resolve({
        isCompleted: false,
        questionText: '',
        options: [],
        scoreText: '',
        progressText: '',
        hasSubmit: false,
        hasNext: false
      });
    }, 10000);

    // Fallback 1 (800ms): Poll window.__QUIZ_SNAPSHOT__ with chunked IPC
    const fallbackPollTimer1 = setTimeout(async () => {
      if (settled) return;
      try {
        const pollJs = `
          (function() {
            function sendIpc(payload) {
              try {
                var rawStr = String(payload);
                var CHUNK_SIZE = 600;
                var total = Math.ceil(rawStr.length / CHUNK_SIZE) || 1;
                var msgId = 'quiz_poll_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now().toString(36);

                if (total === 1 && encodeURIComponent(rawStr).length < 1500) {
                  location.href = 'https://tauri-ipc-bridge/data?payload=' + encodeURIComponent(rawStr);
                  return;
                }

                for (var i = 0; i < total; i++) {
                  (function(idx) {
                    setTimeout(function() {
                      var slice = rawStr.substring(idx * CHUNK_SIZE, (idx + 1) * CHUNK_SIZE);
                      var chunkUrl = 'https://tauri-ipc-bridge/chunk?id=' + encodeURIComponent(msgId) +
                                     '&index=' + idx +
                                     '&total=' + total +
                                     '&data=' + encodeURIComponent(slice);
                      location.href = chunkUrl;
                    }, idx * 25);
                  })(i);
                }
              } catch(e) {}
            }

            try {
              var s = window.__QUIZ_SNAPSHOT__;
              if (s) {
                sendIpc('QUIZ_SNAPSHOT:' + JSON.stringify(s));
              } else {
                ${quizExtractScript}
              }
            } catch(e) {}
          })();
        `;
        await invoke('eval_tab_webview', { webviewLabel: `tab-${tabId}`, js: pollJs });
      } catch (e) {}
    }, 800);

    // Fallback 2 (2000ms): Re-inject quizExtractScript
    const fallbackPollTimer2 = setTimeout(async () => {
      if (settled) return;
      try {
        await invoke('eval_tab_webview', { webviewLabel: `tab-${tabId}`, js: quizExtractScript });
      } catch (e) {}
    }, 2000);

    // Fallback 3 (4000ms): Inject universal observationScript as resilient fallback
    const fallbackPollTimer3 = setTimeout(async () => {
      if (settled) return;
      try {
        await invoke('eval_tab_webview', { webviewLabel: `tab-${tabId}`, js: observationScript });
      } catch (e) {}
    }, 4000);

    try {
      unlisten = await listen<string>(eventName, (event) => {
        const raw = String(event.payload || '');
        if (raw.startsWith('QUIZ_SNAPSHOT:')) {
          if (settled) return;
          settled = true;
          cleanup();
          try {
            const parsed = JSON.parse(raw.substring('QUIZ_SNAPSHOT:'.length));
            resolve(parsed);
          } catch (e) {
            reject(e);
          }
        } else if (raw.startsWith('ARIA_AGENT_OBSERVATION:')) {
          if (settled) return;
          settled = true;
          cleanup();
          try {
            const parsed = JSON.parse(raw.substring('ARIA_AGENT_OBSERVATION:'.length));
            const quizData = parseObservationToQuizData(parsed);
            resolve(quizData);
          } catch (e) {
            reject(e);
          }
        } else if (raw.startsWith('QUIZ_SNAPSHOT_ERROR:')) {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error(raw));
        }
      });

      await invoke('eval_tab_webview', {
        webviewLabel: `tab-${tabId}`,
        js: quizExtractScript
      });
    } catch (err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }
  });
}

/** Injects synthetic click on the selected option, clicks SUBMIT, then clicks NEXT across main document & iframes */
export async function executeQuizAnswer(tabId: string, answerText: string): Promise<{ success: boolean; scoreDelta?: number }> {
  const script = `
  (function() {
    function getAllDocs() {
      var docs = [document];
      try {
        var iframes = document.querySelectorAll('iframe, frame');
        for (var f = 0; f < iframes.length; f++) {
          try {
            var fDoc = iframes[f].contentDocument || (iframes[f].contentWindow && iframes[f].contentWindow.document);
            if (fDoc && docs.indexOf(fDoc) === -1) {
              docs.push(fDoc);
              try {
                var subIframes = fDoc.querySelectorAll('iframe, frame');
                for (var sf = 0; sf < subIframes.length; sf++) {
                  var sfDoc = subIframes[sf].contentDocument || (subIframes[sf].contentWindow && subIframes[sf].contentWindow.document);
                  if (sfDoc && docs.indexOf(sfDoc) === -1) docs.push(sfDoc);
                }
              } catch(e2) {}
            }
          } catch(e1) {}
        }
      } catch(e) {}
      return docs;
    }

    try {
      var target = ${JSON.stringify(answerText.trim())};
      var cleanTarget = target.replace(/^[0-9]+\\.\\s*/, '').replace(/^[A-Za-z]\\.\\s*/, '').replace(/^[○●◯⦿\\s*-]+/, '').trim().toLowerCase();
      var cleanTargetNoParen = cleanTarget.replace(/[()]/g, '').trim();
      var docs = getAllDocs();
      var selected = false;

      function triggerClick(el, doc) {
        if (!el) return;
        try { el.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch(e) {}

        var mouseEvents = ['mouseover', 'mousedown', 'mouseup', 'click'];
        for (var m = 0; m < mouseEvents.length; m++) {
          try {
            el.dispatchEvent(new MouseEvent(mouseEvents[m], { bubbles: true, cancelable: true, view: window }));
          } catch(e) {}
        }
        try { el.click(); } catch(e) {}

        var input = el.tagName === 'INPUT' ? el : el.querySelector('input[type="radio"], input[type="checkbox"]');
        if (!input && el.getAttribute && el.getAttribute('for')) {
          try { input = doc.getElementById(el.getAttribute('for')); } catch(e) {}
        }
        if (!input && el.parentElement) {
          input = el.parentElement.querySelector('input[type="radio"], input[type="checkbox"]');
        }
        if (input) {
          input.checked = true;
          try { input.dispatchEvent(new Event('change', { bubbles: true })); } catch(e) {}
          try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch(e) {}
          try { input.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); } catch(e) {}
          try { input.click(); } catch(e) {}
        }

        var container = el.closest('label, li, [role="radio"], [role="checkbox"], [class*="radio" i], [class*="option" i], [class*="choice" i]');
        if (container && container !== el) {
          for (var m2 = 0; m2 < mouseEvents.length; m2++) {
            try {
              container.dispatchEvent(new MouseEvent(mouseEvents[m2], { bubbles: true, cancelable: true, view: window }));
            } catch(e) {}
          }
          try { container.click(); } catch(e) {}
        }
      }

      // Pass 1: Target candidate elements
      var optSelector = 'label, [role="radio"], [role="checkbox"], input[type="radio"], input[type="checkbox"], li, [class*="radio" i], [class*="choice" i], [class*="option" i], [class*="item" i], [data-testid*="option" i], [data-testid*="choice" i]';
      for (var d = 0; d < docs.length && !selected; d++) {
        var elements = Array.from(docs[d].querySelectorAll(optSelector));
        for (var i = 0; i < elements.length; i++) {
          var el = elements[i];
          var rawTxt = (el.innerText || el.textContent || '').trim();
          var tid = el.getAttribute('data-testid') || '';
          var val = el.getAttribute('value') || '';
          var txtClean = rawTxt.replace(/^[○●◯⦿\\s*-]+/, '').replace(/^(\\([A-Za-z0-9]+\\)|[A-Za-z0-9]+[\\.\\)])\\s*/, '').trim().toLowerCase();
          var txtNoParen = txtClean.replace(/[()]/g, '').trim();

          var isMatch = (rawTxt === target || tid === target || val === target) ||
                        (cleanTarget && (txtClean === cleanTarget || txtNoParen === cleanTargetNoParen)) ||
                        (cleanTarget.length >= 4 && (txtClean.includes(cleanTarget) || cleanTarget.includes(txtClean)));

          if (isMatch) {
            triggerClick(el, docs[d]);
            selected = true;
            break;
          }
        }
      }

      // Pass 2: Deepest text-bearing element search (for styled-components / custom divs)
      if (!selected) {
        for (var d2 = 0; d2 < docs.length && !selected; d2++) {
          var allCandidates = Array.from(docs[d2].querySelectorAll('label, span, p, div, code, b, strong, li'));
          var bestMatch = null;
          var bestMatchLength = 999999;

          for (var j = 0; j < allCandidates.length; j++) {
            var cand = allCandidates[j];
            var tag = cand.tagName.toUpperCase();
            if (tag === 'BUTTON' || tag === 'SCRIPT' || tag === 'STYLE') continue;

            var candTxt = (cand.innerText || cand.textContent || '').trim();
            if (!candTxt) continue;
            var candClean = candTxt.replace(/^[○●◯⦿\\s*-]+/, '').replace(/^(\\([A-Za-z0-9]+\\)|[A-Za-z0-9]+[\\.\\)])\\s*/, '').trim().toLowerCase();
            var candNoParen = candClean.replace(/[()]/g, '').trim();

            var candMatches = (candTxt === target) ||
                              (cleanTarget && (candClean === cleanTarget || candNoParen === cleanTargetNoParen)) ||
                              (cleanTarget.length >= 4 && (candClean.includes(cleanTarget) || cleanTarget.includes(candClean)));

            if (candMatches) {
              if (candTxt.length < bestMatchLength) {
                bestMatchLength = candTxt.length;
                bestMatch = cand;
              }
            }
          }

          if (bestMatch) {
            triggerClick(bestMatch, docs[d2]);
            selected = true;
            break;
          }
        }
      }

      // 2. Click SUBMIT if present (after 350ms delay for React state update)
      setTimeout(function() {
        var submitBtn = null;
        for (var d3 = 0; d3 < docs.length && !submitBtn; d3++) {
          var buttons = Array.from(docs[d3].querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"], a[class*="btn"]'));
          submitBtn = buttons.find(function(b) {
            var t = (b.innerText || b.value || b.textContent || '').trim().toUpperCase();
            return t === 'SUBMIT' || t === 'SAVE & NEXT' || t === 'SUBMIT ANSWER' || t === 'CONFIRM';
          });
        }
        if (submitBtn) {
          try { submitBtn.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch(e) {}
          submitBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          submitBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          try { submitBtn.click(); } catch(e) {}
        }

        // 3. Click NEXT if present (poll across 10 intervals to catch the button as soon as scoring finishes)
        var attempts = 0;
        var maxAttempts = 10;
        var nextInterval = setInterval(function() {
          attempts++;
          var nextBtn = null;
          for (var d4 = 0; d4 < docs.length && !nextBtn; d4++) {
            var nextButtons = Array.from(docs[d4].querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"], a[class*="btn"]'));
            nextBtn = nextButtons.find(function(b) {
              var t = (b.innerText || b.value || b.textContent || '').trim().toUpperCase();
              return t === 'NEXT' || t === 'NEXT QUESTION' || t === 'CONTINUE' || t === 'SUBMIT & NEXT';
            });
          }
          if (nextBtn) {
            try { nextBtn.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch(e) {}
            nextBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            nextBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            nextBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            try { nextBtn.click(); } catch(e) {}
            clearInterval(nextInterval);
          } else if (attempts >= maxAttempts) {
            clearInterval(nextInterval);
          }
        }, 350);
      }, 350);

    } catch(e) {}
  })();
  `;

  await invoke('eval_tab_webview', {
    webviewLabel: `tab-${tabId}`,
    js: script
  });

  return { success: true };
}

/** Clicks NEXT or CONTINUE button on the page if visible */
export async function advanceNextQuestion(tabId: string): Promise<boolean> {
  const script = `
  (function() {
    function getAllDocs() {
      var docs = [document];
      try {
        var iframes = document.querySelectorAll('iframe, frame');
        for (var f = 0; f < iframes.length; f++) {
          try {
            var fDoc = iframes[f].contentDocument || (iframes[f].contentWindow && iframes[f].contentWindow.document);
            if (fDoc && docs.indexOf(fDoc) === -1) docs.push(fDoc);
          } catch(e) {}
        }
      } catch(e) {}
      return docs;
    }
    var docs = getAllDocs();
    for (var d = 0; d < docs.length; d++) {
      var buttons = Array.from(docs[d].querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"], a[class*="btn"]'));
      var nextBtn = buttons.find(function(b) {
        var t = (b.innerText || b.value || b.textContent || '').trim().toUpperCase();
        return t === 'NEXT' || t === 'NEXT QUESTION' || t === 'CONTINUE' || t === 'SUBMIT & NEXT';
      });
      if (nextBtn) {
        try { nextBtn.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch(e) {}
        nextBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        nextBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        nextBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        try { nextBtn.click(); } catch(e) {}
        return true;
      }
    }
    return false;
  })();
  `;
  try {
    await invoke('eval_tab_webview', { webviewLabel: `tab-${tabId}`, js: script });
    return true;
  } catch (e) {
    return false;
  }
}

/** Clicks SKIP button on the page if visible (useful when question is stuck or unanswerable) */
export async function skipCurrentQuestion(tabId: string): Promise<boolean> {
  const script = `
  (function() {
    function getAllDocs() {
      var docs = [document];
      try {
        var iframes = document.querySelectorAll('iframe, frame');
        for (var f = 0; f < iframes.length; f++) {
          try {
            var fDoc = iframes[f].contentDocument || (iframes[f].contentWindow && iframes[f].contentWindow.document);
            if (fDoc && docs.indexOf(fDoc) === -1) docs.push(fDoc);
          } catch(e) {}
        }
      } catch(e) {}
      return docs;
    }
    var docs = getAllDocs();
    for (var d = 0; d < docs.length; d++) {
      var buttons = Array.from(docs[d].querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"], a[class*="btn"]'));
      var skipBtn = buttons.find(function(b) {
        var t = (b.innerText || b.value || b.textContent || '').trim().toUpperCase();
        return t === 'SKIP' || t.startsWith('SKIP ');
      });
      if (skipBtn && !skipBtn.disabled) {
        try { skipBtn.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch(e) {}
        skipBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        skipBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        skipBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        try { skipBtn.click(); } catch(e) {}
        return true;
      }
    }
    return false;
  })();
  `;
  try {
    await invoke('eval_tab_webview', { webviewLabel: `tab-${tabId}`, js: script });
    return true;
  } catch (e) {
    return false;
  }
}

/** Solves question using active AI provider with specialized aptitude & logical reasoning instructions */
export async function solveQuestionWithAI(
  question: QuizQuestionData,
  settings: BrowserSettings
): Promise<string> {
  if (!question.options || question.options.length === 0) {
    return '';
  }

  const provider = await getActiveProvider(settings.aiProvider);
  if (!provider) {
    throw new Error(`AI Provider ${settings.aiProvider} not configured or available`);
  }

  const optionsList = question.options.map((o, idx) => `${idx + 1}. "${o.text}"`).join('\n');

  const systemPrompt = `You are an elite reasoning and competitive exam solver AI.
Your task is to accurately solve multiple choice questions (Computer Science, Node.js, Web Development, Aptitude, Mathematics, Logic).

CRITICAL RULES:
1. Carefully solve the question step-by-step internally.
2. Match your solution to the EXACT option string provided in the options list.
3. Return ONLY a single JSON object with the format:
{"answer": "<exact option text string>"}
Do not include markdown fences, extra commentary, or reasoning. Output only valid JSON.`;

  const userPrompt = `QUESTION:
${question.questionText || 'See options and figure'}
${question.imageUrl ? `[Image URL: ${question.imageUrl}]` : ''}

OPTIONS:
${optionsList}

Select the exact correct option text from the list above.`;

  let responseText = '';
  for await (const chunk of provider.chat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    { model: settings.aiModel }
  )) {
    responseText += chunk;
  }

  // Extract JSON answer
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.answer) {
        const rawAns = String(parsed.answer).trim();
        const normAns = rawAns.toLowerCase().replace(/[()]/g, '').trim();

        // Exact match
        const exactMatch = question.options.find(
          o => o.text.trim().toLowerCase() === rawAns.toLowerCase() ||
               o.id.trim().toLowerCase() === rawAns.toLowerCase()
        );
        if (exactMatch) return exactMatch.text;

        // Normalized match (ignore parentheses or whitespace differences)
        const normMatch = question.options.find(
          o => {
            const optNorm = o.text.trim().toLowerCase().replace(/[()]/g, '').trim();
            return optNorm === normAns || (normAns.length >= 4 && (optNorm.includes(normAns) || normAns.includes(optNorm)));
          }
        );
        if (normMatch) return normMatch.text;

        return rawAns;
      }
    }
  } catch (e) {}

  // Fallback: search for option text in response
  for (const opt of question.options) {
    if (responseText.toLowerCase().includes(opt.text.toLowerCase())) {
      return opt.text;
    }
  }

  return question.options[0]?.text || '';
}

/** Main Automated Quiz & Assessment Solver Loop */
export async function runAutoQuizSolver(
  tabId: string,
  settings: BrowserSettings,
  callbacks: QuizSolverCallbacks
): Promise<void> {
  const runId = 'quiz_run_' + Date.now();
  activeQuizRunId = runId;

  callbacks.onLog('[QUIZ_SOLVER] Starting Automated Assessment Solver...');
  callbacks.onStatusUpdate('Initializing Assessment Auto-Solver...', 0);

  // Pre-emptively disarm any 'beforeunload' traps on the page to prevent "Leave site?" prompts during IPC
  try {
    await invoke('eval_tab_webview', {
      webviewLabel: `tab-${tabId}`,
      js: `
        (function() {
          try {
            var origAEL = EventTarget.prototype.addEventListener;
            EventTarget.prototype.addEventListener = function(type, listener, options) {
              if (type === 'beforeunload') return;
              return origAEL.apply(this, arguments);
            };
            window.onbeforeunload = null;
            document.onbeforeunload = null;
            if (document.body) document.body.onbeforeunload = null;
            try {
              Object.defineProperty(window, 'onbeforeunload', {
                get: function() { return null; },
                set: function() {},
                configurable: true
              });
            } catch(e) {}
            window.addEventListener('beforeunload', function(e) {
              e.stopImmediatePropagation();
              e.stopPropagation();
              delete e.returnValue;
              e.returnValue = undefined;
            }, true);
          } catch(e) {}
        })();
      `
    });
  } catch (e) {}

  let currentQuestionNum = 0;
  let loopIterations = 0;
  const maxIterations = 80;
  let lastQuestionText = '';
  let sameQuestionRepeatCount = 0;

  while (loopIterations < maxIterations) {
    loopIterations++;

    if (activeQuizRunId !== runId || callbacks.isCancelled()) {
      callbacks.onLog('[QUIZ_SOLVER] Solver was stopped by user.');
      callbacks.onFinish('Quiz solver stopped.', false);
      return;
    }

    while (callbacks.isPaused()) {
      callbacks.onStatusUpdate('Solver Paused', currentQuestionNum);
      await new Promise(r => setTimeout(r, 500));
      if (activeQuizRunId !== runId || callbacks.isCancelled()) return;
    }

    callbacks.onStatusUpdate(`Analyzing Question ${currentQuestionNum || 1}...`, currentQuestionNum || 1);

    // 1. Observe current page with progressive retries
    let questionState: QuizQuestionData | null = null;
    let observeAttempts = 0;
    const maxObserveAttempts = 4;

    while (observeAttempts < maxObserveAttempts) {
      observeAttempts++;
      try {
        questionState = await observeQuizPage(tabId);
        if (questionState && (questionState.options.length > 0 || questionState.isCompleted || questionState.hasNext || questionState.hasSubmit)) {
          break;
        }
      } catch (err: any) {
        callbacks.onLog(`[QUIZ_SOLVER] Observation note (attempt ${observeAttempts}/${maxObserveAttempts}): ${err?.message || err}`);
      }

      if (observeAttempts < maxObserveAttempts) {
        callbacks.onLog(`[QUIZ_SOLVER] Waiting for page DOM to settle (Retry ${observeAttempts}/${maxObserveAttempts})...`);
        await new Promise(r => setTimeout(r, 1000 * observeAttempts));
      }
    }

    if (!questionState) {
      questionState = {
        isCompleted: false,
        questionText: '',
        options: [],
        scoreText: '',
        progressText: '',
        hasSubmit: false,
        hasNext: false
      };
    }

    // 2. Check if test is completed
    if (questionState.isCompleted || (questionState.options.length === 0 && !questionState.hasSubmit && !questionState.hasNext && currentQuestionNum > 0)) {
      callbacks.onTimelineUpdate({
        id: `step-${currentQuestionNum}-complete`,
        timestamp: new Date().toLocaleTimeString(),
        actionType: 'COMPLETED',
        target: 'Assessment',
        result: `All questions finished! ${questionState.scoreText ? `Final Score: ${questionState.scoreText}` : ''}`,
        status: 'success'
      });
      callbacks.onLog(`[QUIZ_SOLVER] Assessment Complete! Score: ${questionState.scoreText || 'Completed'}`);
      callbacks.onFinish(`Assessment completed successfully! ${questionState.scoreText ? `Final Score: ${questionState.scoreText}` : ''}`, true);
      return;
    }

    // If page is currently showing NEXT/CONTINUE button without options (e.g. between questions), advance
    if (questionState.hasNext && !questionState.hasSubmit && questionState.options.length === 0) {
      callbacks.onLog('[QUIZ_SOLVER] Advancing to next question...');
      await advanceNextQuestion(tabId);
      await new Promise(r => setTimeout(r, 1200));
      continue;
    }

    // 3. Question tracking & Stall protection
    const currentQText = (questionState.questionText || '').trim();
    const progress = questionState.progressText || '';

    const isSameQuestion = Boolean(
      lastQuestionText &&
      currentQText &&
      (lastQuestionText === currentQText || (lastQuestionText.length > 30 && lastQuestionText.slice(0, 50) === currentQText.slice(0, 50)))
    );

    if (isSameQuestion) {
      sameQuestionRepeatCount++;
      callbacks.onLog(`[QUIZ_SOLVER] Still on Question ${currentQuestionNum} (Attempt ${sameQuestionRepeatCount})...`);

      if (sameQuestionRepeatCount === 2) {
        callbacks.onLog('[QUIZ_SOLVER] Checking for NEXT / CONTINUE button to advance...');
        const advanced = await advanceNextQuestion(tabId);
        if (advanced) {
          await new Promise(r => setTimeout(r, 1200));
          continue;
        }
      } else if (sameQuestionRepeatCount >= 4) {
        callbacks.onLog('[QUIZ_SOLVER] Question did not advance after multiple attempts. Attempting SKIP...');
        const skipped = await skipCurrentQuestion(tabId);
        if (skipped) {
          callbacks.onLog('[QUIZ_SOLVER] Triggered SKIP to proceed.');
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
      }
    } else {
      currentQuestionNum++;
      sameQuestionRepeatCount = 1;
      lastQuestionText = currentQText;
    }

    callbacks.onLog(`[QUIZ_SOLVER] Q${currentQuestionNum}${progress ? ` (${progress})` : ''}: "${(currentQText || 'Question').slice(0, 60)}..." (Options: ${questionState.options.length})`);

    // If options are still empty, wait briefly and retry observation once
    if (questionState.options.length === 0) {
      callbacks.onLog('[QUIZ_SOLVER] No options found on first pass. Retrying page observation...');
      await new Promise(r => setTimeout(r, 800));
      try {
        questionState = await observeQuizPage(tabId);
      } catch (e) {}

      if (questionState.options.length === 0) {
        if (questionState.hasNext) {
          await advanceNextQuestion(tabId);
        } else {
          await skipCurrentQuestion(tabId);
        }
        await new Promise(r => setTimeout(r, 1200));
        continue;
      }
    }

    // 4. Solve with AI
    callbacks.onStatusUpdate(`Solving Question ${currentQuestionNum}...`, currentQuestionNum);
    let selectedAnswer = '';
    try {
      selectedAnswer = await solveQuestionWithAI(questionState, settings);
    } catch (aiErr: any) {
      callbacks.onLog(`[QUIZ_SOLVER] AI error: ${aiErr?.message}. Defaulting to first option.`);
      selectedAnswer = questionState.options[0]?.text || '';
    }

    if (!selectedAnswer && questionState.options.length > 0) {
      selectedAnswer = questionState.options[0].text;
    }

    callbacks.onLog(`[QUIZ_SOLVER] Selected Answer: "${selectedAnswer}"`);

    // 5. Click & Submit
    callbacks.onTimelineUpdate({
      id: `step-${currentQuestionNum}`,
      timestamp: new Date().toLocaleTimeString(),
      actionType: 'SUBMIT_ANSWER',
      target: `Q${currentQuestionNum}: ${selectedAnswer}`,
      result: `Selected: ${selectedAnswer} (${questionState.progressText || `Question ${currentQuestionNum}`})`,
      status: 'success'
    });

    await executeQuizAnswer(tabId, selectedAnswer);

    // Pacing pause to allow DOM transition and grading animation
    await new Promise(r => setTimeout(r, 1400));
  }

  callbacks.onFinish(`Completed assessment session (${currentQuestionNum} questions handled).`, true);
}
