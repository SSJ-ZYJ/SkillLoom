// Browser-independent helpers. installPageRuntime is self-contained so a supported
// page evaluator can serialize it without importing Node code into the page.
export const DEFAULT_PLATFORM = Object.freeze({
  pageOrigin: 'https://www.educoder.net',
  apiOrigin: 'https://data.educoder.net',
});
export const DEFAULT_LIMITS = Object.freeze({
  maxRecords: 40,
  maxBodyChars: 30000,
  maxErrors: 20,
});
export const DEFAULT_WAIT = Object.freeze({ timeoutMs: 120000, intervalMs: 500 });

function taskFromUrl(url, origin) {
  if (url.origin !== origin) throw new Error('page_origin_mismatch');
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'tasks' || ![2, 4].includes(parts.length)) {
    throw new Error('unsupported_task_route');
  }
  const id = decodeURIComponent(parts.at(-1));
  if (!/^[\w-]+$/.test(id)) throw new Error('invalid_task_id');
  return id;
}

function validPath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !path.includes('\0') &&
    !/[\\\r\n]/.test(path) &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

export function createScope(context, platform = DEFAULT_PLATFORM) {
  for (const origin of [platform.pageOrigin, platform.apiOrigin]) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin)
      throw new Error('invalid_platform_origin');
  }
  const taskId = taskFromUrl(new URL(context.pageUrl), platform.pageOrigin);
  if (context.taskId != null && String(context.taskId) !== taskId)
    throw new Error('task_id_mismatch');
  const paths = context.allowedPaths ?? [];
  if (!Array.isArray(paths) || paths.some((path) => !validPath(path)))
    throw new Error('invalid_file_paths');
  if (context.myshixunId != null && !/^[\w-]+$/.test(String(context.myshixunId))) {
    throw new Error('invalid_myshixun_id');
  }
  return {
    ...platform,
    taskId,
    myshixunId: context.myshixunId == null ? null : String(context.myshixunId),
    gameId: context.gameId == null ? null : String(context.gameId),
    challengeId: context.challengeId == null ? null : String(context.challengeId),
    userId: context.userId == null ? null : String(context.userId),
    allowedPaths: [...new Set(paths)],
  };
}

export function resolveNextUrl(next, pageUrl, platform = DEFAULT_PLATFORM) {
  if (next == null || next === '') return null;
  if (typeof next !== 'string') throw new Error('invalid_next_url');
  const current = new URL(pageUrl);
  taskFromUrl(current, platform.pageOrigin);
  const url = new URL(next, current);
  taskFromUrl(url, platform.pageOrigin);
  if (url.pathname === current.pathname) throw new Error('next_is_current_task');
  return url.href;
}

// This is evidence of the latest read, not proof of which editor tab is active.
export function latestReadPath(records, scope) {
  const expected = `/api/tasks/${scope.taskId}/rep_content.json`;
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (record.method !== 'GET') continue;
    const url = new URL(record.url);
    if (url.origin !== scope.apiOrigin || url.pathname !== expected) continue;
    const path = url.searchParams.get('path');
    if (validPath(path) && scope.allowedPaths.includes(path)) return path;
  }
  return null;
}

// The caller must supply the identity and completion state from the current
// platform response/record. Entire-page text is deliberately not accepted.
export function classifyVerdict(record, submissionId) {
  if (!submissionId || !record || String(record.submissionId) !== String(submissionId))
    return 'pending';
  if (record.completed !== true) return 'pending';
  if (record.pass === true) return 'passed';
  if (record.pass === false) return 'failed';
  const text = String(record.text ?? '').trim();
  if (/^(全部通过|评测通过)$/.test(text)) return 'passed';
  if (/^(评测失败|编译失败|运行失败|运行超时)$/.test(text)) return 'failed';
  const counts = text.match(/^共有(\d+)组测试集[，,]\s*其中有(\d+)组测试结果不匹配$/);
  if (counts && Number(counts[1]) > 0 && Number(counts[2]) <= Number(counts[1])) {
    return Number(counts[2]) === 0 ? 'passed' : 'failed';
  }
  return 'unknown';
}

export async function waitForVerdict(read, options) {
  const {
    submissionId,
    timeoutMs = DEFAULT_WAIT.timeoutMs,
    intervalMs = DEFAULT_WAIT.intervalMs,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;
  if (!submissionId || !(timeoutMs > 0) || !(intervalMs > 0))
    throw new Error('invalid_wait_options');
  const deadline = now() + timeoutMs;
  const controller = new AbortController();
  const timeout = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('evaluation_timeout')), {
      once: true,
    });
  });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    while (now() < deadline) {
      const record = await Promise.race([read({ signal: controller.signal }), timeout]);
      if (now() >= deadline) break;
      const state = classifyVerdict(record, submissionId);
      if (state === 'passed' || state === 'failed') return { state, record };
      const remaining = deadline - now();
      if (remaining > 0) await Promise.race([sleep(Math.min(intervalMs, remaining)), timeout]);
    }
    throw new Error('evaluation_timeout');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export function prepareFileSave(record, scope, path, content) {
  if (!scope.myshixunId || !scope.gameId) throw new Error('missing_save_scope');
  const url = new URL(record.url);
  if (
    record.method !== 'POST' ||
    url.origin !== scope.apiOrigin ||
    url.pathname !== `/api/myshixuns/${scope.myshixunId}/update_file.json`
  ) {
    throw new Error('save_endpoint_mismatch');
  }
  if (record.bodyComplete !== true || typeof record.body !== 'string')
    throw new Error('incomplete_save_body');
  if (!scope.allowedPaths.includes(path) || !validPath(path) || typeof content !== 'string') {
    throw new Error('invalid_solution');
  }
  let body;
  try {
    body = JSON.parse(record.body);
  } catch {
    throw new Error('invalid_save_json');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new Error('invalid_save_json');
  if (String(body.game_id) !== scope.gameId) throw new Error('game_id_mismatch');
  if (!scope.allowedPaths.includes(body.path)) throw new Error('file_scope_mismatch');
  for (const [key, expected] of [
    ['challenge_id', scope.challengeId],
    ['currentUserId', scope.userId],
  ]) {
    if (expected != null && String(body.extras?.[key]) !== expected)
      throw new Error('save_context_mismatch');
  }
  // Preserve all other fields, including homework/exam/competition context.
  return { ...body, path, content };
}

export function installPageRuntime(config) {
  const version = 2;
  const scope = config.scope && JSON.parse(JSON.stringify(config.scope));
  const limits = { ...config.limits };
  if (!scope || location.origin !== scope.pageOrigin || !/^[\w-]+$/.test(scope.taskId)) {
    throw new Error('invalid_page_scope');
  }
  const parts = location.pathname.split('/').filter(Boolean);
  if (
    parts[0] !== 'tasks' ||
    ![2, 4].includes(parts.length) ||
    decodeURIComponent(parts.at(-1)) !== scope.taskId
  )
    throw new Error('task_id_mismatch');
  if (
    !Array.isArray(scope.allowedPaths) ||
    scope.allowedPaths.some(
      (path) =>
        typeof path !== 'string' ||
        !path ||
        path.includes('\0') ||
        /[\\\r\n]/.test(path) ||
        path.split('/').some((part) => !part || part === '.' || part === '..'),
    ) ||
    new URL(scope.apiOrigin).origin !== scope.apiOrigin ||
    new URL(scope.apiOrigin).protocol !== 'https:'
  )
    throw new Error('invalid_api_scope');
  for (const key of ['maxRecords', 'maxBodyChars', 'maxErrors']) {
    const value = limits?.[key];
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('invalid_capture_limits');
  }
  const scopeKey = JSON.stringify({ scope, limits });
  const slot = '__educoderAutomation';
  const previous = window[slot];
  if (previous?.version === version && previous.scopeKey === scopeKey && previous.active) {
    return { installed: false, version };
  }
  if (previous) {
    if (typeof previous.uninstall !== 'function') throw new Error('runtime_slot_conflict');
    previous.uninstall();
  }
  const originals = { fetch: window.fetch };
  const XHR = window.XMLHttpRequest;
  if (XHR)
    Object.assign(originals, {
      open: XHR.prototype.open,
      send: XHR.prototype.send,
      setRequestHeader: XHR.prototype.setRequestHeader,
    });
  let xhrStates = new WeakMap();
  let sequence = 0;
  let solutions = new Map();
  const runtime = { version, scopeKey, active: true, requests: [], swaps: [], errors: [] };
  const boundedPush = (list, item, size) => {
    list.push(item);
    while (list.length > size) list.shift();
  };
  const report = (code, requestId = null) => {
    boundedPush(runtime.errors, { code, requestId, at: Date.now() }, limits.maxErrors);
  };
  const endpoint = (rawUrl) => {
    const url = new URL(rawUrl, location.href);
    if (url.origin !== scope.apiOrigin) return null;
    const base = `/api/tasks/${scope.taskId}`;
    if (url.pathname === `${base}.json`) return 'task';
    const names = ['rep_content', 'evaluate_logs', 'game_status', 'game_build', 'choose_build'];
    const found = names.find((name) => url.pathname === `${base}/${name}.json`);
    if (found) return found;
    if (
      scope.myshixunId &&
      url.pathname === `/api/myshixuns/${scope.myshixunId}/update_file.json`
    ) {
      return 'update_file';
    }
    return null;
  };
  const textRecord = (value) => {
    const text = typeof value === 'string' ? value : '';
    return {
      text: text.slice(0, limits.maxBodyChars),
      complete: text.length <= limits.maxBodyChars,
    };
  };
  const readBounded = async (message) => {
    if (!message.body) return { text: '', complete: true };
    const reader = message.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return textRecord(text + decoder.decode());
        text += decoder.decode(value, { stream: true });
        if (text.length > limits.maxBodyChars) {
          // Do not await cancellation of one branch of a cloned stream.
          reader.cancel().catch(() => report('capture_cancel_failed'));
          return { text: text.slice(0, limits.maxBodyChars), complete: false };
        }
      }
    } finally {
      reader.releaseLock();
    }
  };
  const start = (url, method, headers, kind, body, complete) => {
    const record = {
      id: ++sequence,
      url,
      method,
      headers: Object.fromEntries(headers),
      endpoint: kind,
      body,
      bodyComplete: complete,
      startedAt: Date.now(),
      response: null,
      responseComplete: false,
      status: null,
      finishedAt: null,
    };
    boundedPush(runtime.requests, record, limits.maxRecords);
    return record;
  };
  const block = (code) => {
    report(code);
    throw new Error(code);
  };
  const patch = (kind, method, body, complete) => {
    if (kind !== 'update_file' || !solutions.size) return { body, changed: false };
    const current = location.pathname.split('/').filter(Boolean);
    if (
      location.origin !== scope.pageOrigin ||
      current[0] !== 'tasks' ||
      ![2, 4].includes(current.length) ||
      decodeURIComponent(current.at(-1)) !== scope.taskId
    ) {
      return block('page_scope_changed');
    }
    if (method !== 'POST') return block('save_method_mismatch');
    if (!complete || typeof body !== 'string') return block('uninspectable_save_body');
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return block('invalid_save_json');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      return block('invalid_save_json');
    if (String(payload.game_id) !== scope.gameId) return block('game_id_mismatch');
    for (const [key, expected] of [
      ['challenge_id', scope.challengeId],
      ['currentUserId', scope.userId],
    ]) {
      if (expected != null && String(payload.extras?.[key]) !== expected)
        return block('save_context_mismatch');
    }
    if (!scope.allowedPaths.includes(payload.path)) return block('file_scope_mismatch');
    if (!solutions.has(payload.path)) return { body, changed: false };
    payload.content = solutions.get(payload.path);
    return { body: JSON.stringify(payload), changed: true, path: payload.path };
  };
  runtime.setSolutions = (values) => {
    if (!runtime.active) throw new Error('runtime_uninstalled');
    if (values == null || typeof values !== 'object' || Array.isArray(values))
      throw new Error('invalid_solutions');
    const entries = Object.entries(values);
    if (entries.length && (!scope.myshixunId || !scope.gameId))
      throw new Error('missing_save_scope');
    for (const [path, content] of entries) {
      if (!scope.allowedPaths.includes(path) || typeof content !== 'string')
        throw new Error('invalid_solution');
    }
    solutions = new Map(entries);
    runtime.swaps.length = 0;
  };
  const swapped = (record, result) => {
    if (result.changed)
      boundedPush(
        runtime.swaps,
        { requestId: record.id, path: result.path, at: Date.now() },
        limits.maxRecords,
      );
  };
  const wrappedFetch = async function (input, init) {
    if (!runtime.active) return originals.fetch.call(this, input, init);
    const rawUrl = input instanceof Request ? input.url : String(input);
    const kind = endpoint(rawUrl);
    if (!kind) return originals.fetch.call(this, input, init);
    const request = new Request(
      input instanceof Request ? input : new URL(rawUrl, location.href),
      init,
    );
    const armedSave = kind === 'update_file' && solutions.size > 0;
    let captured;
    try {
      captured = await readBounded(request.clone());
    } catch {
      report('request_capture_failed');
      if (kind === 'update_file' && solutions.size) throw new Error('uninspectable_save_body');
      captured = { text: '', complete: false };
    }
    if (!runtime.active) {
      if (armedSave) throw new Error('runtime_uninstalled');
      return originals.fetch.call(this, request);
    }
    const result = patch(kind, request.method, captured.text, captured.complete);
    const outgoing = result.changed ? new Request(request, { body: result.body }) : request;
    const loggedBody = textRecord(result.body);
    const record = start(
      outgoing.url,
      outgoing.method,
      outgoing.headers,
      kind,
      loggedBody.text,
      captured.complete && loggedBody.complete,
    );
    swapped(record, result);
    let response;
    try {
      response = await originals.fetch.call(this, outgoing);
    } catch (error) {
      record.finishedAt = Date.now();
      report('network_error', record.id);
      throw error;
    }
    record.status = response.status;
    // Capture asynchronously without swallowing the request's own failure or
    // leaving an unhandled rejection from response decoding.
    try {
      readBounded(response.clone())
        .then((data) => {
          if (!runtime.active) return;
          record.response = data.text;
          record.responseComplete = data.complete;
          record.finishedAt = Date.now();
        })
        .catch(() => {
          record.finishedAt = Date.now();
          report('response_capture_failed', record.id);
        });
    } catch {
      record.finishedAt = Date.now();
      report('response_capture_failed', record.id);
    }
    return response;
  };
  let wrappedOpen, wrappedHeader, wrappedSend;
  if (XHR) {
    wrappedOpen = function (...args) {
      if (!runtime.active) return originals.open.apply(this, args);
      const [method, url] = args;
      const result = originals.open.apply(this, args);
      xhrStates.set(this, {
        method: String(method).toUpperCase(),
        url: new URL(url, location.href).href,
        headers: new Headers(),
      });
      return result;
    };
    wrappedHeader = function (...args) {
      const [name, value] = args;
      const result = originals.setRequestHeader.apply(this, args);
      if (runtime.active) xhrStates.get(this)?.headers.append(name, value);
      return result;
    };
    wrappedSend = function (...args) {
      const [body] = args;
      const state = xhrStates.get(this);
      const kind = state && endpoint(state.url);
      if (!runtime.active || !kind) return originals.send.apply(this, args);
      const knownBody = body == null || typeof body === 'string';
      const captured = textRecord(typeof body === 'string' ? body : '');
      const result = patch(kind, state.method, captured.text, knownBody && captured.complete);
      const loggedBody = textRecord(result.body);
      const record = start(
        state.url,
        state.method,
        state.headers,
        kind,
        loggedBody.text,
        knownBody && captured.complete && loggedBody.complete,
      );
      swapped(record, result);
      const onLoadEnd = () => {
        if (!runtime.active) return;
        record.finishedAt = Date.now();
        try {
          record.status = this.status;
          let value;
          if (this.responseType === 'json') value = JSON.stringify(this.response);
          else if (!this.responseType || this.responseType === 'text') value = this.responseText;
          else {
            report('unsupported_xhr_response_type', record.id);
            return;
          }
          const data = textRecord(value);
          record.response = data.text;
          record.responseComplete = data.complete;
          if (this.status === 0) report('network_error', record.id);
        } catch {
          report('response_capture_failed', record.id);
        }
      };
      this.addEventListener('loadend', onLoadEnd, { once: true });
      try {
        return originals.send.call(this, result.changed ? result.body : body);
      } catch (error) {
        this.removeEventListener('loadend', onLoadEnd);
        record.finishedAt = Date.now();
        report('xhr_send_failed', record.id);
        throw error;
      }
    };
    XHR.prototype.open = wrappedOpen;
    XHR.prototype.setRequestHeader = wrappedHeader;
    XHR.prototype.send = wrappedSend;
  }
  window.fetch = wrappedFetch;
  runtime.snapshot = () => ({
    version,
    active: runtime.active,
    requests: runtime.requests.map((record) => {
      const url = new URL(record.url);
      for (const key of [...url.searchParams.keys()]) {
        if (/zzud|token|authorization|signature/i.test(key)) url.searchParams.delete(key);
      }
      return {
        id: record.id,
        url: url.href,
        method: record.method,
        endpoint: record.endpoint,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        status: record.status,
        bodyComplete: record.bodyComplete,
        responseComplete: record.responseComplete,
      };
    }),
    swaps: runtime.swaps.map((value) => ({ ...value })),
    errors: runtime.errors.map((value) => ({ ...value })),
  });
  runtime.uninstall = () => {
    runtime.active = false;
    solutions.clear();
    xhrStates = new WeakMap();
    if (window.fetch === wrappedFetch) window.fetch = originals.fetch;
    else report('fetch_restore_conflict');
    if (XHR) {
      for (const [name, wrapper] of [
        ['open', wrappedOpen],
        ['setRequestHeader', wrappedHeader],
        ['send', wrappedSend],
      ]) {
        if (XHR.prototype[name] === wrapper) XHR.prototype[name] = originals[name];
        else report('xhr_restore_conflict');
      }
    }
    runtime.requests.length = 0;
    runtime.swaps.length = 0;
    if (window[slot] === runtime) delete window[slot];
  };
  window[slot] = runtime;
  return { installed: true, version };
}
