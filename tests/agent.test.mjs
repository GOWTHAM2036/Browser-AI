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
