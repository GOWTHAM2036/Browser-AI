import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getActiveProvider } from '../ai';
import { BrowserSettings } from '../../types';

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
  function sendIpc(payload) {
    try {
      var rawStr = String(payload);
      var encoded = encodeURIComponent(rawStr);
      location.href = 'https://tauri-ipc-bridge/data?payload=' + encoded;
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
    var qSelector = '#generic-question-wrapper-id, [class*="QuestionContent"], [class*="QuestionDescription"], [class*="question-container"], [data-testid="question-text"], [class*="QuestionText"], [class*="question-text"], [class*="questionText"], [class*="question_title"], [class*="Question_title"], [data-testid*="question"], [class*="question-title"], [class*="prompt"], [class*="mcq-question"]';
    
    for (var d1 = 0; d1 < docs.length; d1++) {
      var qContainers = docs[d1].querySelectorAll(qSelector);
      if (qContainers.length > 0) {
        var text = (qContainers[0].innerText || qContainers[0].textContent || '').trim();
        if (text.length > 10) {
          questionText = text;
          break;
        }
      }
    }

    if (!questionText) {
      // Fallback: extract heading or prominent question paragraph
      for (var d2 = 0; d2 < docs.length; d2++) {
        var headings = docs[d2].querySelectorAll('h1, h2, h3, h4, [class*="title"], [class*="content"] p, .question, .prompt, [role="main"] p, p');
        for (var h = 0; h < headings.length; h++) {
          var t = (headings[h].innerText || headings[h].textContent || '').trim();
          if (t.length > 15 && !t.includes('INSTRUCTIONS') && !t.includes('SCORE:') && !t.includes('Questions Attempted')) {
            questionText = t;
            break;
          }
        }
        if (questionText) break;
      }
    }

    // 3. Extract Image URL if present
    var imageUrl = '';
    var imgSelector = 'img[alt="image"], img[class*="question"], [class*="Question"] img, img[src*="APTITUDE_IMAGES"], img[src*="VENN"], img[src*="CUBES"], img[src*="amazonaws.com"], .question-container img, [class*="question"] img, img';
    for (var d3 = 0; d3 < docs.length; d3++) {
      var imgs = docs[d3].querySelectorAll(imgSelector);
      for (var im = 0; im < imgs.length; im++) {
        var src = imgs[im].src || imgs[im].getAttribute('src') || '';
        if (src && !src.includes('profile') && !src.includes('logo') && !src.includes('avatar') && !src.includes('icon') && !src.includes('data:image/svg')) {
          var rect = imgs[im].getBoundingClientRect();
          if (rect.width > 40 && rect.height > 40) {
            imageUrl = src;
            break;
          }
        }
      }
      if (imageUrl) break;
    }

    // 4. Extract Options
    var options = [];
    var optSelector = 'label[id="radioButton"], label[data-testid], [class*="OptionComponent"], [class*="radioButtonLabel"], [class*="option-item"], [class*="Option"], [class*="option"], [data-testid*="option"], [data-testid*="choice"], [data-testid*="answer"], [role="radio"], [role="checkbox"], input[type="radio"], input[type="checkbox"], li[class*="choice"], li[class*="option"]';
    var seenTexts = {};

    for (var d4 = 0; d4 < docs.length; d4++) {
      var optionLabels = docs[d4].querySelectorAll(optSelector);
      for (var o = 0; o < optionLabels.length; o++) {
        var el = optionLabels[o];
        var text = (el.innerText || el.textContent || '').trim();
        var testId = el.getAttribute('data-testid') || '';
        var inputEl = el.tagName === 'INPUT' ? el : el.querySelector('input');
        var val = inputEl ? inputEl.value : (el.getAttribute('value') || '');

        if (!text && testId) text = testId;
        if (!text && inputEl && inputEl.value && inputEl.value !== 'on') text = inputEl.value;
        if (!text && el.parentElement) {
          text = (el.parentElement.innerText || el.parentElement.textContent || '').trim();
        }

        var upper = text.toUpperCase();
        if (text && !seenTexts[text] && upper !== 'SUBMIT' && upper !== 'SHOW ANSWER' && upper !== 'SKIP' && upper !== 'NEXT' && upper !== 'SAVE & NEXT' && upper !== 'PREVIOUS' && upper !== 'CLEAR') {
          seenTexts[text] = true;
          options.push({
            id: testId || text,
            text: text,
            value: val,
            testId: testId
          });
        }
      }
    }

    // 5. Extract Progress & Score
    var scoreMatch = allPageText.match(/SCORE:\s*(\d+)/i) || allPageText.match(/Score:\s*(\d+)/i) || allPageText.match(/Score:\s*(\d+\/\d+)/i);
    var scoreText = scoreMatch ? scoreMatch[1] : '';

    var progMatch = allPageText.match(/Questions Attempted:\s*(\d+\/\d+)/i) || allPageText.match(/Question\s*(\d+\s*of\s*\d+)/i) || allPageText.match(/(\d+\/\d+)/);
    var progressText = progMatch ? (progMatch[1] || progMatch[0]) : '';

    // 6. Check Action Buttons
    var hasSubmit = false;
    var hasNext = false;
    for (var d5 = 0; d5 < docs.length; d5++) {
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
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Quiz observation timed out after 10s'));
    }, 10000);

    // Fallback polling: If no event received after 1.2s, re-check window.__QUIZ_SNAPSHOT__
    const fallbackPollTimer1 = setTimeout(async () => {
      if (settled) return;
      try {
        const pollJs = `
          (function() {
            try {
              var s = window.__QUIZ_SNAPSHOT__;
              if (s) {
                location.href = 'https://tauri-ipc-bridge/data?payload=' + encodeURIComponent('QUIZ_SNAPSHOT:' + JSON.stringify(s));
              } else {
                ${quizExtractScript}
              }
            } catch(e) {}
          })();
        `;
        await invoke('eval_tab_webview', { webviewLabel: `tab-${tabId}`, js: pollJs });
      } catch (e) {}
    }, 1200);

    const fallbackPollTimer2 = setTimeout(async () => {
      if (settled) return;
      try {
        await invoke('eval_tab_webview', { webviewLabel: `tab-${tabId}`, js: quizExtractScript });
      } catch (e) {}
    }, 3500);

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
      var docs = getAllDocs();
      var selected = false;
      var optSelector = 'label[id="radioButton"], label[data-testid], [class*="OptionComponent"], [class*="radioButtonLabel"], [class*="option-item"], [class*="Option"], [class*="option"], [data-testid*="option"], [data-testid*="choice"], [data-testid*="answer"], [role="radio"], [role="checkbox"], input[type="radio"], input[type="checkbox"], li[class*="choice"], li[class*="option"]';
      
      for (var d = 0; d < docs.length && !selected; d++) {
        var labels = Array.from(docs[d].querySelectorAll(optSelector));
        for (var i = 0; i < labels.length; i++) {
          var l = labels[i];
          var txt = (l.innerText || l.textContent || '').trim();
          var tid = l.getAttribute('data-testid') || '';
          var val = l.getAttribute('value') || '';
          var matches = (txt === target || tid === target || val === target) ||
                        (target.length > 2 && (txt.includes(target) || tid.includes(target)));
          if (matches) {
            l.click();
            var input = l.tagName === 'INPUT' ? l : l.querySelector('input');
            if (input) {
              input.checked = true;
              input.dispatchEvent(new Event('change', { bubbles: true }));
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            }
            selected = true;
            break;
          }
        }
      }

      // If exact string wasn't found, try matching by clean option text without index prefixes
      if (!selected) {
        var cleanTarget = target.replace(/^[0-9]+\\.\\s*/, '').trim().toLowerCase();
        for (var d2 = 0; d2 < docs.length && !selected; d2++) {
          var labels2 = Array.from(docs[d2].querySelectorAll(optSelector));
          for (var j = 0; j < labels2.length; j++) {
            var l2 = labels2[j];
            var t2 = (l2.innerText || l2.textContent || '').trim().toLowerCase();
            if (t2 && (t2.includes(cleanTarget) || cleanTarget.includes(t2))) {
              l2.click();
              var inp = l2.tagName === 'INPUT' ? l2 : l2.querySelector('input');
              if (inp) {
                inp.checked = true;
                inp.dispatchEvent(new Event('change', { bubbles: true }));
              }
              selected = true;
              break;
            }
          }
        }
      }

      // 2. Click SUBMIT if present
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
          submitBtn.click();
        }

        // 3. Click NEXT if present after short delay
        setTimeout(function() {
          var nextBtn = null;
          for (var d4 = 0; d4 < docs.length && !nextBtn; d4++) {
            var nextButtons = Array.from(docs[d4].querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"], a[class*="btn"]'));
            nextBtn = nextButtons.find(function(b) {
              var t = (b.innerText || b.value || b.textContent || '').trim().toUpperCase();
              return t === 'NEXT' || t === 'NEXT QUESTION' || t === 'CONTINUE' || t === 'SUBMIT & NEXT';
            });
          }
          if (nextBtn) {
            nextBtn.click();
          }
        }, 600);
      }, 300);

    } catch(e) {}
  })();
  `;

  await invoke('eval_tab_webview', {
    webviewLabel: `tab-${tabId}`,
    js: script
  });

  return { success: true };
}

/** Solves question using active AI provider with specialized aptitude & logical reasoning instructions */
export async function solveQuestionWithAI(
  question: QuizQuestionData,
  settings: BrowserSettings
): Promise<string> {
  const provider = await getActiveProvider(settings.aiProvider);
  if (!provider) {
    throw new Error(`AI Provider ${settings.aiProvider} not configured or available`);
  }

  const optionsList = question.options.map((o, idx) => `${idx + 1}. "${o.text}"`).join('\n');

  const systemPrompt = `You are an elite reasoning and competitive exam solver AI.
Your task is to accurately solve multiple choice questions (Aptitude, Cubes, Venn Diagrams, Syllogisms, Mathematics, Logic, General Knowledge).

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
        // Match with closest option
        const matched = question.options.find(
          o => o.text.trim().toLowerCase() === parsed.answer.trim().toLowerCase() ||
               o.id.trim().toLowerCase() === parsed.answer.trim().toLowerCase()
        );
        if (matched) return matched.text;
        return parsed.answer;
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

  let questionIndex = 0;
  let maxQuestions = 50; // Safety safeguard

  while (questionIndex < maxQuestions) {
    if (activeQuizRunId !== runId || callbacks.isCancelled()) {
      callbacks.onLog('[QUIZ_SOLVER] Solver was stopped by user.');
      callbacks.onFinish('Quiz solver stopped.', false);
      return;
    }

    while (callbacks.isPaused()) {
      callbacks.onStatusUpdate('Solver Paused', questionIndex);
      await new Promise(r => setTimeout(r, 500));
      if (activeQuizRunId !== runId || callbacks.isCancelled()) return;
    }

    questionIndex++;
    callbacks.onStatusUpdate(`Analyzing Question ${questionIndex}...`, questionIndex);

    // 1. Observe current page
    let questionState: QuizQuestionData;
    try {
      questionState = await observeQuizPage(tabId);
    } catch (err: any) {
      callbacks.onLog(`[QUIZ_SOLVER] Observation note: ${err?.message || err}. Retrying...`);
      await new Promise(r => setTimeout(r, 1000));
      try {
        questionState = await observeQuizPage(tabId);
      } catch (err2) {
        callbacks.onFinish('Failed to read quiz page DOM.', false);
        return;
      }
    }

    // 2. Check if test is completed
    if (questionState.isCompleted || (questionState.options.length === 0 && !questionState.hasSubmit && !questionState.hasNext)) {
      callbacks.onTimelineUpdate({
        id: `step-${questionIndex}-complete`,
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

    callbacks.onLog(`[QUIZ_SOLVER] Q${questionIndex}: "${(questionState.questionText || 'Question').slice(0, 60)}..." (Options: ${questionState.options.length})`);

    // 3. Solve with AI
    callbacks.onStatusUpdate(`Solving Question ${questionIndex}...`, questionIndex);
    let selectedAnswer = '';
    try {
      selectedAnswer = await solveQuestionWithAI(questionState, settings);
      callbacks.onLog(`[QUIZ_SOLVER] Selected Answer: "${selectedAnswer}"`);
    } catch (aiErr: any) {
      callbacks.onLog(`[QUIZ_SOLVER] AI error: ${aiErr?.message}. Defaulting to first option.`);
      selectedAnswer = questionState.options[0]?.text || '';
    }

    // 4. Click & Submit
    callbacks.onTimelineUpdate({
      id: `step-${questionIndex}`,
      timestamp: new Date().toLocaleTimeString(),
      actionType: 'SUBMIT_ANSWER',
      target: `Q${questionIndex}: ${selectedAnswer}`,
      result: `Selected: ${selectedAnswer} (${questionState.progressText || `Question ${questionIndex}`})`,
      status: 'success'
    });

    await executeQuizAnswer(tabId, selectedAnswer);

    // Short pacing pause to allow DOM transition
    await new Promise(r => setTimeout(r, 1200));
  }

  callbacks.onFinish(`Completed ${questionIndex} questions.`, true);
}
