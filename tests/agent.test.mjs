import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import * as esbuild from 'esbuild';

const repoRoot = resolve('.');
const outDir = join(repoRoot, '.tmp-test');
const outFile = join(outDir, 'agent.js');

test('normalizeUrl handles search queries correctly', async () => {
  const { normalizeUrl } = await loadAgentModule();

  assert.equal(normalizeUrl('duckduckgo.com'), 'https://duckduckgo.com');
  assert.equal(normalizeUrl('how to cook pasta', 'google'), 'https://www.google.com/search?q=how%20to%20cook%20pasta');
});

test('extractJsonFromText cleans markdown and comments', async () => {
  const utils = await loadAgentModule();
  const { extractJsonFromText } = utils;

  const text = 'Here is the result:\\n```json\\n{ "action": "click", "id": "1" }\\n```\\nHope it helps!';
  const json = extractJsonFromText(text);
  assert.equal(json.action, 'click');
  assert.equal(json.id, '1');

  const textWithComments = `{
    "action": "type" // comment
    , "text": "hello" /* block */
  }`;
  try {
    const json2 = extractJsonFromText(textWithComments);
    assert.equal(json2.action, 'type');
    assert.equal(json2.text, 'hello');
  } catch (e) {
    console.log('DEBUG: textWithComments input:', JSON.stringify(textWithComments));
    throw e;
  }
});

async function loadAgentModule() {
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
  // Since esbuild output multiple files when multiple entry points are given and outdir is used
  // We need to point to the right one
  return import(pathToFileURL(join(outDir, 'utils.js')).href + '?cache=' + Date.now());
}
