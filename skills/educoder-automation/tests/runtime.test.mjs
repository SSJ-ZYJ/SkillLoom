import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {
  classifyVerdict,
  createScope,
  DEFAULT_LIMITS,
  DEFAULT_PLATFORM,
  installPageRuntime,
  latestReadPath,
  prepareFileSave,
  resolveNextUrl,
  waitForVerdict,
} from '../scripts/runtime.mjs';

// All traffic is fake. Native Fetch types exercise standard body/header semantics
// without contacting EduCoder or changing an account's evaluation records.
const fixture = {
  pageUrl: 'https://www.educoder.net/tasks/classroom/homework/demo/',
  myshixunId: 'repo-demo',
  gameId: 17,
  challengeId: 23,
  userId: 31,
  allowedPaths: ['src/first.java', 'src/second.java'],
};
const scope = createScope(fixture);
const taskUrl = `${DEFAULT_PLATFORM.apiOrigin}/api/tasks/demo.json?zzud=FAKE_SECRET`;
const saveUrl = `${DEFAULT_PLATFORM.apiOrigin}/api/myshixuns/repo-demo/update_file.json?zzud=FAKE_SECRET`;
const payload = (overrides = {}) => ({
  path: 'src/first.java',
  content: 'OLD',
  game_id: 17,
  evaluate: 7,
  tab_type: 9,
  extras: {
    challenge_id: '23',
    currentUserId: 31,
    homework_common_id: 'fixture-homework',
    exercise_id: 'fixture-exam',
    competition_entry_id: 'fixture-contest',
  },
  ...overrides,
});
const headers = () =>
  new Headers({
    'X-EDU-Signature': 'FAKE_SIGNATURE',
    'X-EDU-Timestamp': '1',
    'Pc-Authorization': 'FAKE_AUTHORIZATION',
    'Content-Type': 'application/json',
  });

function environment(options = {}) {
  const sent = [];
  const xhrSent = [];
  const originalFetch = async (input, init) => {
    const request = new Request(input, init);
    sent.push({
      url: request.url,
      method: request.method,
      body: await request.text(),
      headers: Object.fromEntries(request.headers),
      credentials: request.credentials,
    });
    if (options.networkError) throw new Error('fake_network_error');
    return (
      options.responseFactory?.() ??
      new Response(options.responseText ?? '{"ok":true}', { status: options.status ?? 200 })
    );
  };
  class FakeXHR extends EventTarget {
    open(method, url, ...options) {
      this.openArgs = [method, url, ...options];
      this.method = method.toUpperCase();
      this.url = String(url);
      this.headers = new Headers();
      this.responseType = '';
      this.status = 0;
    }
    setRequestHeader(name, value) {
      this.headers.append(name, value);
    }
    send(...args) {
      this.sendArgs = args;
      const [body] = args;
      xhrSent.push({
        method: this.method,
        url: this.url,
        body,
        headers: Object.fromEntries(this.headers),
      });
      this.status = options.status ?? 200;
      this.responseText = options.responseText ?? '{"ok":true}';
      this.response = JSON.parse(this.responseText);
      this.dispatchEvent(new Event('loadend'));
    }
  }
  const context = vm.createContext({
    window: { fetch: originalFetch, XMLHttpRequest: FakeXHR },
    location: new URL(fixture.pageUrl),
    URL,
    Request,
    Headers,
    TextDecoder,
    Date,
    config: { scope, limits: { ...DEFAULT_LIMITS, ...options.limits } },
  });
  const install = (nextScope = scope, limits = context.config.limits) => {
    context.config = { scope: nextScope, limits };
    // Serialize exactly as a page evaluator would: no module closures available.
    return vm.runInContext(`(${installPageRuntime.toString()})(config)`, context);
  };
  return {
    context,
    window: context.window,
    sent,
    xhrSent,
    originalFetch,
    FakeXHR,
    install,
    get runtime() {
      return context.window.__educoderAutomation;
    },
  };
}

async function settle(env) {
  for (let count = 0; count < 100; count++) {
    if (env.runtime.requests.every((record) => record.finishedAt != null)) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('fake response capture did not settle');
}

test('scope binds supported routes and rejects wrong origins, IDs and repository traversal', () => {
  assert.equal(scope.taskId, 'demo');
  assert.equal(createScope({ pageUrl: 'https://www.educoder.net/tasks/other/' }).taskId, 'other');
  assert.throws(() => createScope({ ...fixture, taskId: 'different' }), /task_id_mismatch/);
  assert.throws(
    () => createScope({ ...fixture, pageUrl: 'https://example.org/tasks/demo' }),
    /origin_mismatch/,
  );
  assert.throws(
    () => createScope({ ...fixture, pageUrl: 'https://www.educoder.net/tasks/a/demo' }),
    /unsupported/,
  );
  for (const path of [
    '../file',
    '/file',
    'src/../file',
    'src\\file',
    'src//file',
    'src/\0file',
    'src/\rfile',
    'src/\nfile',
  ]) {
    assert.throws(() => createScope({ ...fixture, allowedPaths: [path] }), /invalid_file_paths/);
    assert.throws(
      () => environment().install({ ...scope, allowedPaths: [path] }),
      /invalid_api_scope/,
    );
  }
});

test('navigation handles relative, absolute and final links without leaving the platform', () => {
  assert.equal(resolveNextUrl(null, fixture.pageUrl), null);
  assert.equal(
    resolveNextUrl('/tasks/next/', fixture.pageUrl),
    'https://www.educoder.net/tasks/next/',
  );
  assert.equal(
    resolveNextUrl('https://www.educoder.net/tasks/next', fixture.pageUrl),
    'https://www.educoder.net/tasks/next',
  );
  assert.throws(
    () => resolveNextUrl('//example.org/tasks/next', fixture.pageUrl),
    /origin_mismatch/,
  );
  assert.throws(() => resolveNextUrl('/login', fixture.pageUrl), /unsupported_task_route/);
  assert.throws(() => resolveNextUrl(fixture.pageUrl, fixture.pageUrl), /next_is_current/);
});

test('latest read evidence ignores older, foreign and unknown file requests', () => {
  const make = (task, path) => ({
    method: 'GET',
    url: `${DEFAULT_PLATFORM.apiOrigin}/api/tasks/${task}/rep_content.json?path=${encodeURIComponent(path)}`,
  });
  assert.equal(
    latestReadPath(
      [
        make('demo', 'src/first.java'),
        make('demo', 'src/second.java'),
        make('foreign', 'src/first.java'),
        make('demo', 'unknown.java'),
      ],
      scope,
    ),
    'src/second.java',
  );
  assert.equal(latestReadPath([], scope), null);
});

test('Headers, object and tuple headers capture credentials and complete request/response', async (t) => {
  for (const type of ['Headers', 'object', 'tuple']) {
    await t.test(type, async () => {
      const env = environment();
      env.install();
      const values = headers();
      const h =
        type === 'Headers' ? values : type === 'object' ? Object.fromEntries(values) : [...values];
      await env.window.fetch(taskUrl, { headers: h, credentials: 'include' });
      await settle(env);
      const record = env.runtime.requests[0];
      assert.equal(record.headers['x-edu-signature'], 'FAKE_SIGNATURE');
      assert.equal(record.headers['pc-authorization'], 'FAKE_AUTHORIZATION');
      assert.equal(record.method, 'GET');
      assert.equal(record.responseComplete, true);
      assert.deepEqual(JSON.parse(record.response), { ok: true });
      assert.equal(env.sent[0].credentials, 'include');
      const safe = JSON.stringify(env.runtime.snapshot());
      for (const secret of ['FAKE_SIGNATURE', 'FAKE_AUTHORIZATION', 'FAKE_SECRET'])
        assert.equal(safe.includes(secret), false);
    });
  }
});

test('empty content and Request-style bodies are replaced while other context is preserved', async (t) => {
  for (const type of ['url-init', 'Request', 'Request-with-init-override']) {
    await t.test(type, async () => {
      const env = environment();
      env.install();
      env.runtime.setSolutions({ 'src/first.java': '' });
      const init = {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(payload()),
        credentials: 'include',
      };
      if (type === 'url-init') await env.window.fetch(saveUrl, init);
      else if (type === 'Request') await env.window.fetch(new Request(saveUrl, init));
      else
        await env.window.fetch(new Request(saveUrl, { ...init, body: 'ignored' }), {
          body: init.body,
        });
      await settle(env);
      assert.deepEqual(JSON.parse(env.sent[0].body), payload({ content: '' }));
      assert.equal(env.runtime.swaps.length, 1);
      assert.equal(env.runtime.requests[0].headers['pc-authorization'], 'FAKE_AUTHORIZATION');
    });
  }
});

test('XHR captures method, all headers, patched body and response; re-open clears old headers', () => {
  const env = environment();
  env.install();
  env.runtime.setSolutions({ 'src/first.java': 'NEW' });
  const xhr = new env.FakeXHR();
  const openArgs = ['POST', saveUrl, false, 'fixture-user', 'fixture-password'];
  xhr.open(...openArgs);
  assert.deepEqual(xhr.openArgs, openArgs);
  for (const [name, value] of headers()) xhr.setRequestHeader(name, value);
  xhr.send(JSON.stringify(payload()));
  assert.equal(JSON.parse(env.xhrSent[0].body).content, 'NEW');
  assert.equal(env.runtime.requests[0].headers['pc-authorization'], 'FAKE_AUTHORIZATION');
  assert.equal(env.runtime.requests[0].responseComplete, true);
  xhr.open('GET', taskUrl);
  xhr.send();
  assert.equal(env.runtime.requests[1].method, 'GET');
  assert.equal(env.runtime.requests[1].headers['x-edu-signature'], undefined);
});

test('XHR supports JSON responses and records HTTP errors without reporting a pass', () => {
  const env = environment({ status: 403 });
  env.install();
  const xhr = new env.FakeXHR();
  xhr.open('GET', taskUrl);
  xhr.responseType = 'json';
  xhr.send();
  assert.equal(env.runtime.requests[0].status, 403);
  assert.equal(env.runtime.requests[0].responseComplete, true);
  assert.deepEqual(JSON.parse(env.runtime.requests[0].response), { ok: true });
});

test('repeated installation produces one capture; uninstall restores hooks and clears sensitive data', async () => {
  const env = environment();
  const open = env.FakeXHR.prototype.open;
  assert.equal(env.install().installed, true);
  assert.equal(env.install().installed, false);
  await env.window.fetch(taskUrl);
  await settle(env);
  assert.equal(env.runtime.requests.length, 1);
  const runtime = env.runtime;
  runtime.uninstall();
  assert.equal(env.window.fetch, env.originalFetch);
  assert.equal(env.FakeXHR.prototype.open, open);
  assert.equal(runtime.requests.length, 0);
  assert.equal(env.runtime, undefined);
  assert.throws(() => runtime.setSolutions({}), /runtime_uninstalled/);
});

test('changed scope replaces capture state and does not inherit armed solutions', () => {
  const env = environment();
  env.install();
  env.runtime.setSolutions({ 'src/first.java': 'NEW' });
  const old = env.runtime;
  const next = { ...scope, myshixunId: 'new-repo', gameId: '18' };
  assert.equal(env.install(next).installed, true);
  assert.equal(old.active, false);
  assert.notEqual(env.runtime, old);
  assert.equal(env.runtime.requests.length, 0);
});

test('uninstall leaves subsequent third-party hooks intact and makes the old wrapper inert', async () => {
  const env = environment();
  env.install();
  const previous = env.window.fetch;
  const next = (...args) => previous(...args);
  env.window.fetch = next;
  const runtime = env.runtime;
  runtime.uninstall();
  assert.equal(env.window.fetch, next);
  await env.window.fetch(taskUrl);
  assert.equal(runtime.requests.length, 0);
  assert.equal(runtime.errors[0].code, 'fetch_restore_conflict');
});

test('foreign hosts, experiments and similarly named endpoints are neither patched nor captured', async () => {
  const env = environment();
  env.install();
  env.runtime.setSolutions({ 'src/first.java': 'NEW' });
  const urls = [
    saveUrl.replace('data.educoder.net', 'example.org'),
    saveUrl.replace('repo-demo', 'different'),
    saveUrl.replace('update_file.json', 'update_file.json.extra'),
  ];
  for (const url of urls)
    await env.window.fetch(url, { method: 'POST', body: JSON.stringify(payload()) });
  assert.equal(env.runtime.requests.length, 0);
  for (const request of env.sent) assert.equal(JSON.parse(request.body).content, 'OLD');
  const xhr = new env.FakeXHR();
  xhr.open('GET', 'https://example.org/unrelated');
  xhr.send();
  assert.deepEqual(xhr.sendArgs, []);
  assert.equal(env.runtime.requests.length, 0);
});

test('invalid targeted saves are blocked before network transmission', async (t) => {
  for (const [name, body, error] of [
    ['wrong game', JSON.stringify(payload({ game_id: 99 })), /game_id_mismatch/],
    ['unknown path', JSON.stringify(payload({ path: 'unknown.java' })), /file_scope_mismatch/],
    [
      'wrong context',
      JSON.stringify(payload({ extras: { challenge_id: 999 } })),
      /save_context_mismatch/,
    ],
    ['invalid JSON', '{invalid', /invalid_save_json/],
    ['null JSON', 'null', /invalid_save_json/],
    ['array JSON', '[]', /invalid_save_json/],
  ]) {
    await t.test(name, async () => {
      const env = environment();
      env.install();
      env.runtime.setSolutions({ 'src/first.java': 'NEW' });
      await assert.rejects(env.window.fetch(saveUrl, { method: 'POST', body }), error);
      assert.equal(env.sent.length, 0);
      assert.equal(env.runtime.errors.length, 1);
    });
  }
});

test('uninspectable XHR save bodies do not silently send the old template', () => {
  const env = environment();
  env.install();
  env.runtime.setSolutions({ 'src/first.java': 'NEW' });
  const xhr = new env.FakeXHR();
  xhr.open('POST', saveUrl);
  assert.throws(() => xhr.send(new Blob([JSON.stringify(payload())])), /uninspectable_save_body/);
  assert.equal(env.xhrSent.length, 0);
});

test('SPA navigation blocks saves with the old scope until the new level is bound', async () => {
  const env = environment();
  env.install();
  env.runtime.setSolutions({ 'src/first.java': 'NEW' });
  env.context.location = new URL('https://www.educoder.net/tasks/next');
  await assert.rejects(
    env.window.fetch(saveUrl, { method: 'POST', body: JSON.stringify(payload()) }),
    /page_scope_changed/,
  );
  assert.equal(env.sent.length, 0);
});

test('scope and limit objects are snapshots rather than mutable caller references', async () => {
  const env = environment();
  const mutableScope = { ...scope, allowedPaths: [...scope.allowedPaths] };
  const limits = { ...DEFAULT_LIMITS };
  env.install(mutableScope, limits);
  mutableScope.gameId = '999';
  mutableScope.allowedPaths.length = 0;
  limits.maxRecords = 0;
  env.runtime.setSolutions({ 'src/first.java': 'NEW' });
  await env.window.fetch(saveUrl, { method: 'POST', body: JSON.stringify(payload()) });
  await settle(env);
  assert.equal(JSON.parse(env.sent[0].body).content, 'NEW');
  assert.equal(env.runtime.requests.length, 1);
});

test('uninstall during request-body inspection prevents an armed save from being sent', async () => {
  const env = environment();
  env.install();
  env.runtime.setSolutions({ 'src/first.java': 'NEW' });
  const pending = env.window.fetch(saveUrl, { method: 'POST', body: JSON.stringify(payload()) });
  const runtime = env.runtime;
  runtime.uninstall();
  await assert.rejects(pending, /runtime_uninstalled/);
  assert.equal(env.sent.length, 0);
  assert.equal(runtime.requests.length, 0);
});

test('capture clone errors do not break a successful application fetch', async () => {
  const env = environment({
    responseFactory: () => ({
      status: 200,
      clone() {
        throw new Error('fake_clone_error');
      },
    }),
  });
  env.install();
  const response = await env.window.fetch(taskUrl);
  assert.equal(response.status, 200);
  assert.equal(env.runtime.errors[0].code, 'response_capture_failed');
  assert.notEqual(env.runtime.requests[0].finishedAt, null);
});

test('capture truncation and buffer limits are explicit; original response stays readable', async () => {
  const env = environment({
    responseText: 'x'.repeat(200),
    limits: { maxRecords: 2, maxBodyChars: 32 },
  });
  env.install();
  for (let i = 0; i < 3; i++) {
    const response = await env.window.fetch(taskUrl);
    assert.equal((await response.text()).length, 200);
  }
  await settle(env);
  assert.equal(env.runtime.requests.length, 2);
  assert.equal(env.runtime.requests[0].id, 2);
  assert.equal(env.runtime.requests[0].response.length, 32);
  assert.equal(env.runtime.requests[0].responseComplete, false);
  env.runtime.setSolutions({ 'src/first.java': 'NEW' });
  await assert.rejects(
    env.window.fetch(saveUrl, { method: 'POST', body: JSON.stringify(payload()) }),
    /uninspectable/,
  );
  assert.equal(env.sent.length, 3);
});

test('network rejection is retained as a failure and captured diagnostically', async () => {
  const env = environment({ networkError: true });
  env.install();
  await assert.rejects(env.window.fetch(taskUrl), /fake_network_error/);
  assert.equal(env.runtime.errors[0].code, 'network_error');
  assert.equal(env.runtime.requests[0].responseComplete, false);
});

test('save preparation preserves live context and rejects cross-game or incomplete records', () => {
  const record = {
    url: saveUrl,
    method: 'POST',
    body: JSON.stringify(payload()),
    bodyComplete: true,
  };
  assert.deepEqual(
    prepareFileSave(record, scope, 'src/second.java', ''),
    payload({ path: 'src/second.java', content: '' }),
  );
  assert.equal(JSON.parse(record.body).content, 'OLD');
  assert.throws(
    () => prepareFileSave({ ...record, bodyComplete: false }, scope, 'src/second.java', ''),
    /incomplete/,
  );
  assert.throws(
    () =>
      prepareFileSave(
        { ...record, body: JSON.stringify(payload({ game_id: 99 })) },
        scope,
        'src/second.java',
        '',
      ),
    /game_id_mismatch/,
  );
  assert.throws(
    () => prepareFileSave({ ...record, body: 'null' }, scope, 'src/second.java', ''),
    /invalid_save_json/,
  );
  assert.throws(
    () =>
      prepareFileSave(
        { ...record, body: JSON.stringify(payload({ path: 'unknown.java' })) },
        scope,
        'src/second.java',
        '',
      ),
    /file_scope_mismatch/,
  );
});

test('verdict requires current identity, completed state and explicit positive evidence', () => {
  const current = { submissionId: 'current', completed: true };
  assert.equal(classifyVerdict({ ...current, text: '评测通过' }, 'current'), 'passed');
  assert.equal(classifyVerdict({ ...current, text: '编译失败' }, 'current'), 'failed');
  assert.equal(
    classifyVerdict({ ...current, text: '共有5组测试集，其中有0组测试结果不匹配' }, 'current'),
    'passed',
  );
  assert.equal(
    classifyVerdict({ ...current, text: '共有5组测试集，其中有2组测试结果不匹配' }, 'current'),
    'failed',
  );
  for (const record of [
    { ...current, text: '' },
    { ...current, text: '加载中' },
    { ...current, text: '历史记录：全部通过\n当前：编译失败' },
    { ...current, text: '共有0组测试集，其中有0组测试结果不匹配' },
  ]) {
    assert.equal(classifyVerdict(record, 'current'), 'unknown');
  }
  assert.equal(
    classifyVerdict({ ...current, submissionId: 'old', pass: true }, 'current'),
    'pending',
  );
  assert.equal(classifyVerdict({ ...current, completed: false, pass: true }, 'current'), 'pending');
});

test('poller ignores a stale pass and waits until the current slow evaluation finishes', async () => {
  let time = 0,
    calls = 0;
  const result = await waitForVerdict(
    async ({ signal }) => {
      assert.equal(signal.aborted, false);
      calls++;
      return calls === 1
        ? { submissionId: 'old', completed: true, pass: true }
        : { submissionId: 'current', completed: calls === 4, pass: true };
    },
    {
      submissionId: 'current',
      timeoutMs: 1000,
      intervalMs: 100,
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
    },
  );
  assert.equal(result.state, 'passed');
  assert.equal(calls, 4);
  assert.equal(time, 300);
});

test('poller returns a confirmed failure and bounds pending and hung reads', async () => {
  assert.equal(
    (
      await waitForVerdict(async () => ({ submissionId: 's', completed: true, pass: false }), {
        submissionId: 's',
      })
    ).state,
    'failed',
  );
  let time = 0;
  await assert.rejects(
    waitForVerdict(async () => ({ submissionId: 's', completed: false }), {
      submissionId: 's',
      timeoutMs: 10,
      intervalMs: 3,
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
    }),
    /evaluation_timeout/,
  );
  let signal;
  await assert.rejects(
    waitForVerdict(
      async (options) => {
        signal = options.signal;
        return new Promise(() => {});
      },
      { submissionId: 's', timeoutMs: 10 },
    ),
    /evaluation_timeout/,
  );
  assert.equal(signal.aborted, true);
});

test('documented JavaScript examples parse and their local resource links resolve', async () => {
  for (const relative of [
    '../SKILL.md',
    '../references/snippets.md',
    '../references/browser-runtime.md',
  ]) {
    const url = new URL(relative, import.meta.url);
    const text = await readFile(url, 'utf8');
    for (const match of text.matchAll(/```js\n([\s\S]*?)```/g)) new vm.Script(match[1]);
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      if (!/^https?:/.test(match[1])) await readFile(new URL(match[1], url));
    }
  }
});
