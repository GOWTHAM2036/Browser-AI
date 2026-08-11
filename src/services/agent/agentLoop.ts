import { listen, Event as TauriEvent } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { AgentObservation, observationScript, ElementRect } from './observer';
import { AgentAction, validateAgentAction } from './actions';
import { executionScript, ActionResult } from './executor';
import { getActiveProvider, getApiKey } from '../ai';
import { normalizeAgentUrl } from '../agent';
import { extractJsonFromText } from '../utils';
import { BrowserSettings, Tab } from '../../types';

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

export function cancelActiveAgentRun(): void {
  activeGlobalRunId = null;
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

    const timeout = setTimeout(() => {
      if (unlisten) unlisten();
      reject(new Error('Page observation timed out after 8 seconds'));
    }, 8000);

    unlisten = await listen<string>(eventName, (event: TauriEvent<string>) => {
      if (event.payload.startsWith('ARIA_AGENT_OBSERVATION:')) {
        clearTimeout(timeout);
        if (unlisten) unlisten();
        try {
          const data = JSON.parse(event.payload.substring('ARIA_AGENT_OBSERVATION:'.length));
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

    // Primary timeout: 12s
    const timeout = setTimeout(() => {
      console.log(`[AGENT TRACE] EXECUTOR_TIMEOUT action=${action.action} tabId=${tabId} — IPC event never arrived`);
      safeResolve({
        success: false,
        action: action.action,
        element_id: 'element_id' in action ? action.element_id : undefined,
        error: 'Action execution timed out (no IPC response after 12s)'
      });
    }, 12000);

    // Fallback timeout: After 3s, try polling window.__ARIA_AGENT_RESULT__
    // This catches cases where the location.href IPC was blocked by CSP
    const fallbackTimeout = setTimeout(async () => {
      if (resolved) return;
      console.log(`[AGENT TRACE] EXECUTOR_FALLBACK_POLL attempting to read window.__ARIA_AGENT_RESULT__`);
      try {
        const pollJs = `
          (function() {
            try {
              var r = window.__ARIA_AGENT_RESULT__;
              if (r) {
                delete window.__ARIA_AGENT_RESULT__;
                location.href = 'https://tauri-ipc-bridge/data?payload=' + encodeURIComponent('ARIA_AGENT_RESULT:' + JSON.stringify(r));
              }
            } catch(e) {}
          })();
        `;
        await invoke('eval_tab_webview', { webviewLabel: `tab-${tabId}`, js: pollJs });
      } catch (e) {
        console.log(`[AGENT TRACE] EXECUTOR_FALLBACK_POLL_ERROR ${String(e)}`);
      }
    }, 3000);

    // Listen for IPC result event
    unlisten = await listen<string>(eventName, (event: TauriEvent<string>) => {
      if (event.payload.startsWith('ARIA_AGENT_RESULT:')) {
        console.log(`[AGENT TRACE] EXECUTOR_RESULT_RECEIVED via IPC`);
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

    // Build and inject execution script
    try {
      console.log(`[AGENT TRACE] EXECUTOR_SCRIPT_BUILT action=${action.action} target=${'element_id' in action ? action.element_id : 'N/A'}`);
      const js = executionScript(action, targetRect);
      console.log(`[AGENT TRACE] EXECUTOR_EVAL_SENT webviewLabel=tab-${tabId}`);
      await invoke('eval_tab_webview', { webviewLabel: `tab-${tabId}`, js });
      console.log(`[AGENT TRACE] EXECUTOR_EVAL_CONFIRMED (Rust accepted injection)`);
    } catch (e) {
      console.log(`[AGENT TRACE] EXECUTOR_EVAL_FAILED error=${String(e)}`);
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
          message: `Verified: Element '${action.element_id}' value updated to "${matchedEl.value}". Next step: submit the form or press Enter.`
        };
      }
    }
    return {
      verified: true,
      message: `Typed text into '${action.element_id}'. Verify next step (press Enter or click search).`
    };
  }

  if (action.action === 'navigate') {
    if (newObs.url !== prevObs.url || newObs.title !== prevObs.title) {
      return { verified: true, message: `Verified navigation: Page loaded URL ${newObs.url} (${newObs.title}).` };
    }
    return { verified: false, message: `Navigation to ${action.url} did NOT change the page. Current URL is still: ${newObs.url}. The navigation may have failed or the page hasn't loaded yet. Try the navigate action again.` };
  }

  if (action.action === 'click' || action.action === 'press') {
    if (newObs.url !== prevObs.url) {
      return { verified: true, message: `Verified: Action '${action.action}' caused navigation to ${newObs.url}.` };
    }
    if (newObs.title !== prevObs.title) {
      return { verified: true, message: `Verified: Action '${action.action}' changed page title to "${newObs.title}".` };
    }
    if (Math.abs(newObs.elements.length - prevObs.elements.length) > 0 || newObs.text !== prevObs.text) {
      return { verified: true, message: `Verified: Action '${action.action}' updated page content/DOM state.` };
    }
    return { verified: false, message: `Action '${action.action}' produced no observable page change.` };
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

  let currentStep = 0;
  const maxSteps = 20;
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
        log(`[AGENT] run=${runId} Cancelled or superseded by a new run.`);
        callbacks.onFinish('Aborted', false);
        return;
      }

      while (callbacks.isPaused()) {
        if (activeGlobalRunId !== runId || callbacks.isCancelled()) {
          callbacks.onFinish('Aborted', false);
          return;
        }
        await sleep(400);
      }

      currentStep++;
      callbacks.onStatusUpdate(`Observing active page (Step ${currentStep})...`, currentStep);

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

      log(`[AGENT TRACE] OBSERVATION_CREATED url=${currentObservation.url} title=${currentObservation.title} elements=${currentObservation.elements.length}`);
      log(`[AGENT STEP]
runId: ${runId}
step: ${currentStep}
GOAL: ${goal}
CURRENT URL: ${currentObservation.url}
CURRENT PAGE TITLE: ${currentObservation.title}
OBSERVATION HASH: ${currentObservationHash}`);

      // --- FAST-PATH: YouTube play/watch/search ---
      // Detect "play X on youtube" / "watch X on youtube" / "search X on youtube"
      // and skip directly to the search results URL instead of making the LLM
      // figure out navigate → find search box → type → press Enter
      if (currentStep === 1 && !fastPathApplied) {
        const lowerGoal = goal.toLowerCase();
        const ytMatch = lowerGoal.match(/(?:play|watch|listen to|search for|search|find)\s+(.+?)\s+(?:on|in|at)\s+youtube/i)
          || lowerGoal.match(/(?:play|watch|listen to)\s+(.+?)\s+(?:on|in)?\s*youtube/i);
        if (ytMatch && ytMatch[1]) {
          const query = ytMatch[1].trim();
          const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
          log(`[AGENT FAST-PATH] YouTube detected! query="${query}" → ${searchUrl}`);
          fastPathApplied = true;

          callbacks.onStatusUpdate(`Fast-path: Navigating to YouTube search for "${query}"...`, currentStep);
          callbacks.onTimelineUpdate({
            id: crypto.randomUUID(),
            timestamp: new Date().toLocaleTimeString(),
            actionType: 'navigate',
            target: searchUrl,
            result: '',
            status: 'pending'
          });

          try {
            await invoke('navigate_tab_webview', {
              webviewLabel: `tab-${controlledTabId}`,
              url: searchUrl
            });
            await sleep(2500);
            previousActionResult = `Success: Fast-path navigated to YouTube search results for "${query}". Now observe the results and click the first video.`;
            actionHistory.push({
              step: currentStep,
              signature: `navigate:${searchUrl}:current_tab`,
              action: { action: 'navigate', url: searchUrl, target: 'current_tab' },
              result: 'success',
              verification: 'Fast-path YouTube navigation'
            });
            callbacks.onTimelineUpdate({
              id: crypto.randomUUID(),
              timestamp: new Date().toLocaleTimeString(),
              actionType: 'navigate',
              target: searchUrl,
              result: 'Fast-path success',
              status: 'success'
            });
            continue; // Re-observe the new page
          } catch (err: any) {
            log(`[AGENT FAST-PATH] Navigation failed: ${err.message}`);
            // Fall through to normal LLM planning
          }
        }
      }

      callbacks.onStatusUpdate('Planning next action...', currentStep);

      // 2. BUILD PROMPT & CALL LLM
      // --- Build compact observation for LLM (strip rect, truncate text) ---
      const compactElements = currentObservation.elements.map(el => ({
        id: el.id,
        tag: el.tag,
        role: el.role !== el.tag ? el.role : undefined,
        type: el.type,
        name: el.name ? el.name.slice(0, 60) : undefined,
        text: el.text ? el.text.slice(0, 80) : undefined,
        placeholder: el.placeholder,
        value: el.value ? el.value.slice(0, 100) : undefined,
        href: el.href ? el.href.slice(0, 120) : undefined,
        enabled: el.enabled === false ? false : undefined
      }));
      // Strip undefined values to reduce token count
      const cleanElements = compactElements.map(el => {
        const clean: Record<string, any> = {};
        for (const [k, v] of Object.entries(el)) {
          if (v !== undefined) clean[k] = v;
        }
        return clean;
      });

      const compactObservation = {
        url: currentObservation.url,
        title: currentObservation.title,
        text: currentStep <= 2 ? currentObservation.text.slice(0, 2000) : undefined,
        elements: cleanElements
      };

      const systemPrompt = `You are a browser automation planner. You control a real web browser.

Your ONLY allowed output is a single JSON action object. Never output natural language, explanations, markdown, links, or conversational text.

Allowed Actions:
- {"action": "navigate", "url": "https://...", "target": "current_tab" | "new_tab"}
- {"action": "click", "element_id": "<id>"}
- {"action": "type", "element_id": "<id>", "text": "<text>"}
- {"action": "press", "element_id": "<id>", "key": "Enter"}
- {"action": "select", "element_id": "<id>", "value": "<val>"}
- {"action": "scroll", "direction": "down", "amount": 600}
- {"action": "activate_tab", "index": 0}
- {"action": "wait", "ms": 1000}
- {"action": "done", "reason": "<explanation>"}
- {"action": "fail", "reason": "<explanation>"}

CRITICAL RULES:
1. You MUST use element IDs from the LATEST observation snapshot only. Never invent element IDs.
2. If the user's goal requests opening or visiting a website, your FIRST action MUST be a "navigate" action with the full URL.
3. DO NOT repeat an action that has already succeeded in history unless the page state requires it.
4. After typing into a search input, your NEXT action MUST submit the search (press Enter or click the search button). Do NOT return done immediately after typing.
5. Only return "done" when the page observation PROVES the goal is achieved (e.g. URL changed to expected destination, search results visible, video playing).
6. Do NOT output explanations or natural language outside the JSON action.

ANTI-FABRICATION RULES:
7. You do NOT have access to current page contents or real URLs from your own knowledge. You MUST navigate and observe the actual page before claiming success.
8. NEVER fabricate a video ID, URL, search result, or page content. Every claim must be backed by the observation data provided.
9. For media goals (play/watch video): you must navigate to the site, search for the content, and click on the actual result from the observation. The done state requires the URL to contain a video/watch page.
10. NEVER return "done" on step 1 unless the goal was a simple navigation AND the observation confirms the URL changed.`;

      const userPrompt = `User Goal: ${goal}

Current Page Observation (Step ${currentStep}):
${JSON.stringify(compactObservation, null, 2)}

Action History:
${JSON.stringify(actionHistory.map((h) => ({ step: h.step, action: h.signature, result: h.result, verification: h.verification })), null, 2)}

Result of Previous Action:
${previousActionResult}`;

      let rawLlmResponse = '';
      try {
        log(`[AGENT TRACE] LLM_REQUEST provider=${settings.aiProvider} model=${settings.aiModel || 'default'}`);
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

      log(`[AGENT TRACE] LLM_RESPONSE raw=${rawLlmResponse.trim()}`);

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
        log(`[AGENT TRACE] ACTION_PARSED action=${JSON.stringify(action)}`);
      } catch (err: any) {
        const parseErr = `LLM action parsing error: ${err.message || String(err)}`;
        log(`[AGENT ACTION ERROR] run=${runId} step=${currentStep} ${parseErr}`);
        previousActionResult = `Failure: ${parseErr}`;
        callbacks.onStatusUpdate(`Invalid action received: ${err.message}`, currentStep);
        await sleep(1000);
        continue;
      }

      const actionSig = getActionSignature(action);

      // 4. CHECK IDENTICAL REPEATED ACTION / NO-PROGRESS GUARD
      const previousSameAction = actionHistory.find((h) => h.signature === actionSig);
      if (previousSameAction && previousObservationHash === currentObservationHash) {
        const loopErr = `Action '${actionSig}' was already executed in Step ${previousSameAction.step} and produced no observable page change. You MUST select a DIFFERENT action (e.g., 'press' key 'Enter' on input or 'click' on the search button).`;
        log(`[AGENT REPEATED ACTION BLOCKED] run=${runId} step=${currentStep} ${loopErr}`);
        previousActionResult = `Failure: ${loopErr}`;
        callbacks.onStatusUpdate(`Blocked repeated action: ${actionSig}`, currentStep);
        await sleep(1000);
        continue;
      }

      // 5. CHECK ELEMENT ID VALIDITY IN CURRENT OBSERVATION
      if ('element_id' in action && action.element_id) {
        const exists = currentObservation.elements.some((el) => el.id === action.element_id);
        if (!exists) {
          const staleErr = `Element ID '${action.element_id}' does not exist in the current page observation snapshot`;
          log(`[AGENT VALIDATION ERROR] run=${runId} step=${currentStep} ${staleErr}`);
          previousActionResult = `Failure: ${staleErr}. Please choose an element ID present in the latest observation.`;
          callbacks.onStatusUpdate(`Element ${action.element_id} not in current observation`, currentStep);
          await sleep(1000);
          continue;
        }
      }

      log(`[AGENT] run=${runId} step=${currentStep} LLM ACTION: ${JSON.stringify(action)}`);

      const timelineId = crypto.randomUUID();
      const actionTarget = 'element_id' in action && action.element_id ? action.element_id : ('url' in action ? action.url : '');

      callbacks.onTimelineUpdate({
        id: timelineId,
        timestamp: new Date().toLocaleTimeString(),
        actionType: action.action,
        target: actionTarget,
        result: '',
        status: 'pending'
      });

      // 6. HANDLE DONE / FAIL & GOAL VERIFICATION
      if (action.action === 'done') {
        const lowerGoal = goal.toLowerCase();

        // Block premature step-1 done for multi-step goals
        if (currentStep === 1) {
          const isMultiStep = ['play ', 'watch ', 'search ', 'search for ', 'find ', 'buy ', 'order ', 'book ', 'fill '].some(k => lowerGoal.includes(k));
          if (isMultiStep) {
            const earlyMsg = `Goal verification failed: Cannot declare done on step 1 for a multi-step goal. You must navigate, interact with the page, and verify the result before finishing.`;
            log(`[AGENT GOAL VERIFICATION REJECTED] run=${runId} step=${currentStep} ${earlyMsg}`);
            previousActionResult = earlyMsg;
            callbacks.onTimelineUpdate({
              id: timelineId,
              timestamp: new Date().toLocaleTimeString(),
              actionType: 'done',
              target: action.reason,
              result: 'Premature done rejected',
              status: 'error'
            });
            await sleep(300);
            continue;
          }
        }

        if ((lowerGoal.includes('search') || lowerGoal.includes('google') || lowerGoal.includes('find')) && executedTypeWithoutSubmit) {
          const rejectMsg = `Goal verification failed: Text was typed into the search box, but the search form has NOT been submitted yet. Please use action 'press' key 'Enter' or 'click' search button to submit the search before finishing.`;
          log(`[AGENT GOAL VERIFICATION REJECTED] run=${runId} step=${currentStep} ${rejectMsg}`);
          previousActionResult = rejectMsg;
          callbacks.onTimelineUpdate({
            id: timelineId,
            timestamp: new Date().toLocaleTimeString(),
            actionType: 'done',
            target: action.reason,
            result: 'Goal verification failed: search not submitted',
            status: 'error'
          });
          await sleep(300);
          continue;
        }

        // Media goal verification: require youtube.com/watch for play/watch goals
        if ((lowerGoal.includes('play ') || lowerGoal.includes('watch ')) && lowerGoal.includes('youtube')) {
          const currentUrl = currentObservation.url.toLowerCase();
          if (!currentUrl.includes('youtube.com/watch')) {
            const mediaRejectMsg = `Goal verification failed: Goal requires playing/watching a video on YouTube, but the current URL is ${currentObservation.url}. You must click on a video from the search results so the URL contains youtube.com/watch before declaring done.`;
            log(`[AGENT GOAL VERIFICATION REJECTED] run=${runId} step=${currentStep} ${mediaRejectMsg}`);
            previousActionResult = mediaRejectMsg;
            callbacks.onTimelineUpdate({
              id: timelineId,
              timestamp: new Date().toLocaleTimeString(),
              actionType: 'done',
              target: action.reason,
              result: 'Goal verification failed: not on video page',
              status: 'error'
            });
            await sleep(300);
            continue;
          }
        }

        // URL-based goal verification: if the goal mentions opening/visiting a specific site,
        // verify the current URL actually contains that domain before accepting 'done'
        const siteKeywords = ['youtube', 'github', 'twitter', 'reddit', 'facebook', 'instagram', 'linkedin', 'wikipedia', 'stackoverflow', 'amazon', 'netflix'];
        const mentionedSite = siteKeywords.find(site => lowerGoal.includes(site));
        if (mentionedSite && (lowerGoal.includes('open') || lowerGoal.includes('go to') || lowerGoal.includes('visit') || lowerGoal.includes('navigate'))) {
          const currentUrl = currentObservation.url.toLowerCase();
          if (!currentUrl.includes(mentionedSite)) {
            const navRejectMsg = `Goal verification failed: Goal requires navigating to ${mentionedSite}, but the current URL is ${currentObservation.url}. The page has NOT navigated to ${mentionedSite} yet. You must use the 'navigate' action with the full URL (e.g. https://www.${mentionedSite}.com) and wait for the page to load.`;
            log(`[AGENT GOAL VERIFICATION REJECTED] run=${runId} step=${currentStep} ${navRejectMsg}`);
            previousActionResult = navRejectMsg;
            callbacks.onTimelineUpdate({
              id: timelineId,
              timestamp: new Date().toLocaleTimeString(),
              actionType: 'done',
              target: action.reason,
              result: `Goal verification failed: not on ${mentionedSite}`,
              status: 'error'
            });
            await sleep(300);
            continue;
          }
        }

        log(`[AGENT] run=${runId} step=${currentStep} Goal verification: SUCCESS - ${action.reason}`);
        callbacks.onTimelineUpdate({
          id: timelineId,
          timestamp: new Date().toLocaleTimeString(),
          actionType: 'done',
          target: action.reason,
          result: action.reason,
          status: 'success'
        });
        log(`[AGENT TRACE] TASK_COMPLETE success=true result=${action.reason}`);
        callbacks.onStatusUpdate(`Task completed: ${action.reason}`, currentStep);
        callbacks.onFinish(action.reason, true);
        return;
      }

      if (action.action === 'fail') {
        log(`[AGENT] run=${runId} step=${currentStep} Task reported failure: ${action.reason}`);
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

      // 7. EXECUTE REAL BROWSER ACTION
      let execResult: ActionResult = { success: false, action: action.action };
      log(`[AGENT TRACE] EXECUTOR_CALLED action=${action.action} target=${actionTarget}`);

      if (action.action === 'navigate') {
        try {
          const formattedUrl = normalizeAgentUrl(action.url);
          log(`[AGENT TRACE] NAVIGATE_START url=${formattedUrl} target=${action.target || 'current_tab'} controlledTabId=${controlledTabId}`);
          if (action.target === 'new_tab') {
            const newTabId = await callbacks.addTab(formattedUrl);
            controlledTabId = newTabId;
            log(`[AGENT TRACE] NAVIGATE_NEW_TAB newTabId=${newTabId}`);
          } else {
            // Navigate directly via Tauri invoke using the controlled tab ID
            // instead of callbacks.navigateActiveTab which uses the store's activeTabId
            // (which may differ from the agent's controlledTabId)
            log(`[AGENT TRACE] NAVIGATE_INVOKE webviewLabel=tab-${controlledTabId} url=${formattedUrl}`);
            await invoke('navigate_tab_webview', {
              webviewLabel: `tab-${controlledTabId}`,
              url: formattedUrl
            });
          }
          // Wait for page to start loading
          await sleep(3000);
          // Verify the navigation actually happened by checking the URL
          try {
            const navCheckObs = await observePageDOM(controlledTabId);
            if (navCheckObs.url.includes(new URL(formattedUrl).hostname)) {
              log(`[AGENT TRACE] NAVIGATE_VERIFIED url=${navCheckObs.url}`);
              execResult = { success: true, action: 'navigate' };
            } else {
              log(`[AGENT TRACE] NAVIGATE_URL_MISMATCH expected=${formattedUrl} got=${navCheckObs.url}`);
              // Try navigation one more time
              log(`[AGENT TRACE] NAVIGATE_RETRY url=${formattedUrl}`);
              await invoke('navigate_tab_webview', {
                webviewLabel: `tab-${controlledTabId}`,
                url: formattedUrl
              });
              await sleep(3000);
              execResult = { success: true, action: 'navigate' };
            }
          } catch (obsErr) {
            log(`[AGENT TRACE] NAVIGATE_VERIFY_OBS_FAILED error=${String(obsErr)} — assuming navigation initiated`);
            execResult = { success: true, action: 'navigate' };
          }
          executedTypeWithoutSubmit = false;
        } catch (err: any) {
          log(`[AGENT TRACE] NAVIGATE_FAILED error=${err.message || String(err)}`);
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
            await sleep(1000);
            execResult = { success: true, action: 'activate_tab' };
          } else {
            execResult = { success: false, action: 'activate_tab', error: 'Target tab not found' };
          }
        } catch (err: any) {
          execResult = { success: false, action: 'activate_tab', error: err.message || String(err) };
        }
      } else if (action.action === 'wait') {
        await sleep(action.ms || 1000);
        execResult = { success: true, action: 'wait' };
      } else {
        // click, type, press, select, scroll
        const targetEl = 'element_id' in action && action.element_id ? currentObservation.elements.find((e) => e.id === action.element_id) : undefined;
        execResult = await executeDomAction(controlledTabId, action, targetEl?.rect);
        if (action.action === 'type') {
          executedTypeWithoutSubmit = true;
        } else if (action.action === 'press' || action.action === 'click') {
          executedTypeWithoutSubmit = false;
        }
      }

      // Emit real-time status for upcoming action
      if ('element_id' in action && action.element_id) {
        const targetEl = currentObservation.elements.find(e => e.id === action.element_id);
        const targetName = targetEl?.name || targetEl?.text?.slice(0, 30) || action.element_id;
        if (action.action === 'click') {
          callbacks.onStatusUpdate(`Clicking '${targetName}'...`, currentStep);
        } else if (action.action === 'type') {
          callbacks.onStatusUpdate(`Typing '${(action as any).text}' into '${targetName}'...`, currentStep);
        } else if (action.action === 'press') {
          callbacks.onStatusUpdate(`Pressing ${(action as any).key} on '${targetName}'...`, currentStep);
        }
      } else if (action.action === 'scroll') {
        callbacks.onStatusUpdate(`Scrolling ${(action as any).direction || 'down'}...`, currentStep);
      }

      log(`[AGENT TRACE] EXECUTOR_RESULT success=${execResult.success} action=${execResult.action}`);

      // 8. OBSERVE & VERIFY ACTION EFFECT
      await sleep(500);
      let postObservation: AgentObservation;
      try {
        postObservation = await observePageDOM(controlledTabId);
      } catch (e) {
        log(`[AGENT TRACE] POST_OBSERVATION_FAILED error=${String(e)} — using previous observation as fallback`);
        postObservation = currentObservation;
      }

      const postObservationHash = getObservationHash(postObservation);
      const verification = verifyAction(previousObservation || currentObservation, action, postObservation);

      log(`[AGENT STEP SUMMARY]
runId: ${runId}
step: ${currentStep}
LLM ACTION: ${actionSig}
TARGET: ${actionTarget}
EXECUTOR RESULT: ${JSON.stringify(execResult)}
POST-ACTION URL: ${postObservation.url}
POST-ACTION OBSERVATION HASH: ${postObservationHash}
VERIFICATION: ${verification.message}`);

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
        const errReason = execResult.error || verification.message || 'Action execution/verification failed';
        previousActionResult = `Failure: Executed ${actionSig} - ${errReason}`;

        callbacks.onTimelineUpdate({
          id: timelineId,
          timestamp: new Date().toLocaleTimeString(),
          actionType: action.action,
          target: actionTarget,
          result: errReason,
          status: 'error'
        });

        // Repeat failure tracking
        const currentFailKey = actionSig;
        if (lastFailedKey === currentFailKey) {
          failCount++;
        } else {
          lastFailedKey = currentFailKey;
          failCount = 1;
        }

        if (failCount >= 2) {
          const repeatMsg = `Stopping agent loop: Action '${actionSig}' failed twice consecutively (${errReason})`;
          log(`[AGENT REPEAT FAILURE] run=${runId} step=${currentStep} ${repeatMsg}`);
          callbacks.onStatusUpdate(repeatMsg, currentStep);
          callbacks.onFinish(repeatMsg, false);
          return;
        }
      }

      log(`[AGENT TRACE] LOOP_CONTINUE step=${currentStep}`);
    }

    const maxStepsMsg = `Maximum agent steps reached (${maxSteps})`;
    log(`[AGENT MAX STEPS] run=${runId} ${maxStepsMsg}`);
    callbacks.onStatusUpdate(maxStepsMsg, maxSteps);
    callbacks.onFinish(maxStepsMsg, false);
  } finally {
    if (activeGlobalRunId === runId) {
      activeGlobalRunId = null;
    }
  }
}
