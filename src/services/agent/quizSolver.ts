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

/** DOM extraction script to identify questions, options, images, and progress */
export const quizExtractScript = `
(function() {
  function sendIpc(payload) {
    try {
      var rawStr = String(payload);
      var CHUNK_SIZE = 1000;
      var total = Math.ceil(rawStr.length / CHUNK_SIZE) || 1;
      var msgId = 'quiz_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now().toString(36);

      function fallbackDispatch() {
        if (total === 1 && rawStr.length < 1500) {
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
      }

      if (typeof fetch === 'function') {
        fetch('http://aria-ipc.localhost/data', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: rawStr,
          mode: 'no-cors'
        }).catch(function() {
          fallbackDispatch();
        });
      } else {
        fallbackDispatch();
      }
    } catch(e) {}
  }

  try {
    // 1. Check for completion modal or results dialog
    var isCompleted = false;
    var modal = document.querySelector('[role="dialog"], dialog, .modal, [class*="modal"], [class*="congrats"], [class*="Result"]');
    var pageText = document.body ? document.body.innerText : '';
    if (pageText.includes('Congrats!') || pageText.includes('You did well') || pageText.includes('Practice Completed') || pageText.includes('Review Mistakes') || (pageText.includes('Passed') && pageText.includes('/'))) {
      isCompleted = true;
    }

    // 2. Extract Question text
    var questionText = '';
    var qContainers = document.querySelectorAll('#generic-question-wrapper-id, [class*="QuestionContent"], [class*="QuestionDescription"], [class*="question-container"], [data-testid="question-text"], [class*="QuestionText"]');
    if (qContainers.length > 0) {
      questionText = qContainers[0].innerText.trim();
    } else {
      // Fallback: extract heading or prominent question paragraph
      var headings = document.querySelectorAll('h1, h2, h3, h4, [class*="title"], [class*="content"] p');
      for (var h = 0; h < headings.length; h++) {
        var t = headings[h].innerText.trim();
        if (t.length > 20 && !t.includes('INSTRUCTIONS') && !t.includes('SCORE:')) {
          questionText = t;
          break;
        }
      }
    }

    // 3. Extract Image URL if present
    var imageUrl = '';
    var imgs = document.querySelectorAll('img[alt="image"], img[class*="question"], [class*="Question"] img, img[src*="APTITUDE_IMAGES"], img[src*="VENN"], img[src*="CUBES"], img[src*="amazonaws.com"]');
    if (imgs.length > 0) {
      for (var im = 0; im < imgs.length; im++) {
        var src = imgs[im].src || '';
        if (src && !src.includes('profile') && !src.includes('logo') && !src.includes('avatar')) {
          imageUrl = src;
          break;
        }
      }
    }

    // 4. Extract Options
    var options = [];
    var optionLabels = document.querySelectorAll('label[id="radioButton"], label[data-testid], [class*="OptionComponent"], [class*="radioButtonLabel"], [class*="option-item"], input[type="radio"], [role="radio"]');
    
    var seenTexts = {};
    for (var o = 0; o < optionLabels.length; o++) {
      var el = optionLabels[o];
      var text = el.innerText ? el.innerText.trim() : '';
      var testId = el.getAttribute('data-testid') || '';
      var inputEl = el.tagName === 'INPUT' ? el : el.querySelector('input');
      var val = inputEl ? inputEl.value : (el.getAttribute('value') || '');

      if (!text && testId) text = testId;
      if (!text && inputEl && inputEl.value) text = inputEl.value;

      if (text && !seenTexts[text] && text !== 'SUBMIT' && text !== 'SHOW ANSWER' && text !== 'SKIP' && text !== 'NEXT') {
        seenTexts[text] = true;
        options.push({
          id: testId || text,
          text: text,
          value: val,
          testId: testId
        });
      }
    }

    // 5. Extract Progress & Score
    var scoreMatch = pageText.match(/SCORE:\s*(\d+)/i) || pageText.match(/Score:\s*(\d+)/i);
    var scoreText = scoreMatch ? scoreMatch[1] : '';

    var progMatch = pageText.match(/Questions Attempted:\s*(\d+\/\d+)/i) || pageText.match(/(\d+\/\d+)/);
    var progressText = progMatch ? progMatch[1] : '';

    // 6. Check Action Buttons
    var buttons = Array.from(document.querySelectorAll('button'));
    var hasSubmit = buttons.some(function(b) { return b.innerText.trim().toUpperCase() === 'SUBMIT'; });
    var hasNext = buttons.some(function(b) { return b.innerText.trim().toUpperCase() === 'NEXT'; });

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

    const timeout = setTimeout(() => {
      if (unlisten) unlisten();
      reject(new Error('Quiz observation timed out after 8s'));
    }, 8000);

    try {
      unlisten = await listen<string>(eventName, (event) => {
        const raw = String(event.payload || '');
        if (raw.startsWith('QUIZ_SNAPSHOT:')) {
          clearTimeout(timeout);
          if (unlisten) unlisten();
          try {
            const parsed = JSON.parse(raw.substring('QUIZ_SNAPSHOT:'.length));
            resolve(parsed);
          } catch (e) {
            reject(e);
          }
        } else if (raw.startsWith('QUIZ_SNAPSHOT_ERROR:')) {
          clearTimeout(timeout);
          if (unlisten) unlisten();
          reject(new Error(raw));
        }
      });

      await invoke('eval_tab_webview', {
        webviewLabel: `tab-${tabId}`,
        js: quizExtractScript
      });
    } catch (err) {
      clearTimeout(timeout);
      if (unlisten) unlisten();
      reject(err);
    }
  });
}

/** Injects synthetic click on the selected option, clicks SUBMIT, then clicks NEXT */
export async function executeQuizAnswer(tabId: string, answerText: string): Promise<{ success: boolean; scoreDelta?: number }> {
  const script = `
  (function() {
    try {
      var target = ${JSON.stringify(answerText.trim())};
      
      // 1. Select matching option
      var selected = false;
      var labels = Array.from(document.querySelectorAll('label[id="radioButton"], label[data-testid], [class*="OptionComponent"], [class*="radioButtonLabel"], input[type="radio"], [role="radio"]'));
      
      for (var i = 0; i < labels.length; i++) {
        var l = labels[i];
        var txt = (l.innerText || '').trim();
        var tid = l.getAttribute('data-testid') || '';
        if (txt === target || tid === target || (target.length > 0 && txt.includes(target)) || (tid && tid.includes(target))) {
          l.click();
          var input = l.tagName === 'INPUT' ? l : l.querySelector('input');
          if (input) {
            input.checked = true;
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
          selected = true;
          break;
        }
      }

      // 2. Click SUBMIT if present
      setTimeout(function() {
        var buttons = Array.from(document.querySelectorAll('button'));
        var submitBtn = buttons.find(function(b) { return b.innerText.trim().toUpperCase() === 'SUBMIT'; });
        if (submitBtn) {
          submitBtn.click();
        }

        // 3. Click NEXT if present after short delay
        setTimeout(function() {
          var nextButtons = Array.from(document.querySelectorAll('button'));
          var nextBtn = nextButtons.find(function(b) { return b.innerText.trim().toUpperCase() === 'NEXT'; });
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
    if (questionState.isCompleted || (questionState.options.length === 0 && !questionState.hasSubmit)) {
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

    callbacks.onLog(`[QUIZ_SOLVER] Q${questionIndex}: "${questionState.questionText.slice(0, 60)}..." (Options: ${questionState.options.length})`);

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
