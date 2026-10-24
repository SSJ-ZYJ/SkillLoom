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
// Clock skew allowance: server timestamps and page clocks differ by a small amount.
// maxIntervalMs bounds any measured/declared wait so a malformed value cannot stall work.
export const DEFAULT_PACING = Object.freeze({
  graceMs: 1500,
  pollIntervalMs: 1000,
  maxIntervalMs: 600000,
});
// Response fields and message shapes that may literally state a wait. They are
// candidate readers only: confirm each against the live response before relying on it.
export const COOLDOWN_FIELDS = Object.freeze([
  'cooldown_seconds',
  'cooldown',
  'interval',
  'interval_seconds',
  'remaining_seconds',
  'wait_seconds',
  'retry_after',
]);
// Endpoints that carry server-side submission history for the current task.
const COOLDOWN_LIST_ENDPOINTS = Object.freeze(['evaluate_logs', 'game_status', 'task']);
// Timestamp fields that may identify a submission in the current response. Confirm the
// live spelling before using them; an unconfirmed field yields no interval, not a guess.
export const DEFAULT_TIMESTAMP_FIELDS = Object.freeze([
  'created_at',
  'submit_time',
  'submitted_at',
  'evaluate_time',
  'start_time',
]);
// Candidate message shapes. Matching is deliberately narrow: a generic number in test
// output must not be read as a wait, so only an explicit rate phrase unlocks it.
export const DEFAULT_COOLDOWN_PATTERNS = Object.freeze({
  seconds: /(\d+)\s*(?:秒|s\b)/i,
  rate: /(频繁|稍后再试|请稍候|太频繁|rate.?limit|too many|retry after|请稍后|间隔)/i,
});

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

// --- Submission pacing (cooldown-aware scheduling) -----------------------------------
//
// These helpers treat the platform's submission pacing as observed server state, never
// as a locally assumed constant. Nothing here encodes a fixed interval: an interval is
// only ever a value measured from the current response. When the response exposes no
// pacing evidence, the tracker reports `unknown` and the caller must read the live app
// state or perform the normal app action and handle its rejection.

function toEpochMs(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value))
    return Math.abs(value) < 1e10 ? value * 1000 : value;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d{9,}$/.test(text)) return toEpochMs(Number(text));
  // Naive platform timestamps share one convention per response, so differences stay
  // meaningful even when the absolute zone is unknown to the page clock.
  const parsed = Date.parse(/T/.test(text) ? text : text.replace(' ', 'T'));
  return Number.isNaN(parsed) ? null : parsed;
}

function asFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\s*-?\d+(?:\.\d+)?\s*$/.test(value)) return Number(value);
  return null;
}

// Bounded deep scan: collects values under any of `names`. Refuses to walk past a size
// budget so a hostile or unexpectedly large payload cannot stall the caller.
function collectFields(node, names, { maxNodes = 4000, maxDepth = 6 } = {}) {
  const wanted = new Set(names);
  const found = [];
  let visited = 0;
  const walk = (current, depth) => {
    if (current == null || visited >= maxNodes || depth > maxDepth) return;
    visited++;
    if (Array.isArray(current)) {
      for (const item of current) walk(item, depth + 1);
      return;
    }
    if (typeof current !== 'object') return;
    for (const [key, value] of Object.entries(current)) {
      if (wanted.has(key) && (typeof value === 'string' || typeof value === 'number'))
        found.push(value);
      walk(value, depth + 1);
    }
  };
  walk(node, 0);
  return found;
}

// Extract pacing evidence from one current response. `source` is the normalized capture
// record: { status, responseText, responseComplete, headers }.
export function parseCooldownEvidence(source, options = {}) {
  const {
    nowMs = Date.now(),
    fields = COOLDOWN_FIELDS,
    timestampFields = DEFAULT_TIMESTAMP_FIELDS,
    patterns = DEFAULT_COOLDOWN_PATTERNS,
    maxIntervalMs = DEFAULT_PACING.maxIntervalMs,
    observedAtMs = nowMs,
  } = options;
  const evidence = {
    observedAtMs,
    source: 'none',
    remainingMs: null,
    intervalMs: null,
    latestSubmitAtMs: null,
    serverNowAtMs: null,
    rejection: false,
    usable: source?.responseComplete !== false,
    truncated: source?.responseComplete === false,
  };
  if (Number(source?.status) === 429) evidence.rejection = true;
  let json = null;
  const text = typeof source?.responseText === 'string' ? source.responseText : '';
  if (evidence.usable && text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  const haystack = json ? text : text.slice(0, 4000);
  if (!evidence.usable) return evidence;
  if (!evidence.rejection && patterns.rate.test(haystack)) evidence.rejection = true;

  // 1. An explicit server-declared wait is the strongest evidence.
  let explicit = asFiniteNumber(source?.headers?.['retry-after']);
  if (explicit != null) evidence.source = 'retry-after';
  if (explicit == null && json) {
    for (const value of collectFields(json, fields)) {
      const number = asFiniteNumber(value);
      if (number != null && number >= 0) {
        explicit = number;
        evidence.source = 'field';
        break;
      }
    }
  }
  if (explicit == null) {
    const match = haystack.match(patterns.seconds);
    if (match && patterns.rate.test(haystack)) {
      explicit = Number(match[1]);
      evidence.source = 'message';
    }
  }
  if (explicit != null) {
    const ms = explicit * 1000;
    if (ms <= maxIntervalMs) {
      evidence.remainingMs = ms;
      evidence.nextAllowedAtMs = observedAtMs + ms;
    }
    return evidence;
  }
  if (evidence.rejection) return evidence;

  // 2. Otherwise measure the observed submission cadence. Gaps and any remaining wait are
  //    computed between timestamps from the same response, so an unknown server time zone
  //    cancels out. Without a server clock in the same response, a remaining wait cannot
  //    be mapped onto the page clock: report the interval only and let the tracker pace
  //    from its own locally observed submit time.
  const stamps = [];
  if (json) {
    for (const value of collectFields(json, timestampFields)) {
      const ms = toEpochMs(value);
      if (ms != null) stamps.push(ms);
    }
    evidence.serverNowAtMs = toEpochMs(collectFields(json, ['now', 'server_time'])[0]);
  }
  if (stamps.length >= 2) {
    stamps.sort((a, b) => a - b);
    evidence.latestSubmitAtMs = stamps.at(-1);
    const gaps = stamps.slice(1).map((value, i) => value - stamps[i]);
    const positive = gaps.filter((gap) => gap >= 1000 && gap <= maxIntervalMs);
    // Consecutive submissions are at least one interval apart, so the smallest observed
    // gap is the closest evidence of the bound. It remains a measurement, not a constant.
    if (positive.length) evidence.intervalMs = Math.min(...positive);
  }
  if (evidence.intervalMs != null) {
    if (evidence.serverNowAtMs != null && evidence.latestSubmitAtMs != null) {
      const remaining = evidence.latestSubmitAtMs + evidence.intervalMs - evidence.serverNowAtMs;
      evidence.remainingMs = Math.max(0, Math.min(remaining, evidence.intervalMs));
      evidence.nextAllowedAtMs = observedAtMs + evidence.remainingMs;
      evidence.source = evidence.remainingMs > 0 ? 'cadence' : 'cadence-open';
    } else {
      evidence.source = 'interval-only';
    }
  }
  return evidence;
}

export function createCooldownTracker(options = {}) {
  const {
    now = Date.now,
    graceMs = DEFAULT_PACING.graceMs,
    maxIntervalMs = DEFAULT_PACING.maxIntervalMs,
  } = options;
  if (!(graceMs >= 0) || !(maxIntervalMs > 0)) throw new Error('invalid_pacing_options');
  let openAtMs = null;
  let basis = 'none';
  let lastSubmitAtMs = null;
  let lastKnownIntervalMs = null;
  let rejection = false;
  const tracker = {
    // A server-declared wait replaces the window. A cadence-derived estimate may only
    // extend it: shortening a wait to benefit from an inference is how a rate limit gets
    // tripped, so an estimate never pulls a window earlier than already known.
    observe(evidence, atMs) {
      if (!evidence || typeof evidence !== 'object') throw new Error('invalid_evidence');
      const observedAt = atMs ?? evidence.observedAtMs ?? now();
      rejection = evidence.rejection === true;
      const interval = asFiniteNumber(evidence.intervalMs);
      if (interval != null && interval >= 1000 && interval <= maxIntervalMs)
        lastKnownIntervalMs = interval;
      const remaining = asFiniteNumber(evidence.remainingMs);
      const declared =
        evidence.source === 'retry-after' ||
        evidence.source === 'field' ||
        evidence.source === 'message';
      if (remaining != null && declared) {
        openAtMs = Math.max(observedAt, observedAt + Math.max(0, remaining));
        basis = 'declared';
        return tracker.state(observedAt);
      }
      if (remaining != null) {
        const cadence = observedAt + Math.max(0, remaining);
        if (openAtMs == null || cadence > openAtMs) {
          openAtMs = cadence;
          basis = 'cadence';
        }
      } else if (lastKnownIntervalMs != null && lastSubmitAtMs != null) {
        const candidate = lastSubmitAtMs + lastKnownIntervalMs;
        if (openAtMs == null || candidate > openAtMs) {
          openAtMs = candidate;
          basis = 'local-interval';
        }
      }
      if (rejection && openAtMs == null) basis = 'rejection-unknown';
      return tracker.state(observedAt);
    },
    noteSubmit(atMs) {
      lastSubmitAtMs = atMs ?? now();
      // A submission always starts a window on this page's clock; before its interval is
      // measured the caller stays unknown, so nothing is guessed here.
      if (lastKnownIntervalMs != null) {
        const candidate = lastSubmitAtMs + lastKnownIntervalMs;
        if (openAtMs == null || candidate > openAtMs) {
          openAtMs = candidate;
          basis = 'local-interval';
        }
      }
      return lastSubmitAtMs;
    },
    // Record an interval measured from the current response, e.g. a spacing the caller
    // observed directly. Rejects implausible values instead of adopting them.
    noteInterval(intervalMs) {
      const interval = asFiniteNumber(intervalMs);
      if (interval == null || interval < 1000 || interval > maxIntervalMs)
        throw new Error('invalid_observed_interval');
      lastKnownIntervalMs = interval;
      if (lastSubmitAtMs != null) {
        const candidate = lastSubmitAtMs + interval;
        if (openAtMs == null || candidate > openAtMs) {
          openAtMs = candidate;
          basis = 'local-interval';
        }
      }
      return interval;
    },
    reset() {
      openAtMs = null;
      basis = 'none';
      lastSubmitAtMs = null;
      lastKnownIntervalMs = null;
      rejection = false;
      return tracker.state();
    },
    state(atMs) {
      const at = atMs ?? now();
      const remainingMs = openAtMs == null ? null : Math.max(0, openAtMs + graceMs - at);
      const status =
        openAtMs == null
          ? rejection
            ? 'rejected-unknown'
            : 'unknown'
          : remainingMs === 0
            ? 'open'
            : 'waiting';
      return {
        status,
        remainingMs,
        nextAllowedAtMs: openAtMs == null ? null : openAtMs + graceMs,
        basis,
        rejection,
        lastKnownIntervalMs,
        lastSubmitAtMs,
      };
    },
  };
  return tracker;
}

// Pick the newest usable pacing read from captured records and normalize it for
// parseCooldownEvidence. Only list/history endpoints bound to the current task qualify;
// saves, builds and foreign origins are never treated as pacing evidence. Pass
// `runtime.requests` (the full records), not `snapshot()` output, which omits bodies.
export function selectPacingSource(records, scope) {
  const names = new Set(COOLDOWN_LIST_ENDPOINTS);
  let chosen = null;
  for (const record of records ?? []) {
    if (!record || !names.has(record.endpoint)) continue;
    if (record.method !== 'GET' || record.status == null) continue;
    const url = new URL(record.url);
    if (url.origin !== scope.apiOrigin) continue;
    if (!url.pathname.startsWith(`/api/tasks/${scope.taskId}/`)) continue;
    chosen = record;
  }
  if (!chosen) return null;
  return {
    endpoint: chosen.endpoint,
    status: chosen.status,
    responseText: chosen.response ?? '',
    responseComplete: chosen.responseComplete !== false,
    headers: chosen.headers ?? {},
  };
}

// One-resource list schedule that fills pacing windows with productive work instead of
// idling. A "task" is either `work` (read the level, compose the solution, save and read
// it back: never rate-limited) or `submit` (the one rate-limited action). Submits run the
// moment their window is open, because every cooldown then overlaps work that is already
// available. Windows come only from observed evidence: an `earliestStartMs` of Infinity
// means "no evidence yet", which the planner reports instead of guessing.
export function planCooldownOverlap(options = {}) {
  const {
    nowMs = Date.now(),
    minSubmitGapMs = 0,
    horizonMs = 3600000,
    maxIdleMs = null,
    tasks = [],
  } = options;
  if (!(minSubmitGapMs >= 0)) throw new Error('invalid_min_submit_gap');
  if (!(horizonMs > 0)) throw new Error('invalid_horizon');
  const pending = [];
  for (const [index, task] of tasks.entries()) {
    if (!task || typeof task !== 'object' || task.levelId == null)
      throw new Error('invalid_schedule_task');
    const kind = task.kind ?? 'work';
    if (kind !== 'work' && kind !== 'submit') throw new Error('invalid_schedule_task');
    const estMs = Number(task.estMs ?? 0);
    const earliest =
      kind === 'submit'
        ? Number(task.earliestStartMs ?? nowMs)
        : Number(task.earliestStartMs ?? nowMs);
    pending.push({
      index,
      levelId: String(task.levelId),
      kind,
      estMs: kind === 'work' ? Math.max(0, Number.isFinite(estMs) ? estMs : 0) : 0,
      earliestStartMs: Number.isFinite(earliest) ? Math.max(earliest, nowMs) : Infinity,
      dependsOn: (task.dependsOn ?? []).map(String),
    });
  }
  const actions = [];
  const unscheduled = [];
  const done = new Set();
  let clock = nowMs;
  const deadline = nowMs + horizonMs;
  let idleMs = 0;
  let lastSubmitAtMs = null;
  let requiresReplan = false;

  const dependenciesMet = (item) => item.dependsOn.every((levelId) => done.has(levelId));
  const drop = (item, reason) => {
    pending.splice(pending.indexOf(item), 1);
    unscheduled.push({ levelId: item.levelId, kind: item.kind, reason });
  };

  while (pending.length) {
    if (clock > deadline) {
      for (const item of [...pending]) drop(item, 'horizon_exceeded');
      break;
    }
    const eligible = pending.filter(dependenciesMet);
    // 1. Any submit whose observed window is already open goes first.
    const open = eligible.filter(
      (item) =>
        item.kind === 'submit' &&
        item.earliestStartMs <= clock &&
        (lastSubmitAtMs == null || clock >= lastSubmitAtMs + minSubmitGapMs),
    );
    if (open.length) {
      const item = open[0];
      actions.push({ levelId: item.levelId, kind: 'submit', atMs: clock });
      pending.splice(pending.indexOf(item), 1);
      done.add(item.levelId);
      lastSubmitAtMs = clock;
      // A second submit for the same level needs evidence from after this one.
      for (const later of pending.filter((other) => other.levelId === item.levelId)) {
        requiresReplan = true;
        drop(later, 'needs_fresh_cooldown_evidence');
      }
      continue;
    }
    // 2. Otherwise do work. Prefer a level whose submit is waiting on the nearest window,
    //    so the window opens onto a ready solution rather than onto more composing.
    const workable = eligible.filter((item) => item.kind === 'work');
    if (workable.length) {
      const nearestWindow = (levelId) => {
        const waits = eligible.filter((t) => t.kind === 'submit' && t.levelId === levelId);
        return waits.length ? Math.min(...waits.map((t) => t.earliestStartMs)) : Infinity;
      };
      workable.sort((a, b) => {
        const aw = nearestWindow(a.levelId);
        const bw = nearestWindow(b.levelId);
        if (aw !== bw) return aw - bw;
        return a.index - b.index;
      });
      const item = workable[0];
      actions.push({
        levelId: item.levelId,
        kind: 'work',
        startAtMs: clock,
        endAtMs: clock + item.estMs,
      });
      pending.splice(pending.indexOf(item), 1);
      done.add(item.levelId);
      clock += item.estMs;
      continue;
    }
    // 3. Only submits remain. Advance to the earliest observed window, bounded by budget.
    const waiting = eligible.filter(
      (item) => item.kind === 'submit' && Number.isFinite(item.earliestStartMs),
    );
    if (waiting.length) {
      const next = waiting.reduce((a, b) => (a.earliestStartMs <= b.earliestStartMs ? a : b));
      const gap = next.earliestStartMs - clock;
      if (maxIdleMs != null && gap > maxIdleMs) {
        for (const item of [...pending]) drop(item, 'idle_budget_exceeded');
        break;
      }
      if (gap > 0) {
        idleMs += gap;
        actions.push({
          kind: 'idle',
          startAtMs: clock,
          endAtMs: next.earliestStartMs,
          idleMs: gap,
        });
        clock = next.earliestStartMs;
      }
      if (lastSubmitAtMs != null && clock < lastSubmitAtMs + minSubmitGapMs) {
        const bump = lastSubmitAtMs + minSubmitGapMs - clock;
        idleMs += bump;
        actions.push({ kind: 'idle', startAtMs: clock, endAtMs: clock + bump, idleMs: bump });
        clock += bump;
      }
      continue;
    }
    // 4. Remaining submits have no evidence at all, or a dependency was never scheduled.
    for (const item of [...pending]) {
      drop(item, item.kind === 'submit' ? 'no_cooldown_evidence' : 'blocked_dependency');
    }
  }
  const busyMs = actions
    .filter((action) => action.kind === 'work')
    .reduce((total, action) => total + (action.endAtMs - action.startAtMs), 0);
  const spanMs = clock - nowMs;
  const submitCount = actions.filter((action) => action.kind === 'submit').length;
  return {
    actions,
    unscheduled,
    busyMs,
    idleMs,
    submitCount,
    finishAtMs: clock,
    requiresReplan,
    productiveRatio: spanMs > 0 ? busyMs / spanMs : submitCount > 0 ? 1 : 0,
  };
}

// Bounded wait for a pacing window to open. This only reads evidence; it never submits,
// and a timeout is reported as unresolved rather than as permission to retry.
export async function awaitSubmissionWindow(read, options = {}) {
  const {
    tracker,
    timeoutMs = DEFAULT_WAIT.timeoutMs,
    intervalMs = DEFAULT_PACING.pollIntervalMs,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    parse = parseCooldownEvidence,
    parseOptions = {},
  } = options;
  if (!tracker || typeof tracker.observe !== 'function') throw new Error('tracker_required');
  if (!(timeoutMs > 0) || !(intervalMs > 0)) throw new Error('invalid_wait_options');
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) abort();
    else options.signal.addEventListener('abort', abort, { once: true });
  }
  const timeout = new Promise((_, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => reject(new Error('submission_window_timeout')),
      {
        once: true,
      },
    );
  });
  try {
    let lastState = tracker.state(startedAt);
    while (startedAt <= now() && now() <= deadline) {
      const source = await Promise.race([read({ signal: controller.signal }), timeout]);
      const at = now();
      const evidence = parse(source, { ...parseOptions, nowMs: at, observedAtMs: at });
      lastState = tracker.observe(evidence, at);
      if (lastState.status === 'open')
        return { state: 'ready', waitedMs: at - startedAt, evidence, trackerState: lastState };
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await Promise.race([sleep(Math.min(intervalMs, remaining)), timeout]);
    }
    throw new Error('submission_window_timeout');
  } finally {
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
  const version = 3;
  // Field and pattern tables are duplicated here on purpose: this function is serialized
  // into the page and cannot close over module scope. tests/runtime.test.mjs asserts this
  // in-page extractor and parseCooldownEvidence agree on the same fixtures.
  const PACING_FIELDS = [
    'cooldown_seconds',
    'cooldown',
    'interval',
    'interval_seconds',
    'remaining_seconds',
    'wait_seconds',
    'retry_after',
  ];
  const PACING_TIMESTAMPS = [
    'created_at',
    'submit_time',
    'submitted_at',
    'evaluate_time',
    'start_time',
  ];
  const PACING_SECONDS = /(\d+)\s*(?:秒|s\b)/i;
  const PACING_PHRASE =
    /(频繁|稍后再试|请稍候|太频繁|rate.?limit|too many|retry after|请稍后|间隔)/i;
  const SUBMIT_KINDS = ['game_build', 'choose_build'];
  const HISTORY_KINDS = ['evaluate_logs', 'game_status', 'task'];
  const MAX_INTERVAL_MS = 600000;
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
  const runtime = {
    version,
    scopeKey,
    active: true,
    requests: [],
    swaps: [],
    errors: [],
    submissions: [],
  };
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
  // --- In-page pacing extraction ------------------------------------------------------
  // Raw response bodies and credentials stay in page memory. These helpers return only a
  // derived, non-secret summary: which field shape was seen and the measured numbers.
  const parseStamp = (value) => {
    if (value == null) return null;
    if (typeof value === 'number' && Number.isFinite(value))
      return Math.abs(value) < 1e10 ? value * 1000 : value;
    const text = String(value).trim();
    if (!text) return null;
    if (/^\d{9,}$/.test(text)) return parseStamp(Number(text));
    const parsed = Date.parse(/T/.test(text) ? text : text.replace(' ', 'T'));
    return Number.isNaN(parsed) ? null : parsed;
  };
  const numberish = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\s*-?\d+(?:\.\d+)?\s*$/.test(value)) return Number(value);
    return null;
  };
  const scan = (node, names, into) => {
    const wanted = names instanceof Set ? names : new Set(names);
    let visited = 0;
    const walk = (current, depth) => {
      if (current == null || visited >= 4000 || depth > 6) return;
      visited++;
      if (Array.isArray(current)) {
        for (const item of current) walk(item, depth + 1);
        return;
      }
      if (typeof current !== 'object') return;
      for (const [key, value] of Object.entries(current)) {
        if (wanted.has(key) && (typeof value === 'string' || typeof value === 'number'))
          into.push(value);
        walk(value, depth + 1);
      }
    };
    walk(node, 0);
    return into;
  };
  // Derive pacing evidence from one captured record without exposing its body.
  const deriveEvidence = (record) => {
    const evidence = {
      endpoint: record.endpoint,
      status: record.status,
      observedAtMs: record.finishedAt ?? record.startedAt,
      source: 'none',
      remainingMs: null,
      intervalMs: null,
      latestSubmitAtMs: null,
      serverNowAtMs: null,
      rejection: record.status === 429,
      truncated: record.responseComplete === false,
    };
    if (evidence.truncated) return evidence;
    const text = typeof record.response === 'string' ? record.response : '';
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    const haystack = json ? text : text.slice(0, 4000);
    const retryAfter = numberish(record.headers?.['retry-after']);
    if (retryAfter != null && retryAfter >= 0 && retryAfter * 1000 <= MAX_INTERVAL_MS) {
      evidence.remainingMs = retryAfter * 1000;
      evidence.source = 'retry-after';
      return evidence;
    }
    if (!evidence.rejection && PACING_PHRASE.test(haystack)) evidence.rejection = true;
    let explicit = null;
    if (json) {
      for (const value of scan(json, PACING_FIELDS, [])) {
        const number = numberish(value);
        if (number != null && number >= 0 && number * 1000 <= MAX_INTERVAL_MS) {
          explicit = number;
          evidence.source = 'field';
          break;
        }
      }
    }
    if (explicit == null && evidence.rejection) {
      const match = haystack.match(PACING_SECONDS);
      if (match) {
        const seconds = Number(match[1]);
        if (seconds * 1000 <= MAX_INTERVAL_MS) {
          explicit = seconds;
          evidence.source = 'message';
        }
      }
    }
    if (explicit != null) {
      evidence.remainingMs = explicit * 1000;
      return evidence;
    }
    if (!json) return evidence;
    const stamps = scan(json, PACING_TIMESTAMPS, [])
      .map(parseStamp)
      .filter((value) => value != null);
    const serverNow = parseStamp(scan(json, ['now', 'server_time'], [])[0]);
    evidence.serverNowAtMs = serverNow;
    if (stamps.length >= 2) {
      stamps.sort((a, b) => a - b);
      evidence.latestSubmitAtMs = stamps.at(-1);
      const gaps = stamps.slice(1).map((value, i) => value - stamps[i]);
      const positive = gaps.filter((gap) => gap >= 1000 && gap <= MAX_INTERVAL_MS);
      if (positive.length) evidence.intervalMs = Math.min(...positive);
    }
    if (evidence.intervalMs != null && serverNow != null && evidence.latestSubmitAtMs != null) {
      const remaining = evidence.latestSubmitAtMs + evidence.intervalMs - serverNow;
      evidence.remainingMs = Math.max(0, Math.min(remaining, evidence.intervalMs));
      evidence.source = evidence.remainingMs > 0 ? 'cadence' : 'cadence-open';
    } else if (evidence.intervalMs != null) {
      evidence.source = 'interval-only';
    }
    return evidence;
  };
  const newestBy = (kinds) => {
    let chosen = null;
    for (const record of runtime.requests) {
      if (!record || !kinds.includes(record.endpoint)) continue;
      if (record.method !== 'GET' || record.status == null) continue;
      chosen = record;
    }
    return chosen;
  };
  runtime.noteSubmit = (at) => {
    if (!runtime.active) throw new Error('runtime_uninstalled');
    const atMs = Number.isFinite(at) ? at : Date.now();
    const latest = runtime.submissions.at(-1);
    if (latest && latest.atMs === atMs) return latest;
    boundedPush(
      runtime.submissions,
      { atMs, seq: runtime.submissions.length + 1 },
      limits.maxRecords,
    );
    return runtime.submissions.at(-1);
  };
  // Returns derived pacing evidence only. Never returns bodies, headers or credentials.
  runtime.pacingEvidence = () => {
    if (!runtime.active) throw new Error('runtime_uninstalled');
    const submitRecord = newestBy(SUBMIT_KINDS);
    const historyRecord = newestBy(HISTORY_KINDS);
    const candidates = [];
    if (submitRecord) candidates.push(deriveEvidence(submitRecord));
    if (historyRecord) candidates.push(deriveEvidence(historyRecord));
    // Prefer a declared wait; otherwise a measured cadence. Never synthesize one.
    const rank = (evidence) =>
      evidence.source === 'none' || evidence.source === 'interval-only' ? 0 : 1;
    let best = null;
    for (const evidence of candidates) {
      if (!best) best = evidence;
      else if (rank(evidence) > rank(best)) best = evidence;
      else if (
        rank(evidence) === rank(best) &&
        evidence.remainingMs != null &&
        best.remainingMs == null
      )
        best = evidence;
    }
    return {
      evidence: best,
      submissions: runtime.submissions.map((value) => ({ ...value })),
      observed: candidates.length,
    };
  };
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
    submissions: runtime.submissions.map((value) => ({ ...value })),
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
    runtime.submissions.length = 0;
    if (window[slot] === runtime) delete window[slot];
  };
  window[slot] = runtime;
  return { installed: true, version };
}
