import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const runner = fileURLToPath(new URL('../scripts/test-skills.mjs', import.meta.url));

async function fixture(t, names = ['first']) {
  const root = await mkdtemp(join(tmpdir(), 'skillloom-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of names) {
    await mkdir(join(root, name));
    await writeFile(join(root, name, 'SKILL.md'), '# Fixture');
  }
  await writeFile(join(root, 'skills.json'), JSON.stringify({ schema_version: 1,
    skills: names.map(path => ({ path, summary: 'Fixture' })) }));
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [runner, root], { encoding: 'utf8', shell: false });
}

test('instruction-only skills can skip Node tests', async t => {
  const result = run(await fixture(t));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /skipped/);
});

test('two skills and nested test directories are discovered', async t => {
  const root = await fixture(t, ['first', 'second']);
  for (const name of ['first', 'second']) {
    const directory = join(root, name, 'tests', 'nested');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'behavior.test.mjs'),
      `import test from 'node:test'; test('${name} behavior', () => {});`);
  }
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /first behavior/);
  assert.match(result.stdout, /second behavior/);
});

test('skill test failures fail the shared runner', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'first', 'tests'));
  await writeFile(join(root, 'first', 'tests', 'failure.test.cjs'),
    "require('node:test')('fixture failure', () => { throw new Error('Fixture failure'); });");
  assert.equal(run(root).status, 1);
});

test('catalog path traversal is rejected before running tests', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'skills.json'), JSON.stringify({ schema_version: 1,
    skills: [{ path: '../outside', summary: 'Fixture' }] }));
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid or duplicate skill path/);
});

test('malformed catalogs fail instead of silently skipping tests', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'skills.json'), JSON.stringify({ schema_version: 1, skills: [] }));
  assert.equal(run(root).status, 1);
});
