import { spawnSync } from 'node:child_process';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2]
  ? resolve(process.argv[2])
  : fileURLToPath(new URL('../', import.meta.url));
const catalog = JSON.parse(await readFile(join(root, 'skills.json'), 'utf8'));
if (catalog.schema_version !== 1 || !Array.isArray(catalog.skills) || !catalog.skills.length) {
  throw new Error('Invalid skill catalog');
}
const tests = [];
const seen = new Set();
if ((await lstat(join(root, 'skills'))).isSymbolicLink()) {
  throw new Error('Skills container must be a local directory');
}

async function collect(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error('Test symlinks are not supported');
    if (entry.isDirectory()) await collect(join(directory, entry.name));
    else if (entry.isFile() && /\.test\.(?:mjs|cjs|js)$/.test(entry.name))
      tests.push(join(directory, entry.name));
  }
}

for (const entry of catalog.skills) {
  const path = entry.path;
  const match = typeof path === 'string' ? /^skills\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(path) : null;
  if (!match || match[1].length > 64 || seen.has(path)) {
    throw new Error('Invalid or duplicate skill path');
  }
  seen.add(path);
  const skill = join(root, path);
  if ((await lstat(skill)).isSymbolicLink() || !(await lstat(join(skill, 'SKILL.md'))).isFile()) {
    throw new Error('Skill must be a local directory with SKILL.md');
  }
  const directory = join(skill, 'tests');
  try {
    if ((await lstat(directory)).isSymbolicLink())
      throw new Error('Test symlinks are not supported');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await collect(directory);
}

if (!tests.length) {
  console.log('No Node skill tests; skipped.');
} else {
  tests.sort();
  // Files have been discovered beneath local, non-symlink skill directories.
  for (const test of tests) {
    const path = relative(root, test);
    if (path.startsWith('..') || isAbsolute(path)) throw new Error('Test path leaves repository');
  }
  // A caller may itself be a Node test. Inheriting its internal test context
  // can suppress this separate --test invocation and hide failures.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', ...tests], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    env,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
