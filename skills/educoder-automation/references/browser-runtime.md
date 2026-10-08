# Connect through the current host

Read the available browser tool's documentation first. Tool names, tab adoption,
page evaluation and imports vary between hosts. A Node REPL is not itself a
browser connection. Do not assume every call has a fresh kernel or assume an
undocumented `agent`/`browser` global exists.

## Capability selection

- Prefer the user's referenced tab. Otherwise inventory existing browser tabs
  using the host API and select/create one controlled working tab.
- If the host supports a documented page evaluator that can serialize a function,
  use `scripts/runtime.mjs` through that evaluator. Read its tool restrictions;
  availability of evaluation does not override restrictions on network hooks.
- If evaluation/imports are unavailable or restricted, use supported UI editor,
  save, network observation and result-reading operations. Keep the same scope,
  save-readback and submission-correlation requirements. Report a missing
  capability if those operations cannot complete the requested work.
- Do not assume Monaco input is always broken. Try a supported editor operation
  when appropriate and verify persistence. Background-input failures and brittle
  React-fiber walks were observations of a previous ZCode setup, not a reason to
  bypass a working documented API on another host.

## Optional legacy ZCode adapter

Use this adapter only if the host's setup instructions confirm the browser client
contract below. The plugin root may be provided explicitly or discovered from
the host's ZCODE_PLUGIN_ROOT/CLAUDE_PLUGIN_ROOT environment variables; those names
are legacy discovery hints, not requirements for other hosts. Resolve and verify
the client module location before importing it.

```js
async function connectLegacyEduCoderBrowser({ pluginRoot, clientPath, pageOrigin, tabId }) {
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { access } = await import('node:fs/promises');
  if (!pluginRoot && !clientPath) throw new Error('legacy_client_location_required');
  if (!pageOrigin || !tabId) throw new Error('browser_context_required');
  const resolvedClient = clientPath ?? join(pluginRoot, 'scripts', 'browser-client.mjs');
  await access(resolvedClient);
  const client = await import(pathToFileURL(resolvedClient).href);
  if (typeof client.setupBrowserRuntime !== 'function') throw new Error('unsupported_browser_client');
  await client.setupBrowserRuntime({ globals: globalThis });
  if (typeof globalThis.agent?.browsers?.getForUrl !== 'function') {
    throw new Error('browser_connection_unavailable');
  }
  const browser = await globalThis.agent.browsers.getForUrl(pageOrigin);
  if (typeof browser.tabs?.get !== 'function') throw new Error('tab_lookup_unavailable');
  const tab = await browser.tabs.get(tabId);
  if (typeof tab.playwright?.evaluate !== 'function') throw new Error('page_evaluation_unavailable');
  return { browser, tab };
}
```

Retain the resulting bindings according to the REPL's persistence rules; reconnect
after reset or a lost session, not mechanically at every call. Select a viewport
only if a required control is inaccessible; no particular resolution is needed
for correctness.

## Classroom entry and recovery

An entry action can use `window.open`, same-tab navigation or a blocked popup.
After the action, inspect both current URL and tab inventory. Adopt a new tab
through the documented host API when required. Legacy versions exposed
`browser.user.openTabs()` and `claimTab`; use those only if currently documented.

If a tab cannot be restored, preserve its URL and any unsaved solution text,
reconnect or create a controlled replacement, and navigate through the supported
API. Do not close a user-owned tab automatically. After recovery verify login,
task/game scope, saved file contents and outstanding evaluation before resuming.
