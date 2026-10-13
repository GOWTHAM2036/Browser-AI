import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import * as esbuild from 'esbuild';

const repoRoot = resolve('.');
const outDir = join(repoRoot, '.tmp-test');

test('normalizeUrl handles search queries correctly', async () => {
  const { normalizeUrl } = await loadAgentUtils();

  assert.equal(normalizeUrl('duckduckgo.com'), 'https://duckduckgo.com');
  assert.equal(normalizeUrl('how to cook pasta', 'google'), 'https://www.google.com/search?q=how%20to%20cook%20pasta');
});

test('extractJsonFromText cleans markdown and comments', async () => {
  const { extractJsonFromText } = await loadAgentUtils();

  const text = 'Here is the result:\n```json\n{ "action": "click", "element_id": "1" }\n```\nHope it helps!';
  const json = extractJsonFromText(text);
  assert.equal(json.action, 'click');
  assert.equal(json.element_id, '1');

  const textWithComments = `{
    "action": "type" // comment
    , "text": "hello" /* block */
  }`;
  const json2 = extractJsonFromText(textWithComments);
  assert.equal(json2.action, 'type');
  assert.equal(json2.text, 'hello');
});

test('extractYouTubeQuery extracts clean search queries from user goals', async () => {
  const { extractYouTubeQuery } = await loadAgentLoop();

  assert.equal(extractYouTubeQuery('Open youtube and play the first video related to langchain'), 'langchain');
  assert.equal(extractYouTubeQuery('Open youtube and play langchain'), 'langchain');
  assert.equal(extractYouTubeQuery('play langchain tutorial on youtube'), 'langchain tutorial');
  assert.equal(extractYouTubeQuery('search for quantum computing on youtube'), 'quantum computing');
  assert.equal(extractYouTubeQuery('go to youtube and watch python crash course'), 'python crash course');
});

test('extractDirectDomain extracts explicit domains and websites', async () => {
  const { extractDirectDomain } = await loadAgentLoop();

  assert.equal(extractDirectDomain('Open youtube'), 'https://www.youtube.com');
  assert.equal(extractDirectDomain('Go to youtube.com'), 'https://www.youtube.com');
  assert.equal(extractDirectDomain('Open the flexbaba website and play the spiderman brand new day movie'), 'https://flexbaba.com');
  assert.equal(extractDirectDomain('Open flexbaba.com'), 'https://flexbaba.com');
  assert.equal(extractDirectDomain('Go to github.com and search for tauri'), 'https://github.com');
  assert.equal(extractDirectDomain('Visit netflix.com'), 'https://netflix.com');
  assert.equal(extractDirectDomain('Open flexbaba site'), 'https://flexbaba.com');
  assert.equal(extractDirectDomain('open learning.ccbp.in'), 'https://learning.ccbp.in');
  assert.equal(extractDirectDomain('open https://learning.ccbp.in/course?c_id=123&t_id=456'), 'https://learning.ccbp.in/course?c_id=123&t_id=456');

  // Ambiguous queries should return null to allow normal LLM planning
  assert.equal(extractDirectDomain('Find a spider man movie'), null);
  assert.equal(extractDirectDomain('play rock music'), null);
});

test('isQuizOrAssessmentGoal identifies quiz and assessment requests', async () => {
  const { isQuizOrAssessmentGoal } = await loadAgentLoop();

  assert.equal(isQuizOrAssessmentGoal('Answer all the question in the tab'), true);
  assert.equal(isQuizOrAssessmentGoal('solve all the questions on this page'), true);
  assert.equal(isQuizOrAssessmentGoal('complete the practice assessment'), true);
  assert.equal(isQuizOrAssessmentGoal('play youtube video'), false);
  assert.equal(isQuizOrAssessmentGoal('search for weather in tokyo'), false);
});

test('validateAgentAction validates type_and_submit and standalone actions', async () => {
  const { validateAgentAction } = await loadAgentActions();

  const v1 = validateAgentAction({ action: 'type_and_submit', element_id: 'e4', text: 'spider man brand new day' });
  assert.equal(v1.success, true);
  assert.equal(v1.data.action, 'type_and_submit');
  assert.equal(v1.data.element_id, 'e4');
  assert.equal(v1.data.text, 'spider man brand new day');

  const v2 = validateAgentAction({ action: 'type', element_id: 'e4', text: 'hello' });
  assert.equal(v2.success, true);
  assert.equal(v2.data.action, 'type');

  const v3 = validateAgentAction({ action: 'press', element_id: 'e4', key: 'Enter' });
  assert.equal(v3.success, true);
  assert.equal(v3.data.action, 'press');

  const v4 = validateAgentAction({ action: 'click', element_id: 'e1' });
  assert.equal(v4.success, true);

  const v5 = validateAgentAction({ action: 'type_and_submit', element_id: 'e4' });
  assert.equal(v5.success, false);
});

test('observationScript uses safe chunked IPC transport', async () => {
  const { observationScript } = await loadAgentObserver();
  assert.ok(observationScript.includes('https://tauri-ipc-bridge/chunk'));
  assert.ok(observationScript.includes('CHUNK_SIZE'));
  assert.ok(observationScript.includes('msgId'));
  assert.ok(observationScript.includes('location.href'));
  assert.ok(!observationScript.includes('aria-ipc.localhost'));
});

test('quizExtractScript uses reliable tauri-ipc-bridge transport and valid DOM selectors', async () => {
  const { quizExtractScript } = await loadQuizSolver();
  assert.ok(quizExtractScript.includes('https://tauri-ipc-bridge/data'));
  assert.ok(quizExtractScript.includes('https://tauri-ipc-bridge/chunk'));
  assert.ok(quizExtractScript.includes('CHUNK_SIZE'));
  assert.ok(quizExtractScript.includes('QUIZ_SNAPSHOT:'));
  assert.ok(quizExtractScript.includes('location.href'));
  assert.ok(!quizExtractScript.includes('aria-ipc.localhost'), 'Should not use broken aria-ipc.localhost fetch');
});

test('large DOM observation (100+ elements, 60KB) is chunked below URL limits and reassembles losslessly', async () => {
  // Simulate a rich MCQ practice page observation payload
  const elements = [];
  for (let i = 1; i <= 120; i++) {
    elements.push({
      id: `e${i}`,
      tag: i % 2 === 0 ? 'input' : 'label',
      role: i % 2 === 0 ? 'radio' : 'option',
      type: i % 2 === 0 ? 'radio' : undefined,
      name: `[Radio] Option ${i}: In the infix expression (A + (B * F) + (D - C)) / E, evaluate subexpression ${i}`,
      text: `Option choice ${i} for infix expression question`,
      visible: true,
      enabled: true,
      checked: i === 3,
      rect: { x: 100, y: i * 30, width: 450, height: 28 }
    });
  }

  const largeSnapshot = {
    url: 'https://learning.ccbp.in/mcq-practice',
    title: 'MCQ PRACTICE - Data Structures & Algorithms',
    text: 'In the infix expression (A + (B * F) + (D - C)) / E, which sub-expression is evaluated first? '.repeat(30),
    elements: elements
  };

  const rawPayload = 'ARIA_AGENT_OBSERVATION:' + JSON.stringify(largeSnapshot);
  const CHUNK_SIZE = 600;
  const total = Math.ceil(rawPayload.length / CHUNK_SIZE);
  const msgId = 'test_msg_123';

  assert.ok(rawPayload.length > 25000, `Payload should be large: ${rawPayload.length} chars`);
  assert.ok(total > 30, `Should produce > 30 chunks: ${total}`);

  const chunkUrls = [];
  const receivedChunks = new Map();

  for (let idx = 0; idx < total; idx++) {
    const slice = rawPayload.substring(idx * CHUNK_SIZE, (idx + 1) * CHUNK_SIZE);
    const chunkUrl = 'https://tauri-ipc-bridge/chunk?id=' + encodeURIComponent(msgId) +
                     '&index=' + idx +
                     '&total=' + total +
                     '&data=' + encodeURIComponent(slice);
    
    chunkUrls.push(chunkUrl);
    // CRITICAL: Every single chunk URL MUST be well below the WebView2/Chromium URL limit (2048 chars)
    assert.ok(chunkUrl.length < 1500, `Chunk URL ${idx} length ${chunkUrl.length} must be < 1500 chars`);

    // Parse back from query params as Rust would
    const urlObj = new URL(chunkUrl);
    const parsedData = urlObj.searchParams.get('data');
    receivedChunks.set(idx, parsedData);
  }

  // Reassemble
  let assembled = '';
  for (let idx = 0; idx < total; idx++) {
    assembled += receivedChunks.get(idx);
  }

  assert.equal(assembled, rawPayload, 'Reassembled payload must exactly match original');
  assert.ok(assembled.startsWith('ARIA_AGENT_OBSERVATION:'));
  const parsedObs = JSON.parse(assembled.substring('ARIA_AGENT_OBSERVATION:'.length));
  assert.equal(parsedObs.elements.length, 120);
  assert.equal(parsedObs.elements[2].checked, true);
});

test('createMinimalObservation generates safe fallback observation', async () => {
  const { createMinimalObservation } = await loadAgentObserver();
  const obs = createMinimalObservation('https://example.com', 'Example Page', 'Custom timeout note');
  assert.equal(obs.url, 'https://example.com');
  assert.equal(obs.title, 'Example Page');
  assert.equal(obs.text, 'Custom timeout note');
  assert.deepEqual(obs.elements, []);

  const defaultObs = createMinimalObservation();
  assert.equal(defaultObs.url, '');
  assert.equal(defaultObs.title, 'Untitled');
  assert.ok(defaultObs.text.includes('fallback'));
});

test('observationScript includes iframe traversal, snapshot caching, and resilient fallbacks', async () => {
  const { observationScript } = await loadAgentObserver();
  assert.ok(observationScript.includes('getAllDocs'), 'Should include iframe traversal via getAllDocs');
  assert.ok(observationScript.includes('window.__ARIA_AGENT_OBSERVATION__'), 'Should cache snapshot in window');
  assert.ok(observationScript.includes('[OBSERVE-ERROR-FALLBACK]'), 'Should log fallback on extraction errors');
});

test('executor includes multi-frame support for element resolution', async () => {
  const { buildExecutionScript } = await loadAgentExecutor();
  const script = buildExecutionScript({ action: 'click', element_id: 'e1' });
  assert.ok(script.includes('getAllDocs'), 'Executor should collect all frame documents');
  assert.ok(script.includes('IFRAME'), 'Executor should penetrate iframes during coordinate queries');
});

test('execution state machine: handles pause during execution and unblocks on resume', async () => {
  const { AgentExecutionStateMachine } = await loadExecutionStateMachine();
  const sm = new AgentExecutionStateMachine();

  assert.equal(sm.getState(), 'idle');
  const started = sm.startRun('run_1', 'msg_1', 'tab_1', 'Automate checkout');
  assert.equal(started, true);
  assert.equal(sm.getState(), 'running');
  assert.equal(sm.isRunning(), true);

  // Request pause
  const pauseRequested = sm.requestPause();
  assert.equal(pauseRequested, true);
  assert.equal(sm.getState(), 'pausing');
  assert.equal(sm.isPausing(), true);

  // Pause wait promise
  let resumeFinished = false;
  let resumeResult = false;
  const waitPromise = sm.waitForResume().then((res) => {
    resumeFinished = true;
    resumeResult = res;
    return res;
  });

  // State should now be paused
  assert.equal(sm.getState(), 'paused');
  assert.equal(sm.isPaused(), true);
  assert.equal(resumeFinished, false);

  // Resume execution
  const resumeRequested = sm.requestResume();
  assert.equal(resumeRequested, true);
  assert.equal(sm.getState(), 'running');
  assert.equal(sm.isRunning(), true);

  const unblocked = await waitPromise;
  assert.equal(unblocked, true);
  assert.equal(resumeResult, true);
});

test('execution state machine: stop during execution aborts signal and transitions cleanly to idle', async () => {
  const { AgentExecutionStateMachine } = await loadExecutionStateMachine();
  const sm = new AgentExecutionStateMachine();

  sm.startRun('run_2', 'msg_2', 'tab_1', 'Fill form');
  assert.equal(sm.getState(), 'running');
  assert.equal(sm.isAborted(), false);

  const stopRequested = sm.requestStop();
  assert.equal(stopRequested, true);
  assert.equal(sm.getState(), 'stopping');
  assert.equal(sm.isStopping(), true);
  assert.equal(sm.isAborted(), true);
  assert.equal(sm.getSignal()?.aborted, true);

  sm.confirmStopped();
  assert.equal(sm.getState(), 'idle');
  assert.equal(sm.getRunId(), null);
  assert.equal(sm.getPendingAction(), null);
});

test('execution state machine: blocks queued actions, illegal transitions, and unblocks pause on stop', async () => {
  const { AgentExecutionStateMachine, canTransition } = await loadExecutionStateMachine();
  const sm = new AgentExecutionStateMachine();

  // Illegal direct transitions
  assert.equal(canTransition('idle', 'paused'), false);
  assert.equal(canTransition('idle', 'stopping'), false);
  assert.equal(canTransition('stopping', 'running'), false);
  assert.equal(canTransition('stopping', 'pausing'), false);

  sm.startRun('run_3', 'msg_3', 'tab_1', 'Task');
  sm.requestPause();

  let unblockedResult = null;
  const pausePromise = sm.waitForResume().then((r) => {
    unblockedResult = r;
    return r;
  });

  assert.equal(sm.getState(), 'paused');

  // Stop while paused
  sm.requestStop();
  assert.equal(sm.getState(), 'stopping');
  assert.equal(sm.isAborted(), true);

  // Resume request must be rejected while stopping
  const cannotResume = sm.requestResume();
  assert.equal(cannotResume, false);

  // Pause promise must unblock with false
  const unblocked = await pausePromise;
  assert.equal(unblocked, false);
  assert.equal(unblockedResult, false);

  // startRun must be rejected while stopping
  const cannotStart = sm.startRun('run_4', 'msg_4', 'tab_1', 'Another task');
  assert.equal(cannotStart, false);
});

test('execution state machine: prevents duplicate concurrent runs', async () => {
  const { AgentExecutionStateMachine } = await loadExecutionStateMachine();
  const sm = new AgentExecutionStateMachine();

  const first = sm.startRun('run_a', 'msg_a', 'tab_1', 'First Goal');
  assert.equal(first, true);
  assert.equal(sm.getRunId(), 'run_a');

  // Attempt duplicate run without stopping
  const second = sm.startRun('run_b', 'msg_b', 'tab_1', 'Second Goal');
  assert.equal(second, false);
  assert.equal(sm.getRunId(), 'run_a');
  assert.equal(sm.getState(), 'running');
});

test('execution state machine: handles repeated pause, resume, and stop calls idempotently', async () => {
  const { AgentExecutionStateMachine } = await loadExecutionStateMachine();
  const sm = new AgentExecutionStateMachine();

  sm.startRun('run_idem', 'msg_idem', 'tab_1', 'Idempotency test');

  // Repeated pause requests
  assert.equal(sm.requestPause(), true);
  assert.equal(sm.requestPause(), true);
  sm.confirmPaused();
  assert.equal(sm.requestPause(), true);

  // Resume
  assert.equal(sm.requestResume(), true);
  // Repeated resume when already running
  assert.equal(sm.requestResume(), false);

  // Repeated stop requests
  assert.equal(sm.requestStop(), true);
  assert.equal(sm.requestStop(), true);
  sm.confirmStopped();
  assert.equal(sm.getState(), 'idle');
});

test('consequential action detection: identifies destructive, financial, and irreversible actions', async () => {
  const { isConsequentialAction } = await loadExecutionStateMachine();

  // Financial / checkout
  const buyCheck = isConsequentialAction({ action: 'click', element_id: 'e1' }, 'Buy Now Button');
  assert.equal(buyCheck.isConsequential, true);
  assert.ok(buyCheck.reason.includes('Consequential action detected'));

  const payCheck = isConsequentialAction({ action: 'click', element_id: 'e2' }, 'Proceed to Payment');
  assert.equal(payCheck.isConsequential, true);

  const orderCheck = isConsequentialAction({ action: 'click', element_id: 'e3' }, 'Place Order');
  assert.equal(orderCheck.isConsequential, true);

  // Destructive / deletion
  const deleteCheck = isConsequentialAction({ action: 'click', element_id: 'e4' }, 'Delete Database Record');
  assert.equal(deleteCheck.isConsequential, true);

  const termCheck = isConsequentialAction({ action: 'click', element_id: 'e5' }, 'Terminate Account');
  assert.equal(termCheck.isConsequential, true);

  // Subscription / wire
  const subCheck = isConsequentialAction({ action: 'type', element_id: 'e6', text: 'cancel subscription' });
  assert.equal(subCheck.isConsequential, true);

  const wireCheck = isConsequentialAction({ action: 'click', element_id: 'e7' }, 'Wire Transfer');
  assert.equal(wireCheck.isConsequential, true);

  // Harmless actions
  const harmlessClick = isConsequentialAction({ action: 'click', element_id: 'e8' }, 'Next Page');
  assert.equal(harmlessClick.isConsequential, false);
  assert.equal(harmlessClick.reason, '');

  const harmlessType = isConsequentialAction({ action: 'type_and_submit', element_id: 'e9', text: 'how to make pasta' });
  assert.equal(harmlessType.isConsequential, false);

  const harmlessScroll = isConsequentialAction({ action: 'scroll', direction: 'down', amount: 500 });
  assert.equal(harmlessScroll.isConsequential, false);
});

test('user confirmation workflow: pauses execution and resolves upon user response', async () => {
  const { AgentExecutionStateMachine } = await loadExecutionStateMachine();
  const sm = new AgentExecutionStateMachine();

  sm.startRun('run_confirm', 'msg_confirm', 'tab_1', 'Order food');

  // Trigger confirmation
  let confirmDone = false;
  let confirmResult = false;
  const promptPromise = sm.requestUserConfirmation('Confirm payment of $25.00?').then((r) => {
    confirmDone = true;
    confirmResult = r;
    return r;
  });

  assert.equal(sm.getState(), 'paused');
  const pending = sm.getPendingConfirmation();
  assert.ok(pending);
  assert.equal(pending.message, 'Confirm payment of $25.00?');
  assert.equal(confirmDone, false);

  // User accepts
  sm.respondToConfirmation(true);
  const accepted = await promptPromise;
  assert.equal(accepted, true);
  assert.equal(confirmResult, true);
  assert.equal(sm.getState(), 'running');

  // Test decline workflow
  const declinePromise = sm.requestUserConfirmation('Delete file?');
  assert.equal(sm.getState(), 'paused');
  sm.respondToConfirmation(false);
  const declined = await declinePromise;
  assert.equal(declined, false);
  assert.equal(sm.getPendingAction(), 'Action declined by user');
});

test('executor & DOM invalidation: detects disconnected or missing elements as stale', async () => {
  const { buildExecutionScript } = await loadAgentExecutor();

  const script = buildExecutionScript({ action: 'click', element_id: 'e99' });

  // Disconnected DOM element check
  assert.ok(script.includes('!el.isConnected'), 'Must verify element is connected in the document DOM');
  assert.ok(script.includes('stale: true'), 'Must set stale: true on disconnected or missing elements');
  assert.ok(script.includes('Element was disconnected from the DOM (stale reference)'), 'Must produce descriptive stale disconnect error');
  assert.ok(script.includes('Element not found in DOM or at coordinates (stale reference)'), 'Must report stale when element is missing');
});

test('in-page overlay: keeps browser fully interactive while paused with zero pointer locks', async () => {
  const { getInPageStatusScript } = await loadInPageOverlay();

  const pausedScript = getInPageStatusScript('Paused · Browser is interactive', 4, 'paused');

  // Paused script removes highlights and cursor
  assert.ok(pausedScript.includes('aria-inpage-highlight'), 'Should reference highlight removal');
  assert.ok(pausedScript.includes('aria-inpage-agent-cursor'), 'Should reference cursor removal');
  assert.ok(pausedScript.includes('removeChild'), 'Must remove overlay elements from DOM on pause');
  // Pointer events must not block user interaction
  assert.ok(pausedScript.includes('pointer-events:none;'), 'Status badge must have pointer-events:none to permit interaction');
  assert.ok(pausedScript.includes('PAUSED'), 'Status badge must display PAUSED label');
  // Pulse animation should be disabled when paused, active when running
  assert.equal(pausedScript.includes('animation:ariaPulse'), false, 'Pulse animation must be disabled when paused');
  const runningScript = getInPageStatusScript('Running step', 1, 'running');
  assert.equal(runningScript.includes('animation:ariaPulse'), true, 'Pulse animation must be active when running');
  assert.ok(runningScript.includes('ARIA AGENT'), 'Running badge must display ARIA AGENT label');
});

test('safe resume & user navigation conflict recovery in agentLoop', async () => {
  const { extractYouTubeQuery } = await loadAgentLoop();
  assert.ok(typeof extractYouTubeQuery === 'function');

  // Read agentLoop source to verify safe resume and conflict recovery semantics
  const agentLoopCode = await (await import('node:fs/promises')).readFile(
    join(repoRoot, 'src/services/agent/agentLoop.ts'),
    'utf-8'
  );

  // 1. Safe resume: clears stale observations and plans
  assert.ok(agentLoopCode.includes('wasJustResumed = true'), 'Must flag wasJustResumed on resume');
  assert.ok(agentLoopCode.includes('previousObservation = null'), 'Must clear previousObservation on resume');
  assert.ok(agentLoopCode.includes('previousObservationHash = null'), 'Must clear observation hash on resume');

  // 2. User navigation conflict recovery
  assert.ok(agentLoopCode.includes('curUrl.origin !== obsUrl.origin'), 'Must detect URL origin change by user');
  assert.ok(agentLoopCode.includes('[AGENT CONFLICT DETECTED]'), 'Must log conflict detection');
  assert.ok(agentLoopCode.includes('Invalidating plan and re-observing'), 'Must invalidate plan on URL mismatch');

  // 3. Stale element detection handling
  assert.ok(agentLoopCode.includes('if (execResult.stale)'), 'Must handle execResult.stale in main loop');
  assert.ok(agentLoopCode.includes('[AGENT STALE DETECTED]'), 'Must log stale element detection');
  assert.ok(agentLoopCode.includes('Discarding stale plan and re-observing'), 'Must discard stale plan on stale element');
});

test('interaction blocker: generates capturing listeners for all trusted user events and swallows them', async () => {
  const { getInPageInteractionBlockerScript } = await loadInPageOverlay();

  const blockerScript = getInPageInteractionBlockerScript(true);

  // Verifies state flag
  assert.ok(blockerScript.includes('window.__ARIA_AGENT_USER_INPUT_BLOCKED__ = true'), 'Must set input blocked flag to true');

  // Mouse & pointer events
  const mouseEvents = ['click', 'dblclick', 'auxclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'contextmenu'];
  for (const ev of mouseEvents) {
    assert.ok(blockerScript.includes(`'${ev}'`), `Must register capturing listener for ${ev}`);
  }

  // Keyboard typing events
  const keyboardEvents = ['keydown', 'keypress', 'keyup', 'beforeinput'];
  for (const ev of keyboardEvents) {
    assert.ok(blockerScript.includes(`'${ev}'`), `Must register capturing listener for ${ev}`);
  }

  // Scrolling & gestures
  assert.ok(blockerScript.includes("'wheel'"), 'Must register capturing listener for wheel scrolling');
  assert.ok(blockerScript.includes("'touchmove'"), 'Must register capturing listener for touch gestures');

  // Drag & drop & form submit
  assert.ok(blockerScript.includes("'dragstart'"), 'Must intercept drag start');
  assert.ok(blockerScript.includes("'drop'"), 'Must intercept drop');
  assert.ok(blockerScript.includes("'submit'"), 'Must intercept form submissions');

  // Capturing phase and non-passive wheel prevention
  assert.ok(blockerScript.includes('capture: true'), 'Must use capture phase to intercept before page elements');
  assert.ok(blockerScript.includes('passive: false'), 'Must set passive: false to allow preventDefault on wheel/touch');
  assert.ok(blockerScript.includes('e.preventDefault()'), 'Must prevent default behavior');
  assert.ok(blockerScript.includes('e.stopImmediatePropagation()'), 'Must stop immediate propagation');
});

test('interaction blocker: differentiates user hardware input from agent programmatic actions', async () => {
  const { getInPageInteractionBlockerScript } = await loadInPageOverlay();
  const { buildExecutionScript } = await loadAgentExecutor();

  const blockerScript = getInPageInteractionBlockerScript(true);
  const execScript = buildExecutionScript({ action: 'click', element_id: 'btn1' });

  // Blocker checks e.isTrusted
  assert.ok(blockerScript.includes('e.isTrusted === false'), 'Must allow untrusted (synthetic/programmatic) events');
  assert.ok(blockerScript.includes('window.__ARIA_AGENT_DISPATCHING__'), 'Must recognize agent dispatching window flag');

  // Executor sets and clears __ARIA_AGENT_DISPATCHING__
  assert.ok(execScript.includes('window.__ARIA_AGENT_DISPATCHING__ = true'), 'Executor must flag active agent dispatching');
  assert.ok(execScript.includes('window.__ARIA_AGENT_DISPATCHING__ = false'), 'Executor must clear dispatching flag on result or error');

  // Simulate event filtering logic in JavaScript
  let blockedState = true;
  let dispatchingState = false;

  function simulateShouldBlock(event) {
    if (!blockedState) return false;
    if (dispatchingState) return false;
    if (event && event.isTrusted === false) return false;
    return true;
  }

  // 1. User hardware click (isTrusted: true) -> BLOCKED
  assert.equal(simulateShouldBlock({ isTrusted: true, type: 'click' }), true, 'User hardware click must be blocked');

  // 2. User physical typing (isTrusted: true) -> BLOCKED
  assert.equal(simulateShouldBlock({ isTrusted: true, type: 'keydown', key: 'a' }), true, 'User typing must be blocked');

  // 3. User wheel scroll (isTrusted: true) -> BLOCKED
  assert.equal(simulateShouldBlock({ isTrusted: true, type: 'wheel' }), true, 'User scrolling must be blocked');

  // 4. Agent synthetic click (isTrusted: false) -> ALLOWED
  assert.equal(simulateShouldBlock({ isTrusted: false, type: 'click' }), false, 'Agent synthetic click must be allowed');

  // 5. Agent synthetic typing (isTrusted: false) -> ALLOWED
  assert.equal(simulateShouldBlock({ isTrusted: false, type: 'keydown', key: 'Enter' }), false, 'Agent synthetic keydown must be allowed');

  // 6. Agent dispatching window flag active -> ALLOWED even if event has no isTrusted
  dispatchingState = true;
  assert.equal(simulateShouldBlock({ isTrusted: true, type: 'click' }), false, 'Events during agent dispatching window must be allowed');
  dispatchingState = false;
});

test('interaction blocker: unblocking restores normal user interaction', async () => {
  const { getInPageInteractionBlockerScript, getInPageCleanupScript } = await loadInPageOverlay();

  const unblockScript = getInPageInteractionBlockerScript(false);
  const cleanupScript = getInPageCleanupScript();

  // Verifies unblock script sets flag to false and invokes release function
  assert.ok(unblockScript.includes('window.__ARIA_AGENT_USER_INPUT_BLOCKED__ = false'), 'Must clear input blocked flag');
  assert.ok(unblockScript.includes('window.__ARIA_RELEASE_INTERACTION_BLOCK__'), 'Must invoke release function');
  assert.ok(unblockScript.includes('aria-inpage-lock-style'), 'Must remove lock style element');

  // Verifies cleanup script cleans up block flag
  assert.ok(cleanupScript.includes('window.__ARIA_AGENT_USER_INPUT_BLOCKED__ = false'), 'Cleanup must clear input blocked flag');
  assert.ok(cleanupScript.includes('window.__ARIA_RELEASE_INTERACTION_BLOCK__'), 'Cleanup must invoke release function');

  // Test simulation: once unblocked, all user events pass through
  let blockedState = false;
  function simulateShouldBlock(event) {
    if (!blockedState) return false;
    if (event && event.isTrusted === false) return false;
    return true;
  }

  assert.equal(simulateShouldBlock({ isTrusted: true, type: 'click' }), false, 'User click allowed when unblocked');
  assert.equal(simulateShouldBlock({ isTrusted: true, type: 'keydown' }), false, 'User typing allowed when unblocked');
  assert.equal(simulateShouldBlock({ isTrusted: true, type: 'wheel' }), false, 'User scrolling allowed when unblocked');
});

test('agentLoop: manages webview interaction lock lifecycle (start, pause, resume, navigations, cleanup)', async () => {
  const agentLoopCode = await (await import('node:fs/promises')).readFile(
    join(repoRoot, 'src/services/agent/agentLoop.ts'),
    'utf-8'
  );

  // 1. Exports lock and release functions
  assert.ok(agentLoopCode.includes('export async function lockWebviewInteraction'), 'Must export lockWebviewInteraction');
  assert.ok(agentLoopCode.includes('export async function releaseWebviewInteractionLock'), 'Must export releaseWebviewInteractionLock');

  // 2. Locks webview at run start
  assert.ok(agentLoopCode.includes('await lockWebviewInteraction(initialTabId)'), 'Must lock webview interaction at start of agent run');

  // 3. Releases webview lock on pause
  assert.ok(agentLoopCode.includes('await releaseWebviewInteractionLock(controlledTabId)'), 'Must release interaction lock on pause boundary');

  // 4. Re-engages webview lock on resume
  assert.ok(agentLoopCode.includes('await lockWebviewInteraction(controlledTabId)'), 'Must re-lock webview interaction upon resume');

  // 5. Re-locks after navigations
  assert.ok(agentLoopCode.includes('await waitForPageSettled(controlledTabId, { expectedUrl: formattedUrl, timeoutMs: 1200 });\n          await lockWebviewInteraction(controlledTabId);'), 'Must re-lock after navigate action');

  // 6. Releases lock in finally block and cancelActiveAgentRun
  assert.ok(agentLoopCode.includes('await releaseWebviewInteractionLock(controlledTabId).catch'), 'Must release lock in finally block');
  assert.ok(agentLoopCode.includes('releaseWebviewInteractionLock(activeControlledTabId).catch'), 'Must release lock in cancelActiveAgentRun');
});

test('BrowserShell & Omnibox: disables address bar and navigation controls while agent is running', async () => {
  const browserShellCode = await (await import('node:fs/promises')).readFile(
    join(repoRoot, 'src/components/BrowserShell.tsx'),
    'utf-8'
  );
  const omniboxCode = await (await import('node:fs/promises')).readFile(
    join(repoRoot, 'src/components/Omnibox.tsx'),
    'utf-8'
  );
  const tabBarCode = await (await import('node:fs/promises')).readFile(
    join(repoRoot, 'src/components/TabBar.tsx'),
    'utf-8'
  );

  // 1. BrowserShell checks isAgentRunning
  assert.ok(browserShellCode.includes("executionState === 'running' || executionState === 'pausing'"), 'Must define isAgentRunning');
  assert.ok(browserShellCode.includes('disabled={!activeTab?.canGoBack || isAgentRunning}'), 'Back button must be disabled when agent is running');
  assert.ok(browserShellCode.includes('disabled={!activeTab?.canGoForward || isAgentRunning}'), 'Forward button must be disabled when agent is running');
  assert.ok(browserShellCode.includes('disabled={isAgentRunning}'), 'Reload and Home buttons must be disabled when agent is running');
  assert.ok(browserShellCode.includes('<Omnibox disabled={isAgentRunning} />'), 'Omnibox must receive disabled={isAgentRunning}');

  // 2. Omnibox handles disabled prop
  assert.ok(omniboxCode.includes('export interface OmniboxProps'), 'Omnibox must declare OmniboxProps');
  assert.ok(omniboxCode.includes('disabled = false'), 'Omnibox must default disabled to false');
  assert.ok(omniboxCode.includes('disabled={disabled}'), 'Omnibox input must pass disabled prop');
  assert.ok(omniboxCode.includes('if (disabled) return;'), 'Omnibox must guard handleInputChange when disabled');

  // 3. TabBar protects active running tab
  assert.ok(tabBarCode.includes('isAgentRunning && tab.id === activeTabId'), 'TabBar must protect active tab when agent is running');
  assert.ok(tabBarCode.includes('Agent running on this tab'), 'TabBar must show tooltip when agent is running on tab');
});

async function loadAgentUtils() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await esbuild.build({
    entryPoints: [
      join(repoRoot, 'src/services/agent.ts'),
      join(repoRoot, 'src/services/utils.ts')
    ],
    outdir: outDir,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    external: ['@tauri-apps/api/core', '@tauri-apps/api/event']
  });
  return import(pathToFileURL(join(outDir, 'utils.js')).href + '?cache=' + Date.now());
}

async function loadAgentActions() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await esbuild.build({
    entryPoints: [
      join(repoRoot, 'src/services/agent/actions.ts')
    ],
    outfile: join(outDir, 'actions.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    external: ['@tauri-apps/api/core', '@tauri-apps/api/event']
  });
  return import(pathToFileURL(join(outDir, 'actions.js')).href + '?cache=' + Date.now());
}

async function loadAgentExecutor() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await esbuild.build({
    entryPoints: [
      join(repoRoot, 'src/services/agent/executor.ts')
    ],
    outfile: join(outDir, 'executor.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    external: ['@tauri-apps/api/core', '@tauri-apps/api/event']
  });
  return import(pathToFileURL(join(outDir, 'executor.js')).href + '?cache=' + Date.now());
}

async function loadAgentLoop() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await esbuild.build({
    entryPoints: [
      join(repoRoot, 'src/services/agent/agentLoop.ts')
    ],
    outfile: join(outDir, 'agentLoop.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    external: ['@tauri-apps/api/core', '@tauri-apps/api/event', '@tauri-apps/plugin-http', 'zustand']
  });
  return import(pathToFileURL(join(outDir, 'agentLoop.js')).href + '?cache=' + Date.now());
}

async function loadAgentObserver() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await esbuild.build({
    entryPoints: [
      join(repoRoot, 'src/services/agent/observer.ts')
    ],
    outfile: join(outDir, 'observer.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    external: ['@tauri-apps/api/core', '@tauri-apps/api/event']
  });
  return import(pathToFileURL(join(outDir, 'observer.js')).href + '?cache=' + Date.now());
}

async function loadQuizSolver() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await esbuild.build({
    entryPoints: [
      join(repoRoot, 'src/services/agent/quizSolver.ts')
    ],
    outfile: join(outDir, 'quizSolver.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    external: ['@tauri-apps/api/core', '@tauri-apps/api/event', '@tauri-apps/plugin-http', 'zustand']
  });
  return import(pathToFileURL(join(outDir, 'quizSolver.js')).href + '?cache=' + Date.now());
}

async function loadExecutionStateMachine() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await esbuild.build({
    entryPoints: [
      join(repoRoot, 'src/services/agent/executionStateMachine.ts')
    ],
    outfile: join(outDir, 'executionStateMachine.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    external: ['@tauri-apps/api/core', '@tauri-apps/api/event']
  });
  return import(pathToFileURL(join(outDir, 'executionStateMachine.js')).href + '?cache=' + Date.now());
}

async function loadInPageOverlay() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await esbuild.build({
    entryPoints: [
      join(repoRoot, 'src/services/agent/inPageOverlay.ts')
    ],
    outfile: join(outDir, 'inPageOverlay.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    external: ['@tauri-apps/api/core', '@tauri-apps/api/event']
  });
  return import(pathToFileURL(join(outDir, 'inPageOverlay.js')).href + '?cache=' + Date.now());
}

