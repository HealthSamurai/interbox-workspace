/**
 * The sender's browser half.
 *
 * Plain DOM, no framework and no build step — the tool has to come up on a
 * stand that may have no route to the internet, so the page depends on nothing
 * it cannot serve itself. Fonts degrade to the system stack for the same reason.
 *
 * Everything that came out of a document is written with textContent. The two
 * exceptions are the narrative and the highlighted XML, which the server builds
 * by allow-list precisely so they can be inserted as markup here.
 */

const CONFIG = JSON.parse(document.getElementById("bootstrap").textContent);

const state = {
  groups: [],
  filter: "",
  /** Which folder the list is narrowed to, or null for all of them. */
  group: null,
  /** Ids in display order — what the arrow keys walk. */
  order: [],
  selected: null,
  /** A file dropped onto the page, which is not in the library. */
  dropped: null,
  doc: null,
  view: "narrative",
  log: [],
  batch: null,
  loadToken: 0,
};

const $ = (sel) => document.querySelector(sel);

/**
 * Keep the end of a long identifier, not the start.
 *
 * Vendor filenames here are OIDs whose first thirty characters are the same
 * across a whole directory; the digits that identify the document are at the
 * end. CSS cannot truncate from the left on a string of digits — with no strong
 * direction in the text, `direction: rtl` reorders it instead of clipping it —
 * so the cut is made here, where the string is known.
 */
const tail = (text, max) => (text.length <= max ? text : `…${text.slice(text.length - max + 1)}`);
const el = (tag, className, text) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
};

const ICON_SEARCH = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/></svg>`;
const ICON_SEND = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M14.5 1.5 7 9M14.5 1.5 10 14.5 7 9 1.5 6z"/></svg>`;

/* ------------------------------------------------------------------ library */

const matches = (sample, needle) =>
  needle === "" ||
  sample.file.toLowerCase().includes(needle) ||
  (sample.patientName ?? "").toLowerCase().includes(needle) ||
  (sample.custodian ?? "").toLowerCase().includes(needle) ||
  (sample.title ?? "").toLowerCase().includes(needle);

function renderTabs() {
  const tabs = $("#tabs");
  // One folder needs no switching, and the group heading already names it.
  tabs.hidden = state.groups.length < 2;
  if (tabs.hidden) return;

  const needle = state.filter.trim().toLowerCase();
  const chip = (label, count, value) => {
    const b = el("button", "chip");
    b.type = "button";
    b.setAttribute("aria-pressed", String(state.group === value));
    b.append(el("span", "lbl", label));
    b.append(el("span", "n", String(count)));
    if (value !== null) b.title = state.groups.find((g) => g.label === value)?.dir ?? label;
    b.addEventListener("click", () => {
      state.group = state.group === value ? null : value;
      renderLibrary();
    });
    return b;
  };

  const all = state.groups.reduce((n, g) => n + g.samples.filter((s) => matches(s, needle)).length, 0);
  tabs.replaceChildren(chip("All", all, null));
  for (const group of state.groups) {
    tabs.append(chip(group.label, group.samples.filter((s) => matches(s, needle)).length, group.label));
  }
}

function renderLibrary() {
  const list = $("#list");
  const needle = state.filter.trim().toLowerCase();
  list.replaceChildren();
  state.order = [];
  renderTabs();

  let shown = 0;
  for (const group of state.groups) {
    if (state.group !== null && group.label !== state.group) continue;
    const visible = group.samples.filter((s) => matches(s, needle));
    if (visible.length === 0 && group.error === null) continue;

    // With one folder chosen, its chip is already the heading — a second one
    // right underneath says the same thing twice.
    if (state.group === null) {
      const head = el("div", "group-head");
      head.append(el("span", "eyebrow", group.label));
      head.append(el("span", "n", String(visible.length)));
      head.title = group.dir;
      list.append(head);
    }

    if (group.error) {
      list.append(el("div", "group-err", `${group.error} — ${group.dir}`));
    }

    for (const sample of visible) {
      list.append(rowFor(sample));
      state.order.push(sample.id);
      shown += 1;
    }
  }

  if (shown === 0) {
    list.append(el("div", "log-empty", needle === ""
      ? "No documents in this folder."
      : `Nothing matches “${state.filter}”${state.group ? ` in ${state.group}` : ""}.`));
  }
  $("#count").textContent = countLabel(shown, needle !== "" || state.group !== null);
}

function countLabel(shown, filtered) {
  const total = state.groups.reduce((n, g) => n + g.samples.length, 0);
  if (total === 0) return "no documents";
  if (filtered) return `${shown} of ${total} documents`;
  return `${total} document${total === 1 ? "" : "s"} · ${state.groups.length} group${state.groups.length === 1 ? "" : "s"}`;
}

function rowFor(sample) {
  const row = el("button", "row");
  row.type = "button";
  row.dataset.id = sample.id;
  row.setAttribute("aria-selected", String(state.selected === sample.id));
  row.title = sample.file;

  // What a row leads with is what tells one document from the next. A vendor
  // filename is an OID and a de-identified export gives every patient the same
  // name, so the document's own type comes first, then the two facts that
  // actually differ: when it was written and which site wrote it.
  row.append(el("div", "r1", sample.title ?? sample.file));

  const r2 = el("div", "r2");
  if (!sample.isClinicalDocument) r2.append(el("span", "flag", "not a CDA"));
  r2.append(el("span", "t", sample.date ?? sample.file));
  r2.append(el("span", "s", sample.size));
  row.append(r2);

  const detail = sample.custodian ?? sample.patientName;
  if (detail) row.append(el("div", "r3", detail));

  row.addEventListener("click", () => select(sample.id));
  return row;
}

/* --------------------------------------------------------------- selection */

function select(id, opts = {}) {
  state.selected = id;
  state.dropped = null;
  rememberLocation();
  for (const row of document.querySelectorAll(".row")) {
    row.setAttribute("aria-selected", String(row.dataset.id === id));
    if (row.dataset.id === id && opts.scroll) row.scrollIntoView({ block: "nearest" });
  }
  loadDocument(id);
  renderConsole();
}

function move(delta) {
  if (state.order.length === 0) return;
  const at = state.order.indexOf(state.selected);
  const next = at === -1
    ? (delta > 0 ? 0 : state.order.length - 1)
    : Math.min(state.order.length - 1, Math.max(0, at + delta));
  select(state.order[next], { scroll: true });
}

/**
 * Keep the address bar pointing at what is on screen.
 *
 * A document in this library is worth linking to — "look at the one that fails"
 * is the everyday sentence around a stand — and the link survives a reload.
 */
function rememberLocation() {
  const url = new URL(location.href);
  if (state.selected) url.searchParams.set("doc", state.selected);
  else url.searchParams.delete("doc");
  url.searchParams.set("view", state.view);
  history.replaceState(null, "", url);
}

const sampleById = (id) => {
  for (const g of state.groups) for (const s of g.samples) if (s.id === id) return s;
  return null;
};

const groupOf = (id) => state.groups.find((g) => g.samples.some((s) => s.id === id)) ?? null;

/* ------------------------------------------------------------ the document */

async function loadDocument(id) {
  const token = ++state.loadToken;
  showLoading();
  try {
    const res = await fetch(`/api/document/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(await res.text());
    const doc = await res.json();
    if (token !== state.loadToken) return; // A later selection already won.
    state.doc = doc;
    renderSheet();
  } catch (err) {
    if (token !== state.loadToken) return;
    state.doc = null;
    showEmpty("This document could not be read", String(err.message ?? err));
  }
}

async function previewDropped(file) {
  const token = ++state.loadToken;
  state.selected = null;
  for (const row of document.querySelectorAll(".row")) row.setAttribute("aria-selected", "false");
  showLoading();
  try {
    const res = await fetch(`/api/preview?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
    if (!res.ok) throw new Error(await res.text());
    const doc = await res.json();
    if (token !== state.loadToken) return;
    state.dropped = { file, name: file.name };
    state.doc = doc;
    renderSheet();
    renderConsole();
  } catch (err) {
    if (token !== state.loadToken) return;
    // Clear it, or Send still points at whatever was dropped before this one and
    // silently sends that instead.
    state.dropped = null;
    state.doc = null;
    showEmpty("That file could not be read", String(err.message ?? err));
    renderConsole();
  }
}

function showLoading() {
  const box = el("div", "empty");
  box.append(el("strong", null, "Reading the document…"));
  $("#stage").replaceChildren(box);
}

function showEmpty(title, body, code) {
  const box = el("div", "empty");
  box.append(el("strong", null, title));
  const p = el("p", null, body);
  if (code) { p.append(document.createTextNode(" ")); p.append(el("code", null, code)); }
  box.append(p);
  $("#stage").replaceChildren(box);
}

function renderSheet() {
  const doc = state.doc;
  if (!doc) return;

  const sheet = el("div", "sheet fade");

  const head = el("div", "dochead");
  head.append(el("div", "docname", doc.header.title ?? doc.name));
  const sub = [doc.header.patientName, doc.header.custodian].filter(Boolean).join(" · ");
  if (sub) head.append(el("div", "docsub", sub));

  const facts = el("div", "facts");
  const fact = (k, v, mono) => {
    if (!v) return;
    const f = el("div", "fact");
    f.append(el("div", "k", k));
    f.append(el("div", mono ? "v id" : "v", v));
    facts.append(f);
  };
  // The title is already the heading; repeating it as a field would spend a
  // column on something the reader just read.
  fact("Effective time", doc.header.effectiveTime);
  fact("MRN", doc.header.mrn, true);
  fact("Born", [doc.header.birthTime, doc.header.sex].filter(Boolean).join(" · "));
  fact("Document id", doc.header.documentId, true);
  head.append(facts);

  const fileLine = el("div", "fileline");
  fileLine.append(el("span", "f", doc.name));
  fileLine.title = doc.name;
  fileLine.append(el("span", "b", doc.size));
  head.append(fileLine);
  sheet.append(head);

  const bar = el("div", "viewbar");
  const seg = el("div", "seg");
  for (const [key, label] of [["narrative", "Narrative"], ["xml", "XML"]]) {
    const b = el("button", null, label);
    b.type = "button";
    b.setAttribute("aria-pressed", String(state.view === key));
    b.addEventListener("click", () => { state.view = key; rememberLocation(); renderSheet(); });
    seg.append(b);
  }
  bar.append(seg);
  bar.append(el("span", "meta", state.view === "narrative"
    ? `${doc.sections.length} section${doc.sections.length === 1 ? "" : "s"}${doc.sectionsTruncated ? " (more not read)" : ""}`
    : xmlMeta(doc.xml)));
  sheet.append(bar);

  sheet.append(state.view === "narrative" ? renderNarrative(doc) : renderXml(doc));

  $("#stage").replaceChildren(sheet);
}

const xmlMeta = (xml) => {
  const size = `${xml.totalChars.toLocaleString()} chars`;
  // A reformatted document is not necessarily a one-line one: the viewer
  // re-indents anything written with very long lines, and a 2,000-line export
  // can be among them. Say how many lines the file has and that it was
  // re-indented, rather than asserting something the file may contradict.
  if (xml.reformatted) {
    const src = xml.totalLines === 1 ? "one line in the file" : `${xml.totalLines.toLocaleString()} lines in the file`;
    return `${src} · ${size} · reformatted`;
  }
  return `${xml.totalLines.toLocaleString()} lines · ${size}`;
};

function renderNarrative(doc) {
  if (doc.sections.length === 0) {
    const box = el("div", "sec-body empty-narrative");
    box.style.padding = "18px 22px";
    box.textContent = doc.header.isClinicalDocument
      ? "This document has no section narratives."
      : "This file is not a C-CDA, so there is nothing to read. The XML view shows what it actually contains.";
    return box;
  }

  const wrap = el("div", "sections");
  doc.sections.forEach((section, i) => {
    const node = el("div", "section");
    // The first sections open, the tail collapsed: a discharge summary runs to
    // two dozen sections and an all-open document is a scroll, not a read.
    node.dataset.open = String(i < 3);

    const head = el("button", "sec-head");
    head.type = "button";
    head.append(el("div", "sec-code", section.code ?? ""));
    const mid = el("div");
    mid.append(el("div", "sec-title", section.title || "Untitled section"));
    if (section.level > 0) mid.append(el("div", "sec-sub", "subsection"));
    head.append(mid);
    head.append(el("div", "chev", "\u203A"));
    head.addEventListener("click", () => {
      node.dataset.open = node.dataset.open === "true" ? "false" : "true";
      body.hidden = node.dataset.open !== "true";
    });
    node.append(head);

    const body = el("div", "sec-body");
    if (section.html) {
      // Server-sanitized: every element and attribute here came off an
      // allow-list in src/cda/narrative.ts.
      body.innerHTML = section.html;
      for (const table of body.querySelectorAll("table")) {
        const wrapper = el("div", "tablewrap");
        table.replaceWith(wrapper);
        wrapper.append(table);
      }
    } else {
      body.className = "sec-body empty-narrative";
      body.textContent = "No narrative in this section.";
    }
    if (section.clipped) body.append(el("div", "clip-note", "narrative truncated for display"));
    body.hidden = node.dataset.open !== "true";
    node.append(body);
    wrap.append(node);
  });
  return wrap;
}

function renderXml(doc) {
  const wrap = el("div");
  const view = el("div", "xml");
  const gutter = el("div", "gutter");
  const numbers = [];
  for (let i = 1; i <= doc.xml.shownLines; i += 1) numbers.push(i);
  gutter.textContent = numbers.join("\n");
  view.append(gutter);

  const code = el("div", "code");
  const pre = document.createElement("pre");
  // Server-escaped: highlightXml emits only spans, and every other character
  // is escaped on the way out.
  pre.innerHTML = doc.xml.html;
  code.append(pre);
  view.append(code);
  wrap.append(view);

  const bar = el("div", "xml-more");
  let hasNote = false;

  if (doc.xml.reformatted) {
    bar.append(el("span", null, "This document is stored as a single line. Indented here for reading."));
    hasNote = true;
  }
  if (!doc.xml.complete) {
    bar.append(el("span", null, hasNote ? "" : `Showing the first ${doc.xml.shownLines.toLocaleString()} lines.`));
    bar.append(loadMoreButton(doc, false));
    hasNote = true;
  }
  if (doc.xml.reformatted) {
    bar.append(loadMoreButton(doc, true));
    hasNote = true;
  }
  if (hasNote) wrap.append(bar);
  return wrap;
}

/**
 * Fetch the document again — either all of it, or exactly as the file has it.
 *
 * Both are deliberate acts with a cost the reader should choose to pay: the
 * whole document can be twelve megabytes, and the raw form of a single-line
 * export is one very long line.
 */
function loadMoreButton(doc, raw) {
  const btn = el("button", "ghost", raw ? "Show the raw file" : "Show the whole document");
  btn.type = "button";
  btn.addEventListener("click", async () => {
    if (state.dropped) { toast("Drop the file again to read more of it."); return; }
    const label = btn.textContent;
    const token = ++state.loadToken;
    btn.disabled = true;
    btn.textContent = "Loading…";
    try {
      // For a re-indented document `totalLines` counts the FILE's lines — one,
      // for a minified export — while the view is measured in re-indented ones.
      // Asking for the file's count would fetch a single line and come back
      // still incomplete, so ask by what is being shown instead.
      const lines = raw ? 400 : Math.max(doc.xml.totalLines, doc.xml.shownLines * 20, 200_000);
      const res = await fetch(`/api/document/${encodeURIComponent(state.selected)}?lines=${lines}${raw ? "&raw=1" : ""}`);
      // The id can have stopped resolving since the sheet was drawn — a rescan
      // removed the file. Without this the body is text/plain and res.json()
      // rejects into nothing.
      if (!res.ok) throw new Error(await res.text());
      const doc2 = await res.json();
      // A newer selection already won: its sheet is on screen, and overwriting
      // state.doc here would show this document under that document's highlight.
      if (token !== state.loadToken) return;
      state.doc = doc2;
      renderSheet();
    } catch (err) {
      if (token !== state.loadToken) return;
      toast(String(err.message ?? err));
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });
  return btn;
}

/* ------------------------------------------------------------------ sending */

const endpoint = () => $("#endpoint").value.trim();

function renderConsole() {
  const has = state.selected !== null || state.dropped !== null;
  $("#send").disabled = !has;
  const group = state.selected ? groupOf(state.selected) : null;
  const groupBtn = $("#send-group");
  groupBtn.disabled = group === null || state.batch !== null;
  groupBtn.textContent = group ? `Send all ${group.samples.length} in ${group.label}` : "Send all in group";
  $("#note").textContent = has ? "" : "Select a document to send.";
}

/** Reads a /api/send reply, or turns a failure into the same shape the log draws.
 *  The route answers a refusal as text/plain, so `res.json()` on it rejects — and
 *  an unhandled rejection here leaves a batch stuck and the button disabled. */
async function readSendReply(res) {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, statusText: res.statusText, ms: 0, body: text.slice(0, 8192), transportError: null };
  }
  return res.json();
}

async function sendOne(label, request) {
  const started = new Date();
  let res;
  try {
    res = await request();
  } catch (err) {
    res = { ok: false, status: null, statusText: "", ms: 0, body: "", transportError: String(err?.message ?? err) };
  }
  addLogEntry({
    time: started,
    name: label,
    status: res.status,
    statusText: res.statusText,
    ok: res.ok,
    ms: res.ms,
    body: res.body,
    transportError: res.transportError,
  });
  return res;
}

const sendSelected = () => {
  if (state.dropped) {
    const file = state.dropped.file;
    return sendOne(file.name, async () => {
      const r = await fetch(`/api/send?endpoint=${encodeURIComponent(endpoint())}&name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
      return readSendReply(r);
    });
  }
  if (!state.selected) return Promise.resolve(null);
  const sample = sampleById(state.selected);
  // Nothing to send if the selection outlived its document — say so rather than
  // throwing past the caller, which sent nothing and logged nothing either.
  if (!sample) {
    toast("That document is no longer in the library. Rescan and pick another.");
    return Promise.resolve(null);
  }
  return sendOne(sample.file, async () => {
    const r = await fetch("/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: state.selected, endpoint: endpoint() }),
    });
    return readSendReply(r);
  });
};

async function sendGroup() {
  const group = state.selected ? groupOf(state.selected) : null;
  if (!group || state.batch) return;
  state.batch = { done: 0, total: group.samples.length, failed: 0, stop: false };
  renderBatch();
  renderConsole();
  for (const sample of group.samples) {
    if (state.batch.stop) break;
    const res = await sendOne(sample.file, async () => {
      const r = await fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: sample.id, endpoint: endpoint() }),
      });
      return readSendReply(r);
    });
    state.batch.done += 1;
    if (!res.ok) state.batch.failed += 1;
    renderBatch();
  }
  const { done, total, failed, stop } = state.batch;
  // Cleared before anything that could throw: a batch left in place disables the
  // buttons and freezes the progress box until the page is reloaded.
  state.batch = null;
  renderBatch();
  renderConsole();
  toast(stop
    ? `Stopped after ${done} of ${total}.`
    : `Sent ${done} document${done === 1 ? "" : "s"}${failed ? `, ${failed} rejected` : ""}.`);
}

function renderBatch() {
  const box = $("#batch");
  box.replaceChildren();
  if (!state.batch) { box.hidden = true; return; }
  box.hidden = false;
  const { done, total, failed } = state.batch;
  const line = el("div");
  line.append(el("span", null, `Sending ${done} of ${total}${failed ? ` · ${failed} rejected` : ""}`));
  const stop = el("button", "ghost", "Stop");
  stop.type = "button";
  stop.style.marginLeft = "8px";
  stop.addEventListener("click", () => { if (state.batch) state.batch.stop = true; });
  line.append(stop);
  box.append(line);
  const bar = el("div", "bar");
  const fill = el("i");
  fill.style.width = `${total === 0 ? 0 : (done / total) * 100}%`;
  bar.append(fill);
  box.append(bar);
}

/* ------------------------------------------------------------------ run log */

const LOG_LIMIT = 300;

function addLogEntry(entry) {
  state.log.unshift(entry);
  if (state.log.length > LOG_LIMIT) state.log.length = LOG_LIMIT;
  renderLog();
}

const clock = (d) => d.toTimeString().slice(0, 8);

function renderLog() {
  const box = $("#log");
  box.replaceChildren();
  $("#log-count").textContent = state.log.length === 0 ? "" : String(state.log.length);

  if (state.log.length === 0) {
    box.append(el("div", "log-empty", "No sends yet."));
    return;
  }

  const slowest = Math.max(...state.log.map((e) => e.ms), 1);

  for (const entry of state.log) {
    const node = el("div", "entry fade");
    const head = el("button", "entry-head");
    head.type = "button";

    const kind = entry.transportError ? "none" : entry.ok ? "ok" : "bad";
    head.append(el("span", `dot ${kind}`));
    head.append(el("span", "time", clock(entry.time)));
    const name = el("span", "name", tail(entry.name, 26));
    name.title = entry.name;
    head.append(name);
    head.append(el("span", "ms", entry.transportError ? "—" : `${Math.round(entry.ms)} ms`));
    node.append(head);

    const rail = el("div", "durbar");
    const fill = el("i", kind === "none" ? "" : kind);
    fill.style.width = `${Math.max(2, (entry.ms / slowest) * 100)}%`;
    rail.append(fill);
    node.append(rail);

    const body = el("div", "entry-body");
    const status = el("span", "status", entry.transportError
      ? entry.transportError
      : `${entry.status} ${entry.statusText}`.trim());
    body.append(status);
    if (entry.body) { body.append(document.createTextNode("\n")); body.append(document.createTextNode(entry.body)); }
    body.hidden = true;
    head.addEventListener("click", () => { body.hidden = !body.hidden; });
    node.append(body);

    box.append(node);
  }
}

/* ------------------------------------------------------------------ toasts */

let toastTimer = null;
function toast(message) {
  const existing = $(".toast");
  if (existing) existing.remove();
  const node = el("div", "toast", message);
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 4000);
}

/* ------------------------------------------------------- library settings */

/**
 * Folder editing, held apart from the live library until you press Save.
 *
 * `draft` is a working copy: nothing you type here changes what the window is
 * showing, so cancelling really does cancel and one mistyped path cannot empty
 * the library you are in the middle of using.
 */
const settings = { draft: [], probe: null, probeTimer: null };

function openSettings() {
  settings.draft = CONFIG.config.roots.map((r) => ({ ...r, documents: null }));
  showBrowser(false);
  settings.probe = null;
  $("#set-path").value = "";
  $("#set-verdict").textContent = "";
  $("#set-verdict").className = "verdict";
  $("#set-add").disabled = true;
  $("#set-where").textContent = CONFIG.config.configPath;
  $("#set-where").title = CONFIG.config.configPath;

  const warn = $("#set-warn");
  warn.hidden = !CONFIG.config.envOverride;
  if (CONFIG.config.envOverride) {
    warn.replaceChildren(
      document.createTextNode("CCDA_SAMPLE_DIRS is set in the environment, and the environment wins. What you save here goes into the file, but the window keeps listing the folders that variable names until it is unset."),
    );
  }
  renderFolders();
  $("#settings").showModal();
}

function renderFolders() {
  const box = $("#set-folders");
  box.replaceChildren();

  if (settings.draft.length === 0) {
    box.append(el("div", "set-empty", "No folders yet. Add one below."));
    return;
  }

  settings.draft.forEach((root, i) => {
    const row = el("div", "folder");

    const label = document.createElement("input");
    label.className = "label";
    label.type = "text";
    label.value = root.label;
    label.setAttribute("aria-label", "Group heading");
    label.addEventListener("input", () => { root.label = label.value; });
    row.append(label);

    const path = el("div", "path", root.dir);
    path.title = root.dir;
    row.append(path);

    const count = el("span", "n", root.documents == null ? "" : `${root.documents} documents`);
    row.append(count);

    const drop = el("button", "drop", "\u00D7");
    drop.type = "button";
    drop.title = "Remove this folder";
    drop.setAttribute("aria-label", `Remove ${root.label}`);
    drop.addEventListener("click", () => {
      settings.draft.splice(i, 1);
      renderFolders();
    });
    row.append(drop);

    box.append(row);
    // Fill in the count in the background — it is what tells you at a glance
    // that a folder is still the one you meant.
    if (root.documents == null) {
      probe(root.dir).then((p) => {
        root.documents = p.documents;
        count.textContent = p.error ? p.error : `${p.documents} documents`;
        count.classList.toggle("bad", Boolean(p.error));
      });
    }
  });
}

const probe = async (dir) => {
  const res = await fetch("/api/config/probe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dir }),
  });
  return res.json();
};

function onPathTyped() {
  const value = $("#set-path").value;
  clearTimeout(settings.probeTimer);
  settings.probe = null;
  $("#set-add").disabled = true;
  const verdict = $("#set-verdict");
  if (value.trim() === "") { verdict.textContent = ""; verdict.className = "verdict"; return; }
  verdict.textContent = "Looking…";
  verdict.className = "verdict";
  settings.probeTimer = setTimeout(async () => {
    const p = await probe(value);
    if ($("#set-path").value !== value) return; // Typed on; this answer is stale.
    settings.probe = p;
    if (p.error) {
      verdict.textContent = p.error;
      verdict.className = "verdict bad";
      // A real folder with no documents is still worth adding — it may fill up.
      $("#set-add").disabled = !(p.isDirectory && p.documents === 0);
      if (p.isDirectory) verdict.className = "verdict";
      return;
    }
    const below = p.documentsBelow > 0 ? ` — ${p.documentsBelow} more sit one folder down` : "";
    verdict.textContent = `${p.documents} documents, listed as “${p.label}”${below}`;
    verdict.className = "verdict ok";
    $("#set-add").disabled = false;
  }, 260);
}

function addFolder(probeResult) {
  const p = probeResult ?? settings.probe;
  if (!p || !p.isDirectory) return;
  if (settings.draft.some((r) => r.dir === p.dir)) { toast("That folder is already listed."); return; }
  settings.draft.push({ dir: p.dir, label: p.label, documents: p.documents });
  $("#set-path").value = "";
  $("#set-verdict").textContent = "";
  $("#set-verdict").className = "verdict";
  $("#set-add").disabled = true;
  settings.probe = null;
  renderFolders();
}

async function saveSettings() {
  const btn = $("#set-save");
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    const res = await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roots: settings.draft.map((r) => ({ dir: r.dir, label: r.label })) }),
    });
    if (!res.ok) throw new Error(await res.text());
    const next = await res.json();
    CONFIG.config = next.config;
    CONFIG.library = next.library;
    state.groups = next.library.groups;
    state.group = null;
    state.selected = null;
    state.doc = null;
    renderLibrary();
    renderConsole();
    showEmpty("Nothing selected", "Pick a document from the library, or drop a C-CDA file anywhere on this page.");
    $("#settings").close();
    toast(`${next.library.total} document${next.library.total === 1 ? "" : "s"} in ${next.library.groups.length} folder${next.library.groups.length === 1 ? "" : "s"}.`);
  } catch (err) {
    toast(String(err.message ?? err));
  } finally {
    btn.disabled = false;
    btn.textContent = "Save and rescan";
  }
}

/**
 * The folder browser.
 *
 * `here` is what the server last described; `pick` is the folder that "Use this
 * folder" would add. They are the same thing — you add the folder you are
 * standing in — which keeps the question to one at a time: is this the level
 * that holds the documents?
 */
const browser = { here: null };

async function browseTo(dir) {
  const res = await fetch("/api/config/browse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dir }),
  });
  const listing = await res.json();
  browser.here = listing;
  renderBrowser();
}

function showBrowser(show) {
  $("#set-main").hidden = show;
  $("#set-browse-pane").hidden = !show;
  $("#set-foot").hidden = show;
  $("#brw-foot").hidden = !show;
}

function renderBrowser() {
  const listing = browser.here;
  $("#brw-here").textContent = listing.dir;
  $("#brw-here").title = listing.dir;
  $("#brw-up").disabled = listing.parent === null;

  const list = $("#brw-list");
  list.replaceChildren();

  if (listing.error) {
    list.append(el("div", "brw-empty", listing.error));
  } else if (listing.entries.length === 0) {
    list.append(el("div", "brw-empty", "No subfolders here."));
  } else {
    for (const entry of listing.entries) {
      const row = el("button", "brw-row");
      row.type = "button";
      row.append(el("span", "ico", "\u25B8"));
      row.append(el("span", "nm", entry.name));

      const ct = el("span", "ct");
      if (entry.documents > 0) {
        const b = el("b", null, String(entry.documents));
        ct.append(b);
        ct.append(document.createTextNode(" documents"));
      } else if (entry.subfolders > 0) {
        ct.append(document.createTextNode(`${entry.subfolders} subfolder${entry.subfolders === 1 ? "" : "s"}`));
      } else {
        ct.append(document.createTextNode("empty"));
      }
      row.append(ct);

      row.addEventListener("click", () => browseTo(entry.path));
      list.append(row);
    }
  }

  const pick = $("#brw-pick");
  pick.replaceChildren();
  const summary = el("div");
  summary.append(document.createTextNode("This folder holds "));
  summary.append(el("b", null, `${listing.documents} document${listing.documents === 1 ? "" : "s"}`));
  summary.append(document.createTextNode("."));
  pick.append(summary);
  // The count one level down is what catches the everyday mistake: picking the
  // folder above the one that actually holds the documents.
  if (listing.documentsBelow > 0) {
    pick.append(el("div", "sub", `${listing.documentsBelow} more sit inside the folders listed above — open one to use it.`));
  }

  $("#brw-use").disabled = listing.error !== null || listing.documents === 0;
  $("#brw-note").textContent = listing.documents === 0
    ? (listing.documentsBelow > 0 ? "Open one of the folders above." : "Nothing to list here.")
    : "";
}

function useBrowsedFolder() {
  const listing = browser.here;
  if (!listing) return;
  addFolder({
    dir: listing.dir,
    label: listing.dir.split("/").filter(Boolean).pop() ?? listing.dir,
    isDirectory: true,
    documents: listing.documents,
  });
  showBrowser(false);
}

/* --------------------------------------------------------------- wiring up */

async function rescan() {
  const btn = $("#rescan");
  btn.disabled = true;
  try {
    const res = await fetch("/api/library", { method: "POST" });
    const lib = await res.json();
    state.groups = lib.groups;
    if (state.group !== null && !lib.groups.some((g) => g.label === state.group)) state.group = null;
    // The library on screen has just been replaced. A selection that survived the
    // rescan still names its own document — ids are derived from the path — but a
    // document that was removed leaves a selection pointing at nothing, and the
    // stage would go on showing it while Send had nothing to send. Drop it, and
    // redraw the console so the button matches what is actually selected.
    if (state.selected && !sampleById(state.selected)) {
      state.selected = null;
      state.doc = null;
    }
    renderLibrary();
    renderConsole();
    toast(`${lib.total} document${lib.total === 1 ? "" : "s"} in ${Math.round(lib.scanMs)} ms.`);
  } finally {
    btn.disabled = false;
  }
}

function installDropTarget() {
  let depth = 0;
  const veil = $("#dropveil");
  document.addEventListener("dragenter", (e) => {
    if (![...e.dataTransfer.types].includes("Files")) return;
    e.preventDefault();
    depth += 1;
    veil.hidden = false;
  });
  document.addEventListener("dragover", (e) => { if (!veil.hidden) e.preventDefault(); });
  document.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (depth === 0) veil.hidden = true; });
  document.addEventListener("drop", (e) => {
    if (veil.hidden) return;
    e.preventDefault();
    depth = 0;
    veil.hidden = true;
    const file = e.dataTransfer.files[0];
    if (file) previewDropped(file);
  });
}

function installKeyboard() {
  document.addEventListener("keydown", (e) => {
    // The settings dialog owns the keyboard while it is open — otherwise an
    // arrow key typed in a path field would also walk the library behind it.
    if ($("#settings").open) return;
    const inEndpoint = e.target === $("#endpoint");
    if (e.key === "ArrowDown" && !inEndpoint) { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp" && !inEndpoint) { e.preventDefault(); move(-1); }
    else if (e.key === "Enter" && !inEndpoint && !$("#send").disabled) { e.preventDefault(); sendSelected(); }
    else if (e.key === "Escape" && e.target === $("#filter")) { $("#filter").value = ""; state.filter = ""; renderLibrary(); }
  });
}

function boot() {
  $("#search-icon").innerHTML = ICON_SEARCH;
  $("#send-icon").innerHTML = ICON_SEND;

  const saved = localStorage.getItem("ccda-sender.endpoint");
  $("#endpoint").value = saved ?? CONFIG.config.endpoint;
  $("#endpoint").addEventListener("change", () => localStorage.setItem("ccda-sender.endpoint", endpoint()));

  $("#filter").addEventListener("input", (e) => { state.filter = e.target.value; renderLibrary(); });
  $("#settings-open").addEventListener("click", openSettings);
  $("#set-cancel").addEventListener("click", () => $("#settings").close());
  $("#set-path").addEventListener("input", onPathTyped);
  $("#set-path").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !$("#set-add").disabled) { e.preventDefault(); addFolder(); }
  });
  $("#set-add").addEventListener("click", () => addFolder());
  $("#set-browse").addEventListener("click", () => {
    showBrowser(true);
    const start = settings.draft.at(-1)?.dir ?? $("#set-path").value;
    browseTo(start || "");
  });
  $("#brw-back").addEventListener("click", () => showBrowser(false));
  $("#brw-up").addEventListener("click", () => browser.here?.parent && browseTo(browser.here.parent));
  $("#brw-home").addEventListener("click", () => browseTo(""));
  $("#brw-use").addEventListener("click", useBrowsedFolder);
  $("#set-save").addEventListener("click", saveSettings);
  $("#set-note").textContent = "Saved to the file above; the window rescans straight away.";
  $("#rescan").addEventListener("click", rescan);
  $("#send").addEventListener("click", () => sendSelected());
  $("#send-group").addEventListener("click", sendGroup);

  state.groups = CONFIG.library.groups;
  renderLibrary();
  renderLog();
  renderConsole();
  renderBatch();
  installDropTarget();
  installKeyboard();

  const params = new URLSearchParams(location.search);
  const view = params.get("view");
  if (view === "xml" || view === "narrative") state.view = view;
  const wanted = params.get("doc");

  if (wanted && sampleById(wanted)) {
    select(wanted, { scroll: true });
  } else if (CONFIG.config.problem) {
    showEmpty("Nothing to list yet", CONFIG.config.problem + " Library settings is in the top right.");
  } else {
    showEmpty("Nothing selected", "Pick a document from the library, or drop a C-CDA file anywhere on this page.");
  }
}

boot();
