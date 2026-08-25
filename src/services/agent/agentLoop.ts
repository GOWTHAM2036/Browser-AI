import { listen, Event as TauriEvent } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { AgentObservation, observationScript, ElementRect } from './observer';
import { AgentAction, validateAgentAction } from './actions';
import { executionScript, ActionResult } from './executor';
import { getInPageStatusScript, getInPageCleanupScript } from './inPageOverlay';
import { getActiveProvider, getApiKey } from '../ai';
import { normalizeAgentUrl } from '../agent';
import { extractJsonFromText } from '../utils';
import { BrowserSettings, Tab } from '../../types';
import { emitAgentVisualEvent, completeAgentVisualAction, hideAgentCursor } from './visualEvents';

export interface AgentLoopCallbacks {
  onStatusUpdate: (status: string, currentStep: number) => void;
  onTimelineUpdate: (item: {
    id: string;
    timestamp: string;
    actionType: string;
    target: string;
    result: string;
    status: 'pending' | 'success' | 'error';
  }) => void;
  onLog: (log: string) => void;
  onDebugData?: (rawLlm: string, parsedJson: any) => void;
  onFinish: (result: string, success: boolean) => void;
  isCancelled: () => boolean;
  isPaused: () => boolean;
  navigateActiveTab: (url: string) => Promise<void>;
  addTab: (url?: string) => Promise<string>;
  setActiveTabId: (id: string) => Promise<void>;
  getTabs: () => Tab[];
  getActiveTabId: () => string | null;
}

let activeGlobalRunId: string | null = null;
let activeControlledTabId: string | null = null;

export function cancelActiveAgentRun(): void {
  activeGlobalRunId = null;
  hideAgentCursor();
  if (activeControlledTabId) {
    invoke('eval_tab_webview', {
      webviewLabel: `tab-${activeControlledTabId}`,
      js: getInPageCleanupScript()
    }).catch(() => {});
  }
}

export function getObservationHash(obs: AgentObservation): string {
  const elemSig = obs.elements
    .map((e) => `${e.id}:${e.tag}:${e.value || ''}:${e.text.slice(0, 30)}`)
    .join('|');
  const str = `${obs.url}::${obs.title}::${elemSig}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return hash.toString(36);
}

export function getActionSignature(action: AgentAction): string {
  switch (action.action) {
    case 'type':
      return `type:${action.element_id}:${action.text}`;
    case 'type_and_submit':
      return `type_and_submit:${action.element_id}:${action.text}`;
    case 'click':
      return `click:${action.element_id}`;
    case 'press':
      return `press:${action.element_id || 'active'}:${action.key}`;
    case 'navigate':
      return `navigate:${action.url}:${action.target || 'current_tab'}`;
    case 'select':
      return `select:${action.element_id}:${action.value}`;
    case 'scroll':
      return `scroll:${action.direction || 'down'}:${action.amount || 600}`;
    case 'activate_tab':
      return `activate_tab:${action.tab_id || action.index || 0}`;
    case 'wait':
      return `wait:${action.ms || 1000}`;
    case 'done':
      return `done:${action.reason}`;
    case 'fail':
      return `fail:${action.reason}`;
  }
}

export async function observePageDOM(tabId: string): Promise<AgentObservation> {
  return new Promise(async (resolve, reject) => {
    const eventName = `page-content-tab-${tabId}`;
    let unlisten: (() => void) | null = null;
    console.log(`[OBSERVE-START] tabId=${tabId} event=${eventName}`);

    const timeout = setTimeout(() => {
      if (unlisten) unlisten();
      console.log(`[OBSERVE-TIMEOUT] tabId=${tabId}`);
      reject(new Error('Page observation timed out after 10 seconds'));
    }, 10000);

    unlisten = await listen<string>(eventName, (event: TauriEvent<string>) => {
      console.log(`[OBSERVE-EVENT-RECEIVED] event=${eventName} payloadLen=${event.payload.length}`);
      if (event.payload.startsWith('ARIA_AGENT_OBSERVATION:')) {
        clearTimeout(timeout);
        if (unlisten) unlisten();
        try {
          const data = JSON.parse(event.payload.substring('ARIA_AGENT_OBSERVATION:'.length));
          console.log(`[OBSERVE-RESOLVED] tabId=${tabId} elementCount=${data.elements ? data.elements.length : 0}`);
          resolve(data);
        } catch (e) {
          reject(e);
        }
      } else if (event.payload.startsWith('ARIA_AGENT_OBSERVATION_ERROR:')) {
        clearTimeout(timeout);
        if (unlisten) unlisten();
        reject(new Error(event.payload.substring('ARIA_AGENT_OBSERVATION_ERROR:'.length)));
      }
    });

    try {
      await invoke('eval_tab_webview', { webviewLabel: `tab-${tabId}`, js: observationScript });
    } catch (e) {
      clearTimeout(timeout);
      if (unlisten) unlisten();
      reject(e);
    }
  });
}

export async function executeDomAction(
  tabId: string,
  action: Exclude<AgentAction, { action: 'navigate' | 'activate_tab' | 'wait' | 'done' | 'fail' }>,
  targetRect?: ElementRect
): Promise<ActionResult> {
  return new Promise(async (resolve) => {
    const eventName = `page-content-tab-${tabId}`;
    let unlisten: (() => void) | null = null;
    let resolved = false;

    const safeResolve = (result: ActionResult) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      clearTimeout(fallbackTimeout);
      if (unlisten) unlisten();
      resolve(result);
    };

    const timeout = setTimeout(() => {
      console.log(`[AGENT TRACE] EXECUTOR_TIMEOUT action=${action.action} tabId=${tabId}`);
      safeResolve({
        success: false,
        action: action.action,
        element_id: 'element_id' in action ? action.element_id : undefined,
        error: 'Action execution timed out'
      });
    }, 8000);

    const fallbackTimeout = setTimeout(async () => {
      if (resolved) return;
      try {
        const pollJs = `
          (function() {
            try {
              var r = window.__ARIA_AGENT_RESULT__;
              if (r) {
                delete window.__ARIA_AGENT_RESULT__;
                var rawStr = 'ARIA_AGENT_RESULT:' + JSON.stringify(r);
                var CHUNK_SIZE = 600;
                var total = Math.ceil(rawStr.length / CHUNK_SIZE) || 1;
                var msgId = 'msg_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now().toString(36);

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
            } catch(e) {}
          })();
        `;
        await invoke('eval_tab_webview', { webviewLabel: `tab-${tabId}`, js: pollJs });
      } catch (e) {}
    }, 1500);

    unlisten = await listen<string>(eventName, (event: TauriEvent<string>) => {
      if (event.payload.startsWith('ARIA_AGENT_RESULT:')) {
        try {
          const data: ActionResult = JSON.parse(event.payload.substring('ARIA_AGENT_RESULT:'.length));
          safeResolve(data);
        } catch (e) {
          safeResolve({
            success: false,
            action: action.action,
            element_id: 'element_id' in action ? action.element_id : undefined,
            error: `IPC result parse error: ${String(e)}`
          });
        }
      }
    });

    try {
      const js = executionScript(action, targetRect);
      await invoke('eval_tab_webview', { webviewLabel: `tab-${tabId}`, js });
    } catch (e) {
      safeResolve({
        success: false,
        action: action.action,
        element_id: 'element_id' in action ? action.element_id : undefined,
        error: `eval_tab_webview failed: ${String(e)}`
      });
    }
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * DOM Settling helper:
 * Allows reasonable time for the browser and network stack to process navigation, layout, and rendering.
 */
export async function waitForPageSettled(
  _tabId: string,
  options?: { expectedUrl?: string; timeoutMs?: number }
): Promise<void> {
  const waitTime = Math.min(options?.timeoutMs ?? 1000, 4000);
  await sleep(waitTime);
}

function cleanSearchQuery(q: string): string {
  return q
    .replace(/^(?:the\s+first\s+video\s*(?:about|on|related to|of|for)?\s*)/i, '')
    .replace(/^(?:videos?\s*(?:about|on|related to|of|for)?\s*)/i, '')
    .replace(/(?:video|videos)\s*$/i, '')
    .trim();
}

export function extractYouTubeQuery(goal: string): string | null {
  const lower = goal.toLowerCase().trim();
  if (!lower.includes('youtube')) return null;

  // 1. "open youtube and (play/watch/search/find) [the first video (about/related to)] X"
  const m1 = lower.match(/(?:open|go to|visit)\s+youtube(?:\.com)?\s*(?:and|,|then)\s*(?:play|watch|listen to|search for|search|find)\s*(.+)/i);
  if (m1 && m1[1]) return cleanSearchQuery(m1[1]);

  // 2. "(play/watch/listen to/search for/search/find) [the first video (about/related to)] X (on/in/at) youtube"
  const m2 = lower.match(/(?:play|watch|listen to|search for|search|find)\s*(.+?)\s+(?:on|in|at|from)\s+youtube/i);
  if (m2 && m2[1]) return cleanSearchQuery(m2[1]);

  // 3. "youtube (search/play/find) X"
  const m3 = lower.match(/^youtube(?:\.com)?\s+(?:search|play|find|watch)?\s*(.+)/i);
  if (m3 && m3[1]) return cleanSearchQuery(m3[1]);

  return null;
}

/**
 * Smart Navigation Fast-Path:
 * Resolves explicit domain queries (e.g., "Open flexbaba website and...", "Open flexbaba.com", "Go to github.com")
 * or full URLs without consuming an extra LLM roundtrip.
 */
export function extractDirectDomain(goal: string): string | null {
  const lower = goal.toLowerCase().trim();

  // If extractYouTubeQuery matched a specific video/search query, let extractYouTubeQuery handle it
  if (extractYouTubeQuery(goal)) {
    return null;
  }

  // Direct full URL provided in goal: e.g. "https://learning.ccbp.in/...", "open https://learning.ccbp.in/"
  const urlMatch = goal.match(/https?:\/\/[^\s,]+/i);
  if (urlMatch) {
    return urlMatch[0];
  }

  // Exclude search queries handled by search fast path
  if (lower.startsWith('search ') || lower.startsWith('google ') || lower.startsWith('look up ')) {
    return null;
  }

  // Direct YouTube homepage: "open youtube", "open youtube.com", "go to youtube", "visit youtube"
  if (/^(?:open|go to|visit|navigate to)\s+(?:the\s+)?youtube(?:\.com)?(?:\s+(?:website|site|webpage|app))?$/i.test(lower)) {
    return 'https://www.youtube.com';
  }

  // 1. "open/go to/visit [the] <name> (website|site|webpage|app)..."
  // Example: "Open the flexbaba website and play the spiderman movie", "Open flexbaba website"
  const m1 = lower.match(/^(?:open|go to|visit|navigate to)\s+(?:the\s+)?([a-zA-Z0-9.-]+(?:\.[a-zA-Z]{2,})?)\s*(?:website|site|webpage|app|platform)/i);
  if (m1 && m1[1]) {
    const raw = m1[1].trim();
    if (!raw.includes('.') && raw.length > 2) {
      return `https://${raw}.com`;
    }
    return normalizeAgentUrl(raw);
  }

  // 2. Explicit domain with extension (including subdomains): "open learning.ccbp.in", "visit github.com", "go to netflix.com"
  const m2 = lower.match(/^(?:open|go to|visit|navigate to)\s+(?:the\s+)?([a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?:\/[^\s,]*)?)/i);
  if (m2 && m2[1]) {
    return normalizeAgentUrl(m2[1].trim());
  }

  return null;
}

/** Detects if the user goal is to answer questions, complete an assessment, or solve a quiz */
export function isQuizOrAssessmentGoal(goal: string): boolean {
  const lower = goal.toLowerCase();
  return (
    lower.includes('answer all') ||
    lower.includes('answer the question') ||
    lower.includes('solve all the question') ||
    lower.includes('solve quiz') ||
    lower.includes('solve assessment') ||
    lower.includes('solve mcq') ||
    lower.includes('complete the practice') ||
    lower.includes('daily practice') ||
    lower.includes('quiz solver')
  );
}

function verifyAction(
  prevObs: AgentObservation | null,
  action: AgentAction,
  newObs: AgentObservation
): { verified: boolean; message: string } {
  if (!prevObs) return { verified: true, message: 'Initial observation recorded.' };

  if (action.action === 'type') {
    const matchedEl = newObs.elements.find((e) => e.id === action.element_id);
    if (matchedEl && matchedEl.value !== undefined) {
      if (matchedEl.value.toLowerCase().includes(action.text.toLowerCase())) {
        return {
          verified: true,
          message: `Verified: Typed "${matchedEl.value}".`
        };
      }
    }
    return {
      verified: true,
      message: `Typed text into '${action.element_id}'.`
    };
  }

  if (action.action === 'type_and_submit') {
    if (newObs.url !== prevObs.url || newObs.title !== prevObs.title) {
      return { verified: true, message: `Verified: Submitted search "${action.text}" and navigated to ${newObs.url}.` };
    }
    const matchedEl = newObs.elements.find((e) => e.id === action.element_id);
    if (matchedEl && matchedEl.value && matchedEl.value.toLowerCase().includes(action.text.toLowerCase())) {
      return { verified: true, message: `Verified: Typed and submitted "${action.text}".` };
    }
    return { verified: true, message: `Executed search for "${action.text}".` };
  }

  if (action.action === 'navigate') {
    if (newObs.url !== prevObs.url || newObs.title !== prevObs.title) {
      return { verified: true, message: `Verified navigation: Page loaded URL ${newObs.url} (${newObs.title}).` };
    }
    return { verified: false, message: `Navigation to ${action.url} did NOT change the page. Current URL: ${newObs.url}. Try navigating again.` };
  }

  if (action.action === 'click' || action.action === 'press') {
    if (newObs.url !== prevObs.url) {
      return { verified: true, message: `Verified: Action '${action.action}' navigated to ${newObs.url}.` };
    }
    if (newObs.title !== prevObs.title) {
      return { verified: true, message: `Verified: Action '${action.action}' changed page title to "${newObs.title}".` };
    }
    if (Math.abs(newObs.elements.length - prevObs.elements.length) > 0 || newObs.text !== prevObs.text) {
      return { verified: true, message: `Verified: Action '${action.action}' updated page content.` };
    }
    return { verified: true, message: `Action '${action.action}' completed.` };
  }

  return { verified: true, message: `Action '${action.action}' completed.` };
}

export async function runAgentLoop(
  goal: string,
  initialTabId: string,
  settings: BrowserSettings,
  callbacks: AgentLoopCallbacks
): Promise<void> {
  const runId = 'run-' + Math.random().toString(36).substring(2, 9);
  activeGlobalRunId = runId;
  activeControlledTabId = initialTabId;

  let currentStep = 0;
  const maxSteps = 100;
  let controlledTabId = initialTabId;
  let previousObservation: AgentObservation | null = null;
  let previousObservationHash: string | null = null;
  let previousActionResult: string = 'None';
  let executedTypeWithoutSubmit = false;
  let failCount = 0;
  let lastFailedKey: string | null = null;
  let fastPathApplied = false;

  const actionHistory: {
    step: number;
    signature: string;
    action: AgentAction;
    result: string;
    verification: string;
  }[] = [];

  const log = (msg: string) => {
    console.log(msg);
    callbacks.onLog(msg);
  };

  log(`[AGENT TRACE] RUN_AGENT_LOOP runId=${runId} Goal: ${goal}`);

  try {
    while (currentStep < maxSteps) {
      if (activeGlobalRunId !== runId || callbacks.isCancelled()) {
        log(`[AGENT] run=${runId} Cancelled or superseded.`);
        callbacks.onFinish('Aborted', false);
        return;
      }

      while (callbacks.isPaused()) {
        if (activeGlobalRunId !== runId || callbacks.isCancelled()) {
          callbacks.onFinish('Aborted', false);
          return;
        }
        await sleep(200);
      }

      currentStep++;
      callbacks.onStatusUpdate(`Observing active page (Step ${currentStep})...`, currentStep);

      // Inject in-page status indicator into webview
      try {
        await invoke('eval_tab_webview', {
          webviewLabel: `tab-${controlledTabId}`,
          js: getInPageStatusScript(`Observing page (Step ${currentStep})...`, currentStep)
        });
      } catch (e) {}

      // 1. OBSERVE CURRENT PAGE
      let currentObservation: AgentObservation;
      try {
        currentObservation = await observePageDOM(controlledTabId);
      } catch (err: any) {
        const errMsg = `Page observation failed: ${err.message || String(err)}`;
        log(`[AGENT OBSERVATION ERROR] run=${runId} step=${currentStep} ${errMsg}`);
        callbacks.onStatusUpdate(errMsg, currentStep);
        callbacks.onFinish(errMsg, false);
        return;
      }

      const currentObservationHash = getObservationHash(currentObservation);

      log(`[AGENT STEP] runId=${runId} step=${currentStep} url=${currentObservation.url} title=${currentObservation.title} elements=${currentObservation.elements.length}`);

      // --- SMART FAST-PATH DETECTION (Step 1) ---
      if (currentStep === 1 && !fastPathApplied) {
        const lowerGoal = goal.toLowerCase().trim();

        // 1. YouTube Fast-Path (e.g. "open youtube and play ...", "search X on youtube")
        const ytQuery = extractYouTubeQuery(goal);

        // 2. Direct Domain Fast-Path (e.g. "open flexbaba website and...", "open github.com")
        const directDomain = !ytQuery ? extractDirectDomain(goal) : null;

        // 3. Google Search Fast-Path
        const googleMatch = !ytQuery && !directDomain && (lowerGoal.match(/(?:search for|search|google|find|look up)\s+(.+?)(?:\s+(?:on|in)\s+google|\s+online|\s+on\s+the\s+web)?$/i));

        let targetFastUrl: string | null = null;
        let fastLabel = '';

        if (ytQuery) {
          targetFastUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(ytQuery)}`;
          fastLabel = `YouTube search for "${ytQuery}"`;
        } else if (directDomain) {
          targetFastUrl = directDomain;
          fastLabel = `Direct navigation to ${directDomain}`;
        } else if (googleMatch && googleMatch[1] && (lowerGoal.startsWith('search') || lowerGoal.startsWith('google') || lowerGoal.startsWith('look up'))) {
          const query = googleMatch[1].trim();
          if (query.length > 1 && !query.includes('youtube')) {
            targetFastUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
            fastLabel = `Google search for "${query}"`;
          }
        }

        if (targetFastUrl) {
          log(`[AGENT FAST-PATH] Triggered: ${fastLabel} → ${targetFastUrl}`);
          fastPathApplied = true;

          callbacks.onStatusUpdate(`Fast-path: ${fastLabel}...`, currentStep);
          callbacks.onTimelineUpdate({
            id: crypto.randomUUID(),
            timestamp: new Date().toLocaleTimeString(),
            actionType: 'navigate',
            target: targetFastUrl,
            result: '',
            status: 'pending'
          });

          try {
            await invoke('navigate_tab_webview', {
              webviewLabel: `tab-${controlledTabId}`,
              url: targetFastUrl
            });
            await waitForPageSettled(controlledTabId, { expectedUrl: targetFastUrl, timeoutMs: 1200 });
            previousActionResult = `Success: Navigated to ${targetFastUrl}.`;
            actionHistory.push({
              step: currentStep,
              signature: `navigate:${targetFastUrl}:current_tab`,
              action: { action: 'navigate', url: targetFastUrl, target: 'current_tab' },
              result: 'success',
              verification: fastLabel
            });
            callbacks.onTimelineUpdate({
              id: crypto.randomUUID(),
              timestamp: new Date().toLocaleTimeString(),
              actionType: 'navigate',
              target: targetFastUrl,
              result: 'Success',
              status: 'success'
            });
            continue; // Re-observe new page
          } catch (err: any) {
            log(`[AGENT FAST-PATH] Navigation failed: ${err.message}`);
          }
        }
      }

      callbacks.onStatusUpdate('Planning next action...', currentStep);

      // Inject planning status into webview
      try {
        await invoke('eval_tab_webview', {
          webviewLabel: `tab-${controlledTabId}`,
          js: getInPageStatusScript(`Planning next action... (Step ${currentStep})`, currentStep)
        });
      } catch (e) {}

      // 2. BUILD COMPACT OBSERVATION & PROMPT FOR LLM
      const compactElements = currentObservation.elements.slice(0, 150).map(el => {
        const item: Record<string, any> = { id: el.id, tag: el.tag };
        if (el.role && el.role !== el.tag) item.role = el.role;
        if (el.type) item.type = el.type;
        if (el.name) item.name = el.name.slice(0, 80);
        if (el.text && el.text !== el.name) item.text = el.text.slice(0, 80);
        if (el.placeholder) item.placeholder = el.placeholder.slice(0, 40);
        if (el.value) item.value = el.value.slice(0, 60);
        if (el.href) item.href = el.href.slice(0, 80);
        if (el.checked !== undefined) item.checked = el.checked;
        if (el.enabled === false) item.enabled = false;
        return item;
      });

      const compactObservation = {
        url: currentObservation.url,
        title: currentObservation.title,
        text: currentObservation.text.slice(0, 3500),
        elements: compactElements
      };

      const systemPrompt = `You are ARIA, an expert autonomous browser AI agent. You control a real browser window to achieve the user's goal step-by-step.
Your ONLY allowed output is a single JSON action object. Never output markdown, explanations, or commentary.

Allowed Actions:
- {"action": "click", "element_id": "<id>"}
- {"action": "type", "element_id": "<id>", "text": "<text>"}
- {"action": "type_and_submit", "element_id": "<id>", "text": "<text>"}
- {"action": "select", "element_id": "<id>", "value": "<val>"}
- {"action": "scroll", "direction": "down" | "up", "amount": 600}
- {"action": "press", "element_id": "<id>", "key": "Enter" | "Tab" | "Escape"}
- {"action": "navigate", "url": "https://...", "target": "current_tab" | "new_tab"}
- {"action": "wait", "ms": 1000}
- {"action": "done", "reason": "<explanation of how the goal was achieved>"}
- {"action": "fail", "reason": "<explanation of failure>"}

CRITICAL RULES:
1. AUTONOMOUS TASK EXECUTION: Execute all required actions autonomously until the user's goal is fully achieved.
2. MULTI-QUESTION / QUIZ / MCQ / FORM TASKS:
   - Carefully read each question from the page text and observation elements.
   - Select the best/correct answer for each question by clicking the matching radio button, checkbox, or option element_id.
   - If questions or options extend below the fold, answer the visible ones and scroll down ({"action": "scroll", "direction": "down", "amount": 600}) to view and answer the rest.
   - For multi-page quizzes/forms with Next / Submit buttons, click "Next" or "Submit" after filling in all questions on the page.
   - Do NOT stop or call "done" until ALL questions/tasks are finished and submitted.
3. ELEMENT IDs: ONLY use element IDs from the latest observation snapshot (e1, e2, etc.).
4. SEARCH: When searching, use "type_and_submit" to enter the search term and submit in one action.
5. MEDIA / VIDEOS: To play/watch a video, click the actual video link element from the observation. Do not fabricate URLs.
6. COMPLETION: Only return "done" when the entire goal has been completed.`;

      const userPrompt = `Goal: ${goal}

Page Observation (Step ${currentStep}):
${JSON.stringify(compactObservation, null, 2)}

Recent Action History:
${JSON.stringify(actionHistory.slice(-5).map((h) => ({ step: h.step, action: h.signature, result: h.result })), null, 2)}

Previous Action Result:
${previousActionResult}`;

      let rawLlmResponse = '';
      try {
        const provider = await getActiveProvider(settings.aiProvider);
        if (!provider) throw new Error(`Provider '${settings.aiProvider}' not available`);
        const apiKey = await getApiKey(settings.aiProvider);

        const stream = provider.chat(
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          { model: settings.aiModel || '', apiKey: apiKey || undefined }
        );

        for await (const chunk of stream) {
          rawLlmResponse += chunk;
        }
      } catch (err: any) {
        const errMsg = `LLM call failed: ${err.message || String(err)}`;
        log(`[AGENT LLM ERROR] run=${runId} step=${currentStep} ${errMsg}`);
        callbacks.onStatusUpdate(errMsg, currentStep);
        callbacks.onFinish(errMsg, false);
        return;
      }

      // 3. PARSE & VALIDATE ACTION
      let action: AgentAction;
      try {
        const parsedJson = extractJsonFromText(rawLlmResponse);
        if (callbacks.onDebugData) {
          callbacks.onDebugData(rawLlmResponse, parsedJson);
        }
        const validation = validateAgentAction(parsedJson);
        if (!validation.success) {
          throw new Error(validation.error);
        }
        action = validation.data;
      } catch (err: any) {
        const parseErr = `Action parse error: ${err.message || String(err)}`;
        log(`[AGENT ACTION ERROR] run=${runId} step=${currentStep} ${parseErr}`);
        previousActionResult = `Failure: ${parseErr}`;
        callbacks.onStatusUpdate(`Invalid action received: ${err.message}`, currentStep);
        await sleep(150);
        continue;
      }

      // --- ANTI-HALLUCINATION & AUTO-CORRECTION FOR VIDEO PLAYBACK ---
      if (action.action === 'navigate') {
        const navUrl = action.url;
        if (navUrl && (navUrl.includes('youtube.com/watch') || navUrl.includes('youtu.be/'))) {
          const urlInObs = currentObservation.elements.some(e => e.href && (e.href.includes(navUrl) || navUrl.includes(e.href)));
          if (!urlInObs) {
            log(`[AGENT ANTI-HALLUCINATION] Detected fabricated video URL: ${navUrl}`);
            const realVideoEl = currentObservation.elements.find(e => e.role === 'video_link' || (e.href && e.href.includes('/watch?v=')));
            if (realVideoEl) {
              log(`[AGENT AUTO-CORRECT] Auto-correcting to click real video element ${realVideoEl.id} (${realVideoEl.name})`);
              action = { action: 'click', element_id: realVideoEl.id };
            } else {
              const blockMsg = `Cannot navigate to hallucinated video URL. You must click a video link from the search results.`;
              previousActionResult = `Failure: ${blockMsg}`;
              callbacks.onStatusUpdate('Blocked fake video URL', currentStep);
              await sleep(150);
              continue;
            }
          }
        }
      }

      // Auto-assist for media playback on search results:
      // If goal is to play a video and we are on YouTube search results, and observation contains video_link elements:
      // If LLM selected a non-video element (like clicking the search input or a filter button), redirect to click the 1st video!
      const lowerGoal = goal.toLowerCase();
      const isMediaPlayGoal = (lowerGoal.includes('play ') || lowerGoal.includes('watch ') || lowerGoal.includes('listen to')) && (lowerGoal.includes('youtube') || currentObservation.url.includes('youtube.com'));
      if (isMediaPlayGoal && currentObservation.url.includes('/results?search_query')) {
        const firstVideoEl = currentObservation.elements.find(e => e.role === 'video_link' || (e.href && e.href.includes('/watch?v=')));
        if (firstVideoEl) {
          const currentTargetId = 'element_id' in action ? action.element_id : undefined;
          const currentTargetEl = currentTargetId ? currentObservation.elements.find(e => e.id === currentTargetId) : undefined;
          if (currentTargetEl && currentTargetEl.role !== 'video_link' && !currentTargetEl.href?.includes('/watch?v=')) {
            log(`[AGENT AUTO-ASSIST] Redirected ${action.action}:${currentTargetId} to click top video result ${firstVideoEl.id} (${firstVideoEl.name})`);
            action = { action: 'click', element_id: firstVideoEl.id };
          }
        }
      }

      const actionSig = getActionSignature(action);
      const targetElementId = 'element_id' in action ? action.element_id : undefined;
      const targetEl = targetElementId ? currentObservation.elements.find((e) => e.id === targetElementId) : undefined;
      const targetName = targetEl?.name || targetEl?.text?.slice(0, 30) || targetEl?.placeholder || (targetElementId || ('url' in action ? action.url : ''));

      // 4. LOOP & IDENTICAL REPEATED ACTION GUARD
      const lastExecutedAction = actionHistory.length > 0 ? actionHistory[actionHistory.length - 1] : null;
      if (lastExecutedAction && lastExecutedAction.signature === actionSig && previousObservationHash === currentObservationHash) {
        // Recovery: If it was a link/video click, directly navigate to the link's href
        if (action.action === 'click' && targetEl?.href) {
          const destUrl = normalizeAgentUrl(targetEl.href);
          log(`[AGENT LOOP RECOVERY] Direct navigating to link href: ${destUrl}`);
          try {
            await invoke('navigate_tab_webview', {
              webviewLabel: `tab-${controlledTabId}`,
              url: destUrl
            });
            await waitForPageSettled(controlledTabId, { expectedUrl: destUrl, timeoutMs: 1200 });
            continue;
          } catch (e) {}
        }

        const loopErr = `Action '${actionSig}' was just executed on this identical page state and made no change. Choose a different element ID or action.`;
        log(`[AGENT LOOP GUARD] ${loopErr}`);
        previousActionResult = `Failure: ${loopErr}`;
        callbacks.onStatusUpdate(`Blocked repeated action: ${actionSig}`, currentStep);
        await sleep(150);
        continue;
      }

      // 5. VALIDATE ELEMENT ID
      if (targetElementId) {
        const exists = currentObservation.elements.some((el) => el.id === targetElementId);
        if (!exists) {
          const staleErr = `Element ID '${targetElementId}' does not exist in current page. Choose from latest snapshot.`;
          log(`[AGENT VALIDATION ERROR] ${staleErr}`);
          previousActionResult = `Failure: ${staleErr}`;
          callbacks.onStatusUpdate(`Element ${targetElementId} not found`, currentStep);
          await sleep(150);
          continue;
        }
      }

      const timelineId = crypto.randomUUID();
      const actionTarget = targetElementId || ('url' in action ? action.url : '');

      callbacks.onTimelineUpdate({
        id: timelineId,
        timestamp: new Date().toLocaleTimeString(),
        actionType: action.action,
        target: actionTarget,
        result: '',
        status: 'pending'
      });

      // 6. HANDLE DONE / FAIL
      if (action.action === 'done') {
        // Multi-step goal check
        if (currentStep === 1) {
          const isMultiStep = ['play ', 'watch ', 'search ', 'find ', 'buy ', 'order '].some(k => lowerGoal.includes(k));
          if (isMultiStep) {
            const earlyMsg = `Goal requires page interaction before finishing.`;
            log(`[AGENT GOAL CHECK] Premature done rejected on step 1`);
            previousActionResult = earlyMsg;
            callbacks.onTimelineUpdate({
              id: timelineId,
              timestamp: new Date().toLocaleTimeString(),
              actionType: 'done',
              target: action.reason,
              result: 'Premature done rejected',
              status: 'error'
            });
            await sleep(100);
            continue;
          }
        }

        if ((lowerGoal.includes('search') || lowerGoal.includes('google') || lowerGoal.includes('find')) && executedTypeWithoutSubmit) {
          const rejectMsg = `Search text was typed but not submitted. Press Enter or click search before finishing.`;
          previousActionResult = rejectMsg;
          callbacks.onTimelineUpdate({
            id: timelineId,
            timestamp: new Date().toLocaleTimeString(),
            actionType: 'done',
            target: action.reason,
            result: 'Search not submitted',
            status: 'error'
          });
          await sleep(100);
          continue;
        }

        if ((lowerGoal.includes('play ') || lowerGoal.includes('watch ')) && lowerGoal.includes('youtube')) {
          if (!currentObservation.url.toLowerCase().includes('youtube.com/watch')) {
            // If on search results page, click first video rather than rejecting
            const videoEl = currentObservation.elements.find(e => e.role === 'video_link' || (e.href && e.href.includes('/watch?v=')));
            if (videoEl) {
              log(`[AGENT AUTO-CLICK VIDEO] Video found in search results: ${videoEl.id}. Clicking to play.`);
              action = { action: 'click', element_id: videoEl.id };
            } else {
              const mediaRejectMsg = `Click on a video result to open the watch page before finishing.`;
              previousActionResult = mediaRejectMsg;
              callbacks.onTimelineUpdate({
                id: timelineId,
                timestamp: new Date().toLocaleTimeString(),
                actionType: 'done',
                target: action.reason,
                result: 'Not on video page',
                status: 'error'
              });
              await sleep(100);
              continue;
            }
          }
        }

        if (action.action === 'done') {
          log(`[AGENT TASK COMPLETE] Success: ${action.reason}`);
          callbacks.onTimelineUpdate({
            id: timelineId,
            timestamp: new Date().toLocaleTimeString(),
            actionType: 'done',
            target: action.reason,
            result: action.reason,
            status: 'success'
          });
          callbacks.onStatusUpdate(`Task completed: ${action.reason}`, currentStep);
          callbacks.onFinish(action.reason, true);
          return;
        }
      }

      if (action.action === 'fail') {
        log(`[AGENT TASK FAIL] ${action.reason}`);
        callbacks.onTimelineUpdate({
          id: timelineId,
          timestamp: new Date().toLocaleTimeString(),
          actionType: 'fail',
          target: action.reason,
          result: action.reason,
          status: 'error'
        });
        callbacks.onFinish(action.reason, false);
        return;
      }

      // 7. EXECUTE ACTION WITH LIVE VISUAL FEEDBACK
      let execResult: ActionResult = { success: false, action: action.action };

      // Emit visual event for React Shell overlay
      emitAgentVisualEvent({
        action: action.action as any,
        elementId: targetElementId,
        label: targetName,
        text: 'text' in action ? (action as any).text : undefined,
        key: 'key' in action ? (action as any).key : undefined,
        direction: 'direction' in action ? (action as any).direction : undefined,
        rect: targetEl?.rect,
        timestamp: Date.now()
      });

      // Real DOM Execution
      if (action.action === 'navigate') {
        try {
          const formattedUrl = normalizeAgentUrl(action.url);
          log(`[AGENT NAVIGATE] url=${formattedUrl}`);
          if (action.target === 'new_tab') {
            const newTabId = await callbacks.addTab(formattedUrl);
            controlledTabId = newTabId;
            activeControlledTabId = newTabId;
          } else {
            await invoke('navigate_tab_webview', {
              webviewLabel: `tab-${controlledTabId}`,
              url: formattedUrl
            });
          }
          await waitForPageSettled(controlledTabId, { expectedUrl: formattedUrl, timeoutMs: 1200 });
          execResult = { success: true, action: 'navigate' };
          executedTypeWithoutSubmit = false;
        } catch (err: any) {
          execResult = { success: false, action: 'navigate', error: err.message || String(err) };
        }
      } else if (action.action === 'activate_tab') {
        try {
          const tabs = callbacks.getTabs();
          let targetTabId = action.tab_id;
          if (!targetTabId && typeof action.index === 'number' && tabs[action.index]) {
            targetTabId = tabs[action.index].id;
          }
          if (targetTabId) {
            await callbacks.setActiveTabId(targetTabId);
            controlledTabId = targetTabId;
            activeControlledTabId = targetTabId;
            await waitForPageSettled(controlledTabId, { timeoutMs: 400 });
            execResult = { success: true, action: 'activate_tab' };
          } else {
            execResult = { success: false, action: 'activate_tab', error: 'Target tab not found' };
          }
        } catch (err: any) {
          execResult = { success: false, action: 'activate_tab', error: err.message || String(err) };
        }
      } else if (action.action === 'wait') {
        await sleep(Math.min(action.ms || 500, 2000));
        execResult = { success: true, action: 'wait' };
      } else if (action.action === 'click') {
        // Execute DOM action with in-page visual cursor and click ripple
        execResult = await executeDomAction(controlledTabId, action, targetEl?.rect);

        // If target element is a link with href, trigger direct webview navigation
        if (targetEl && targetEl.href && (targetEl.role === 'video_link' || targetEl.tag === 'a' || targetEl.href.includes('/watch?v='))) {
          const destUrl = normalizeAgentUrl(targetEl.href);
          log(`[AGENT CLICK LINK] Navigating webview to target href: ${destUrl}`);
          try {
            await invoke('navigate_tab_webview', {
              webviewLabel: `tab-${controlledTabId}`,
              url: destUrl
            });
            await waitForPageSettled(controlledTabId, { expectedUrl: destUrl, timeoutMs: 1200 });
          } catch (e) {}
        } else {
          await waitForPageSettled(controlledTabId, { timeoutMs: 300 });
        }
        executedTypeWithoutSubmit = false;
      } else if (action.action === 'type_and_submit') {
        // Execute compound search action (type + form/Enter submit in one go)
        execResult = await executeDomAction(controlledTabId, action, targetEl?.rect);
        executedTypeWithoutSubmit = false;
        await waitForPageSettled(controlledTabId, { timeoutMs: 1000 });
      } else {
        // type, press, select, scroll
        execResult = await executeDomAction(controlledTabId, action, targetEl?.rect);
        if (action.action === 'type') {
          executedTypeWithoutSubmit = true;
          await waitForPageSettled(controlledTabId, { timeoutMs: 100 });
        } else if (action.action === 'press') {
          executedTypeWithoutSubmit = false;
          await waitForPageSettled(controlledTabId, { timeoutMs: 400 });
        } else {
          await waitForPageSettled(controlledTabId, { timeoutMs: 150 });
        }
      }

      // 8. POST-ACTION OBSERVATION & VERIFICATION
      await waitForPageSettled(controlledTabId, { timeoutMs: 120 });
      let postObservation: AgentObservation;
      try {
        postObservation = await observePageDOM(controlledTabId);
      } catch (e) {
        postObservation = currentObservation;
      }

      const postObservationHash = getObservationHash(postObservation);
      const verification = verifyAction(previousObservation || currentObservation, action, postObservation);

      previousObservation = postObservation;
      previousObservationHash = postObservationHash;

      actionHistory.push({
        step: currentStep,
        signature: actionSig,
        action,
        result: execResult.success ? 'success' : 'error',
        verification: verification.message
      });

      if (execResult.success && verification.verified) {
        completeAgentVisualAction({ success: true });
        failCount = 0;
        lastFailedKey = null;
        previousActionResult = `Success: Executed ${actionSig}. ${verification.message}`;

        callbacks.onTimelineUpdate({
          id: timelineId,
          timestamp: new Date().toLocaleTimeString(),
          actionType: action.action,
          target: actionTarget,
          result: 'Success',
          status: 'success'
        });
      } else {
        const errReason = execResult.error || verification.message || 'Action failed';
        completeAgentVisualAction({ success: false, error: errReason });
        previousActionResult = `Failure: Executed ${actionSig} - ${errReason}`;

        callbacks.onTimelineUpdate({
          id: timelineId,
          timestamp: new Date().toLocaleTimeString(),
          actionType: action.action,
          target: actionTarget,
          result: errReason,
          status: 'error'
        });

        // Repeat failure guard
        const currentFailKey = actionSig;
        if (lastFailedKey === currentFailKey) {
          failCount++;
        } else {
          lastFailedKey = currentFailKey;
          failCount = 1;
        }

        if (failCount >= 2) {
          const repeatMsg = `Action '${actionSig}' failed consecutively: ${errReason}`;
          log(`[AGENT REPEAT FAILURE] ${repeatMsg}`);
          callbacks.onStatusUpdate(repeatMsg, currentStep);
          callbacks.onFinish(repeatMsg, false);
          return;
        }
      }
    }

    const maxStepsMsg = `Maximum agent steps reached (${maxSteps})`;
    callbacks.onStatusUpdate(maxStepsMsg, maxSteps);
    callbacks.onFinish(maxStepsMsg, false);
  } finally {
    if (activeGlobalRunId === runId) {
      activeGlobalRunId = null;
    }
    hideAgentCursor();
    if (controlledTabId) {
      invoke('eval_tab_webview', {
        webviewLabel: `tab-${controlledTabId}`,
        js: getInPageCleanupScript()
      }).catch(() => {});
    }
  }
}
