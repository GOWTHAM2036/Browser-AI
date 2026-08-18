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

  assert.equal(extractDirectDomain('Open the flexbaba website and play the spiderman brand new day movie'), 'https://flexbaba.com');
  assert.equal(extractDirectDomain('Open flexbaba.com'), 'https://flexbaba.com');
  assert.equal(extractDirectDomain('Go to github.com and search for tauri'), 'https://github.com');
  assert.equal(extractDirectDomain('Visit netflix.com'), 'https://netflix.com');
  assert.equal(extractDirectDomain('Open flexbaba site'), 'https://flexbaba.com');

  // Ambiguous queries should return null to allow normal LLM planning
  assert.equal(extractDirectDomain('Find a spider man movie'), null);
  assert.equal(extractDirectDomain('play rock music'), null);
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
