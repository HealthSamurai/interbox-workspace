/**
 * The page shell.
 *
 * Structure only — every list, sheet and log entry is built in the browser from
 * the bootstrap payload below and from what the API returns. Keeping the shell
 * static means the server never interpolates document text into markup, so the
 * one place that turns a document into HTML is the allow-list in
 * src/cda/narrative.ts and there is no second path to audit.
 */

export interface PageProps {
  /** Handed to the browser as the page's starting state. */
  bootstrap: unknown;
}

/**
 * JSON for embedding inside a `<script>` block.
 *
 * A script element holds raw text: entity escaping would survive into
 * `textContent` and break the parse, so the escaping has to happen inside the
 * JSON itself.
 *
 * JSON.stringify escapes neither `</script>` nor `<!--`, so a value containing
 * either closes the block early and the rest of the payload becomes markup. The
 * values here are file names and clinical text from documents this tool did not
 * write, which is exactly the case that matters.
 */
export const safeJson = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, "\\u003c").replace(/-->/g, "--\\u003e").replace(/\u2028|\u2029/g, (c) =>
    c === "\u2028" ? "\\u2028" : "\\u2029");

export function renderPage({ bootstrap }: PageProps): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>C-CDA Sender</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/app.css">
</head>
<body>

<header class="topbar">
  <div class="brand">
    <h1>C-CDA Sender</h1>
    <span class="tag">documents into the integration engine</span>
  </div>
  <div class="topbar-right">
    <span class="count" id="count"></span>
    <button class="ghost" id="settings-open" type="button">Library settings</button>
    <button class="ghost" id="rescan" type="button">Rescan</button>
  </div>
</header>

<main class="grid">

  <aside class="col library">
    <div class="col-head"><span class="eyebrow">Sample library</span></div>
    <label class="search">
      <span id="search-icon"></span>
      <input id="filter" type="search" placeholder="Filter by patient, type or file" autocomplete="off" spellcheck="false">
    </label>
    <div class="tabs" id="tabs" hidden></div>
    <div class="list" id="list"></div>
    <div class="hint">
      <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
      <span><kbd>Enter</kbd> send</span>
    </div>
  </aside>

  <section class="col stage" id="stage"></section>

  <aside class="col console">
    <div class="col-head"><span class="eyebrow">Endpoint</span></div>
    <div class="field">
      <input id="endpoint" type="url" spellcheck="false" autocomplete="off">
    </div>
    <div class="field">
      <button class="send" id="send" type="button" disabled><span id="send-icon"></span>Send document</button>
      <button class="send-alt" id="send-group" type="button" disabled>Send all in group</button>
      <div class="note" id="note"></div>
      <div class="batch" id="batch" hidden></div>
    </div>
    <div class="col-head" style="border-top:1px solid var(--rule); padding-top:12px">
      <span class="eyebrow">Run log</span>
      <span class="count" id="log-count" style="margin-left:auto"></span>
    </div>
    <div class="log" id="log"></div>
  </aside>

</main>

<div class="dropveil" id="dropveil" hidden><div class="box">Drop a C-CDA document to read it</div></div>

<dialog class="settings" id="settings">
  <div class="set-head">
    <h2>Library settings</h2>
    <span class="where" id="set-where"></span>
  </div>
  <div class="set-body" id="set-main">
    <div class="warn" id="set-warn" hidden></div>
    <div id="set-folders"></div>
    <div class="add">
      <span class="eyebrow">Add a folder</span>
      <div class="row-add">
        <input id="set-path" type="text" placeholder="/path/to/a/folder/of/documents" spellcheck="false" autocomplete="off" autofocus>
        <button class="btn" id="set-browse" type="button">Browse…</button>
        <button class="btn" id="set-add" type="button" disabled>Add</button>
      </div>
      <div class="verdict" id="set-verdict"></div>
      <div class="tip">Paste a path, or browse for one. In Finder, ⌥⌘C copies the path of the selected folder.</div>
    </div>
  </div>

  <div class="set-body browse" id="set-browse-pane" hidden>
    <div class="crumbs">
      <button class="btn small" id="brw-home" type="button">Home</button>
      <button class="btn small" id="brw-up" type="button">↑ Up</button>
      <span class="here mono" id="brw-here"></span>
    </div>
    <div class="brw-list" id="brw-list"></div>
    <div class="brw-pick" id="brw-pick"></div>
  </div>

  <div class="set-foot" id="set-foot">
    <span class="note" id="set-note"></span>
    <button class="btn primary" id="set-save" type="button">Save and rescan</button>
    <button class="btn" id="set-cancel" type="button">Cancel</button>
  </div>
  <div class="set-foot" id="brw-foot" hidden>
    <span class="note" id="brw-note"></span>
    <button class="btn primary" id="brw-use" type="button" disabled>Use this folder</button>
    <button class="btn" id="brw-back" type="button">Back</button>
  </div>
</dialog>

<script type="application/json" id="bootstrap">${safeJson(bootstrap)}</script>
<script type="module" src="/app.js"></script>
</body>
</html>`;
}
