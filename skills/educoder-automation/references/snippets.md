# Runtime usage and verified workflows

Use these examples after connecting a controlled tab through the current host's
documented browser API. The examples use the legacy `tab.playwright.evaluate`
interface only when that interface is supported. Adapt transport calls to the
actual host; do not import an undocumented browser client to force compatibility.

All executable examples are functions with explicit arguments. Call them with
values discovered in the current session. They contain no example answer keys,
fixed file paths, credentials, or angle-bracket placeholders.

## 1. Load the shared helpers and install observation

Run in a Node runtime that permits local module imports. `skillDirectory` is the
resolved directory containing the SKILL.md being used, not a baked-in user path.

```js
async function loadEduCoderHelpers(skillDirectory) {
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  return import(pathToFileURL(join(skillDirectory, 'scripts', 'runtime.mjs')).href);
}

async function installEduCoderRuntime(tab, helpers, context, platform, limitOverrides = {}) {
  const scope = helpers.createScope(context, platform ?? helpers.DEFAULT_PLATFORM);
  const limits = { ...helpers.DEFAULT_LIMITS, ...limitOverrides };
  await tab.playwright.evaluate(helpers.installPageRuntime, { scope, limits });
  return scope;
}
```

`context` contains the live `pageUrl`, optional explicitly checked `taskId`,
`myshixunId`, `gameId`, optional `challengeId`/`userId`, and the discovered
`allowedPaths`. Initial task observation can use an empty file list and no
experiment ID; inspect the current task response and the host's observed app
requests to obtain the remaining scope. Before arming saves, reinstall with the
complete game/experiment/file scope. It will replace the old capture state.

If the app already loaded its task data before the hook, use a read-only UI action
that issues the needed request or the host's supported network observation. Do
not submit a build just to discover a token or ID.

Installation is idempotent for the same scope and limits. On a full page
navigation install again. On a SPA task change create a new scope; old captures
and armed solutions must not carry over.

## 2. Capture, inspect and clear

The page runtime lives at `window.__educoderAutomation` and records both fetch
and XHR. Each record has a monotonically increasing `id`, URL, method, normalized
headers, request body, endpoint, timestamps, HTTP status and response. Request
and response truncation are explicit (`bodyComplete`, `responseComplete`). Never
parse a truncated JSON response as if it were complete; increase a named limit
only when needed and repeat a read-only request.

Raw data stays in page memory. Extract only the required non-secret fields within
page evaluation. Headers include the actual `pc-authorization`, signature and
timestamp when sent; `zzud` can be read with `new URL(record.url).searchParams`.
Do not print these values. No universal credential lifetime is assumed.

```js
async function runtimeStatus(tab) {
  return tab.playwright.evaluate(() => {
    if (!window.__educoderAutomation) throw new Error('runtime_not_installed');
    return window.__educoderAutomation.snapshot();
  });
}

async function clearEduCoderRuntime(tab) {
  await tab.playwright.evaluate(() => window.__educoderAutomation?.uninstall());
}
```

The snapshot excludes headers and bodies and removes credential query parameters.
Record IDs are local traffic IDs, **not server evaluation IDs**. Restore conflicts
are reported rather than overwriting another tool's subsequently installed hook.
An uninstalled wrapper becomes inert even if another wrapper still references it.

## 3. Arm saves and read them back

```js
async function armEduCoderSolutions(tab, solutions) {
  await tab.playwright.evaluate(values => {
    if (!window.__educoderAutomation) throw new Error('runtime_not_installed');
    window.__educoderAutomation.setSolutions(values);
  }, solutions);
}
```

`solutions` maps each actual allowed repository path to its complete prepared
UTF-8 text, including an empty string when intended. The runtime replaces only a
POST to this experiment's exact save endpoint with the bound game/context and
known file path. It supports URL/init and Request-style fetch calls plus XHR;
malformed, truncated or uninspectable targeted bodies fail before saving.

Use the app's normal save or evaluation operation. Check `swaps` and the matching
save response, then read back the entire saved content. Swaps record preparation
attempts and can exist even when a network request fails. They are not save
confirmation. Match each response to its own request ID, not simply the newest
response of a different file.

When content is base64 encoded in the current API schema, decode it in page
context with `new TextDecoder('utf-8').decode(Uint8Array.from(atob(base64), c =>
c.charCodeAt(0)))`. Check the field exists and the response is complete first.
Do not compare only output fragments or assume successful compilation proves a
save succeeded.

## 4. Multi-file request preparation

`helpers.prepareFileSave(record, scope, path, content)` checks a complete captured
POST body against the live experiment/game/context, preserves all existing fields
and changes only path/content. It rejects unknown files and cross-game payloads.

This helper returns a body object, not an authenticated request. Prefer the UI
save path. Before any direct API save, verify the current signing behavior and
obtain a fresh valid request for that operation through the supported adapter.
Do not replay a captured mutation automatically, reuse a GET signature, replace
context fields with empty values, or infer success solely from `sec_key`.

## 5. Evaluation reader contract

Provide an adapter-specific reader which reads this submission's current
result. Resolve the actual submission identity from the accepted app build and
its newly created history entry, compared with the baseline read before clicking.
The reader returns:

- `submissionId`: actual server evaluation identity, or an unambiguous current
  record identity derived from observed task/game/time/sequence data.
- `completed`: true only for a confirmed terminal state in the live schema.
- `pass`: true/false when the schema explicitly provides a verdict, otherwise
  `text`: the exact verdict label from that completed record.

Keep evaluation identity distinct from game IDs and local traffic IDs. If the
platform cannot correlate a new record reliably, report unresolved verification;
do not label an old record as the current submission. Pass the supplied
AbortSignal to network reads where the adapter supports it.

```js
async function awaitEduCoderEvaluation(helpers, readCurrentRecord, submissionId, waitOverrides = {}) {
  return helpers.waitForVerdict(readCurrentRecord, {
    ...helpers.DEFAULT_WAIT, ...waitOverrides, submissionId,
  });
}
```

Unknown, blank, pending and stale records continue polling within the deadline.
Confirmed failure returns `state: 'failed'`; timeout throws `evaluation_timeout`.
Do not turn either result into another blind submission. A hung read is bounded
by the overall timer; adapters should honor cancellation to stop the underlying
operation too. Cooldown and rate-limit handling comes from observed app state,
not a fixed delay or page refresh.

## 6. Choice input and payload verification

Locate inputs within each question's own block. Build the wanted state from its
actual option IDs and the reasoned answer. Check option count and input type,
then use documented state-setting operations or normal option clicks. Re-locate
after rerenders rather than retaining detached input nodes.

Verify both the settled UI state and, on the intended submission, its captured
answer array and server echo where available. A native setter plus `change` event
does not universally update a React/Ant Design controlled state. If the mapping
cannot be established, stop to inspect the question metadata instead of toggling
every global checkbox or submitting a distinctive wrong selection.

## 7. Next-level and file evidence

```js
function nextEduCoderLevel(helpers, href, currentPageUrl, platform) {
  return helpers.resolveNextUrl(href, currentPageUrl, platform);
}

function latestEduCoderFileRead(helpers, records, scope) {
  return helpers.latestReadPath(records, scope);
}
```

Navigation accepts relative or absolute URLs on the configured page origin,
checks the task route and returns null for a missing next link. Confirm the
experiment's final state before declaring completion. Use the host's documented
navigation operation only after validation.

The latest read helper filters to the current task and known file paths and uses
the newest matching request. It is evidence to cross-check against the UI active
file, not an authoritative active-editor selector. Resource timing's first
`rep_content` entry is not used.
