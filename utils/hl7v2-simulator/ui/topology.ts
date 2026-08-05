/**
 * Source UI — topology view (M2): the multi-source simulator as a live map.
 *
 * Visual language from mockup concept-p-topology: source nodes around a central
 * engine hub, colored dots flying along bezier curves INTO the hub. Everything
 * here is live: nodes come from /sources, a dot is spawned per real SSE tick
 * (no fake looping animation), counters/status update from the same events.
 * The classic single-stream page stays at /classic.
 */

interface TargetOpt { id: string; label: string; host: string; port: number; mock?: boolean }

export interface TopologyProps {
  targets: TargetOpt[];
  activeTargetId: string;
  profile: string;
  exportDir: string;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderTopologyPage({ targets, activeTargetId, profile, exportDir }: TopologyProps): string {
  const targetOpts = targets
    .filter((t) => !t.mock)
    .map((t) => `<option value="${esc(t.id)}"${t.id === activeTargetId ? " selected" : ""}>${esc(t.label)} · :${t.port}</option>`)
    .join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Interbox Source — Topology</title>
<style>
  :root {
    --bg:#F4F4F0; --paper:#FFF; --paper-2:#FAFAF6; --paper-3:#EFEEEA;
    --line:#DEDDD6; --line-2:#C4C2BA; --ink:#131310; --ink-2:#5C5B55; --ink-3:#92918A;
    --orange:#E55A1F; --orange-soft:#FFEDE0; --green:#2D8659; --green-soft:#D4ECDF;
    --red:#D43E3E; --red-soft:#FBE0E0; --mustard:#C28B25; --mustard-soft:#FBF0D6;
    --blue:#3463C9; --blue-soft:#DDE6F6; --purple:#7C3AED; --purple-soft:#EAE0FC;
  }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--ink); font-family:-apple-system,'Segoe UI',sans-serif; font-size:13.5px; line-height:1.5; min-height:100vh; padding:28px 16px; display:flex; justify-content:center; }
  .mono { font-family:ui-monospace,Menlo,monospace; }
  .canvas { width:1120px; display:flex; flex-direction:column; background:var(--paper); border-radius:14px; border:1px solid var(--line); overflow:hidden; box-shadow:0 14px 38px rgba(0,0,0,0.06); }
  .head { padding:14px 22px; border-bottom:1px solid var(--line); background:var(--paper-2); display:flex; align-items:center; gap:16px; }
  .brand { display:flex; align-items:center; gap:10px; font-weight:700; font-size:14px; }
  .brand-mark { width:26px; height:26px; background:var(--ink); color:var(--paper); display:flex; align-items:center; justify-content:center; font-family:ui-monospace,monospace; font-size:13px; border-radius:7px; }
  .brand small { color:var(--ink-3); font-weight:500; font-size:11px; }
  .head-right { margin-left:auto; display:flex; gap:10px; align-items:center; }
  .tgt-select { padding:7px 10px; border:1px solid var(--line); border-radius:8px; background:var(--paper); font:inherit; font-size:12.5px; }
  .view-toggle { background:var(--paper); border:1px solid var(--line); border-radius:8px; padding:3px; display:flex; gap:2px; }
  .view-tab { padding:6px 12px; font-family:ui-monospace,monospace; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.06em; color:var(--ink-3); border-radius:6px; cursor:pointer; text-decoration:none; }
  .view-tab.active { background:var(--ink); color:var(--paper); }
  .add-btn { background:var(--orange); color:#fff; border:none; padding:8px 14px; border-radius:8px; font:inherit; font-size:13px; font-weight:600; cursor:pointer; }
  .all-btn { border:1px solid var(--line2); background:var(--paper); color:var(--ink); padding:7px 13px; border-radius:8px; font:inherit; font-size:12.5px; font-weight:600; cursor:pointer; white-space:nowrap; }
  .all-btn.stop { background:var(--ink); color:var(--paper); border-color:var(--ink); }
  .main { display:grid; grid-template-columns:1fr 280px; background:var(--paper-2); flex:1; min-height:0; }
  .stage { position:relative; overflow:hidden;
    background-image:linear-gradient(rgba(0,0,0,0.025) 1px,transparent 1px),linear-gradient(90deg,rgba(0,0,0,0.025) 1px,transparent 1px);
    background-size:28px 28px; }
  .stage svg.flow { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }
  /* Node cards — floorplan card language: colored type strip on top, colored
     left edge, message-types line, bold "rate · sent" status line. */
  .node { position:absolute; width:158px; background:var(--paper); border:1.5px solid var(--line-2); border-radius:10px; overflow:hidden; box-shadow:0 2px 6px rgba(0,0,0,0.06); cursor:pointer; }
  .node.idle { opacity:0.75; }
  .node.selected { border-color:var(--orange); box-shadow:0 0 0 2px var(--orange-soft),0 4px 12px rgba(229,90,31,0.18); opacity:1; }
  .node-strip { display:flex; align-items:center; justify-content:space-between; padding:3px 10px 3px 12px; font-family:ui-monospace,monospace; font-size:8.5px; font-weight:700; letter-spacing:0.14em; }
  .node-strip.lab { background:var(--blue-soft); color:var(--blue); }
  .node-strip.clinic { background:var(--green-soft); color:var(--green); }
  .node-strip.hospital { background:var(--mustard-soft); color:var(--mustard); }
  .node-strip.pharmacy { background:var(--purple-soft); color:var(--purple); }
  .node-edge { position:absolute; left:0; top:0; bottom:0; width:5px; }
  .node-edge.lab { background:var(--blue); } .node-edge.clinic { background:var(--green); } .node-edge.hospital { background:var(--mustard); }
  .node-edge.pharmacy { background:var(--purple); }
  .node-body { padding:7px 10px 8px 14px; }
  .node-name { font-size:12px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .node-types { font-family:ui-monospace,monospace; color:var(--ink-2); font-size:9px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:1px; }
  .node-stat { font-family:ui-monospace,monospace; font-size:10.5px; font-weight:600; margin-top:6px; }
  .node-stat.idle-txt { color:var(--ink-3); font-weight:500; }
  .node-status-dot { width:7px; height:7px; border-radius:50%; flex:0 0 auto; }
  .status-live { background:var(--green); animation:pulse 1.2s ease-in-out infinite; }
  .status-idle { background:var(--ink-3); }
  @keyframes pulse { 50% { opacity:0.3; } }
  .ico-eng { background:var(--ink); color:var(--paper); width:40px; height:40px; font-size:14px; border-radius:10px; display:flex; align-items:center; justify-content:center; }
  /* Engine hub — the hero. Light "instrument panel": white core with an orange
     top rule for identity; a green "live" dot and orange rate light up only
     while traffic flows, so the card reads its own health at a glance. */
  .hub { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:202px; color:var(--ink); border-radius:14px; overflow:hidden; z-index:5;
    background:linear-gradient(165deg,#FFFFFF 0%,#FAFAF6 100%); border-top:3px solid var(--orange);
    box-shadow:0 10px 30px rgba(0,0,0,0.12), inset 0 0 0 1px #EDECE6; transition:box-shadow 0.4s ease; }
  .hub.flowing { box-shadow:0 10px 32px rgba(0,0,0,0.14), inset 0 0 0 1px #EDECE6, 0 0 0 3px rgba(45,134,89,0.12); }
  .hub-strip { display:flex; align-items:center; justify-content:space-between; background:#F7F6F1; font-family:ui-monospace,monospace; font-size:8px; font-weight:700; letter-spacing:0.14em; padding:5px 12px; border-bottom:1px solid #EDECE6; }
  .hub-strip-t { color:var(--ink-3); }
  .hub-feed { color:var(--ink-2); font-weight:600; letter-spacing:0; margin-left:6px; }
  .hub-cell-v.ok { color:var(--green); } .hub-cell-v.err { color:var(--red); }
  .brand-tot { margin-left:10px; font-size:11px; font-weight:500; color:var(--ink-3); }
  .hub-link { display:flex; align-items:center; gap:5px; color:var(--ink-3); text-transform:uppercase; letter-spacing:0.1em; }
  .hub-link-dot { width:6px; height:6px; border-radius:50%; background:var(--ink-3); }
  .hub-link.live { color:var(--green); }
  .hub-link.live .hub-link-dot { background:var(--green); animation:pulse 1.2s ease-in-out infinite; }
  .hub-hero { display:flex; align-items:baseline; gap:6px; margin-bottom:12px; padding-bottom:12px; border-bottom:1px solid #EDECE6; }
  .hub-hero-v { font-family:ui-monospace,monospace; font-size:30px; font-weight:700; line-height:1; color:var(--ink-3); transition:color 0.4s ease; }
  .hub.flowing .hub-hero-v { color:var(--orange); }
  .hub-hero-u { font-family:ui-monospace,monospace; font-size:9.5px; color:var(--ink-3); text-transform:uppercase; letter-spacing:0.08em; }
  .hub-row { display:flex; gap:8px; }
  .hub-cell { flex:1; background:#F4F3EE; border-radius:8px; padding:7px 8px; }
  .hub-cell-k { display:block; font-family:ui-monospace,monospace; font-size:8px; color:var(--ink-3); text-transform:uppercase; letter-spacing:0.07em; font-weight:600; margin-bottom:3px; }
  .hub-cell-v { font-family:ui-monospace,monospace; font-size:14px; font-weight:700; color:var(--ink); }
  .hub-inner { padding:13px 14px 14px; }
  .hub-h { display:flex; align-items:center; gap:10px; margin-bottom:12px; }
  .hub-title { font-weight:700; font-size:15px; }
  .hub-title small { display:block; font-family:ui-monospace,monospace; color:var(--ink-3); font-size:10px; margin-top:2px; }
  .inspector { background:var(--paper); border-left:1px solid var(--line); padding:18px; display:flex; flex-direction:column; gap:14px; overflow-y:auto; }
  .ins-h { font-family:ui-monospace,monospace; font-size:10px; text-transform:uppercase; letter-spacing:0.14em; color:var(--ink-3); margin-bottom:6px; font-weight:600; }
  .ins-name { font-size:16px; font-weight:700; }
  .ins-name small { color:var(--ink-3); font-weight:500; font-size:11px; font-family:ui-monospace,monospace; display:block; margin-top:2px; }
  .ins-section { border-bottom:1px solid var(--line); padding-bottom:14px; }
  .ins-section:last-child { border-bottom:none; padding-bottom:0; }
  .ctl { margin-bottom:10px; }
  .ctl-row { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:4px; }
  .ctl-k { font-family:ui-monospace,monospace; font-size:10px; color:var(--ink-2); text-transform:uppercase; letter-spacing:0.1em; font-weight:600; }
  .ctl-v { font-size:14px; font-weight:700; }
  .ctl input[type=range] { width:100%; accent-color:var(--orange); }
  .ins-stats { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
  .ins-stat-cell { background:var(--paper-2); border:1px solid var(--line); border-radius:8px; padding:7px 9px; }
  .ins-stat-k { font-family:ui-monospace,monospace; font-size:9px; color:var(--ink-3); text-transform:uppercase; font-weight:600; }
  .ins-stat-v { font-size:15px; font-weight:700; }
  .ins-stat-v.err { color:var(--red); }
  .ins-stat-v.ok { color:var(--green); }
  /* Accepted + Rejected + Unanswered sum to Sent; Malformed is a property of
     the content, not an outcome of delivery. The gap says so without a caption. */
  .ins-stat-cell.axis-split { grid-column:1 / -1; margin-top:7px; border-style:dashed; }
  .ins-actions { display:flex; gap:8px; flex-wrap:wrap; }
  .ins-btn { background:var(--paper); border:1px solid var(--line); color:var(--ink); padding:8px 12px; border-radius:8px; font:inherit; font-size:12.5px; font-weight:600; cursor:pointer; flex:1; min-width:80px; }
  .ins-btn.primary { background:var(--ink); color:var(--paper); border-color:var(--ink); }
  .ins-btn.danger { color:var(--red); border-color:var(--red-soft); }
  .ins-btn:disabled { opacity:0.5; cursor:default; }
  .legend { position:absolute; bottom:14px; left:14px; background:rgba(255,255,255,0.85); backdrop-filter:blur(6px); border:1px solid var(--line); border-radius:8px; padding:7px 12px; display:flex; gap:14px; font-family:ui-monospace,monospace; font-size:10px; color:var(--ink-2); text-transform:uppercase; letter-spacing:0.08em; font-weight:600; }
  .legend-item { display:flex; align-items:center; gap:5px; }
  .legend-dot { width:7px; height:7px; border-radius:50%; }
  .empty-ins { color:var(--ink-3); font-size:12.5px; }
  /* Add-source modal */
  .modal-back { position:fixed; inset:0; background:rgba(19,19,16,0.35); display:none; align-items:center; justify-content:center; z-index:50; }
  .modal-back.open { display:flex; }
  .modal { width:380px; background:var(--paper); border-radius:14px; padding:20px; box-shadow:0 20px 50px rgba(0,0,0,0.25); }
  .modal h3 { font-size:15px; margin-bottom:14px; }
  .f { margin-bottom:12px; }
  .f label { display:block; font-family:ui-monospace,monospace; font-size:10px; text-transform:uppercase; letter-spacing:0.1em; color:var(--ink-2); font-weight:600; margin-bottom:4px; }
  .f input, .f select { width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:8px; font:inherit; font-size:13px; }
  .f .hint { font-size:11px; color:var(--ink-3); margin-top:3px; }
  .probe-ok { color:var(--green); } .probe-bad { color:var(--red); }
  .name-row { display:flex; gap:6px; }
  .name-row input { flex:1; }
  .dice-btn { border:1px solid var(--line); background:var(--paper-2); border-radius:8px; width:38px; font-size:16px; cursor:pointer; }
  .dice-btn:hover { background:var(--orange-soft); border-color:var(--orange); }
  .type-pills { display:flex; gap:6px; }
  .type-pill { flex:1; border:1.5px solid var(--line); background:var(--paper); border-radius:10px; padding:8px 6px 7px; font:inherit; font-size:12px; font-weight:700; cursor:pointer; text-align:center; color:var(--ink-2); }
  .type-pill small { display:block; font-family:ui-monospace,monospace; font-size:8.5px; font-weight:500; color:var(--ink-3); margin-top:2px; }
  .tp-dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:5px; vertical-align:1px; }
  .type-pill.active { color:var(--ink); }
  .type-pill.lab.active { border-color:var(--blue); background:var(--blue-soft); }
  .type-pill.clinic.active { border-color:var(--green); background:var(--green-soft); }
  .type-pill.hospital.active { border-color:var(--mustard); background:var(--mustard-soft); }
  .type-pill.pharmacy.active { border-color:var(--purple); background:var(--purple-soft); }
  /* Message-type chips — click to hand-pick what a source emits */
  .msg-chips { display:flex; flex-wrap:wrap; gap:5px; }
  .msg-chip { border:1.5px solid var(--line); background:var(--paper); border-radius:999px; padding:4px 10px; font-family:ui-monospace,monospace; font-size:10px; font-weight:600; color:var(--ink-2); cursor:pointer; }
  .msg-chip:hover { border-color:var(--line-2); }
  .msg-chip.on { background:var(--ink); border-color:var(--ink); color:var(--paper); }
  .chips-hint { font-size:10.5px; color:var(--ink-3); margin-top:5px; }
  .modal-actions { display:flex; gap:8px; margin-top:16px; }
  .m-err { color:var(--red); font-size:12px; margin-top:8px; min-height:16px; }
  .ins-btn.stop { background:var(--ink); color:var(--paper); border-color:var(--ink); }
  .x-grid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; }
  .x-clean { display:flex; align-items:center; gap:7px; font-size:12.5px; color:var(--ink-2); margin-top:12px; cursor:pointer; }
  .x-clean input { width:14px; height:14px; }
  .x-status { font-family:ui-monospace,monospace; font-size:11.5px; color:var(--ink-2); margin-top:8px; min-height:16px; line-height:1.5; }
  .x-status b { color:var(--ink); }
</style>
</head>
<body>
<div class="canvas">
  <div class="head">
    <div class="brand"><span class="brand-mark">S</span> Source <small>· upstream simulator</small><span class="brand-tot mono" id="brandTot"></span></div>
    <div class="head-right">
      <select class="tgt-select mono" id="tgt" title="Global target — where every source without a port override sends">${targetOpts}</select>
      <button class="all-btn" id="allBtn" title="Start or stop every source at once">▶ Start all</button>
      <div class="view-toggle">
        <span class="view-tab active">Topology</span>
        <a class="view-tab" href="/classic">Classic</a>
      </div>
      <button class="all-btn" id="exportBtn" title="Write .hl7 files to a folder — batch or stream">⤓ Files</button>
      <button class="add-btn" id="addBtn">+ Add source</button>
    </div>
  </div>
  <div class="main">
    <div class="stage" id="stage">
      <svg class="flow" id="flow"><g id="curves"></g><g id="dots"></g></svg>
      <div class="hub" id="hub">
        <div class="hub-strip">
          <span class="hub-strip-t">INTEGRATION ENGINE <span class="hub-feed mono" id="hubFeed" title="sources currently feeding this engine">0/0</span></span>
          <span class="hub-link" id="hubLink"><span class="hub-link-dot"></span><span id="hubLinkT">idle</span></span>
        </div>
        <div class="hub-inner">
          <div class="hub-h">
            <div class="ico-eng">⊞</div>
            <div class="hub-title">Interbox<small class="mono" id="hubTarget">—</small></div>
          </div>
          <div class="hub-hero"><span class="hub-hero-v" id="hubRate">0.0</span><span class="hub-hero-u">msg/s in</span></div>
          <div class="hub-row">
            <div class="hub-cell"><span class="hub-cell-k">accepted</span><span class="hub-cell-v ok" id="hubAcc">0</span></div>
            <div class="hub-cell"><span class="hub-cell-k">rejected</span><span class="hub-cell-v err" id="hubRej">0</span></div>
            <div class="hub-cell"><span class="hub-cell-k">no answer</span><span class="hub-cell-v" id="hubUna">0</span></div>
          </div>
        </div>
      </div>
      <div class="legend">
        <div class="legend-item"><span class="legend-dot" style="background:var(--blue);"></span>Lab</div>
        <div class="legend-item"><span class="legend-dot" style="background:var(--green);"></span>Clinic</div>
        <div class="legend-item"><span class="legend-dot" style="background:var(--mustard);"></span>Hospital</div>
        <div class="legend-item"><span class="legend-dot" style="background:var(--purple);"></span>Pharmacy</div>
      </div>
    </div>
    <div class="inspector" id="inspector"><div class="empty-ins">Click a source node to inspect and control it.</div></div>
  </div>
</div>

<div class="modal-back" id="modalBack">
  <div class="modal">
    <h3>Add source</h3>
    <div class="f"><label>Name (becomes MSH-4 sending facility)</label>
      <div class="name-row">
        <input id="mName" placeholder="Sunrise Lab" maxlength="40">
        <button class="dice-btn" id="mDice" title="Generate a name" type="button">🎲</button>
      </div>
    </div>
    <div class="f"><label>Type</label>
      <div class="type-pills" id="mTypePills">
        <button type="button" class="type-pill lab active" data-type="lab"><span class="tp-dot" style="background:var(--blue);"></span>Lab<small>results (ORU)</small></button>
        <button type="button" class="type-pill clinic" data-type="clinic"><span class="tp-dot" style="background:var(--green);"></span>Clinic<small>visits + sched</small></button>
        <button type="button" class="type-pill hospital" data-type="hospital"><span class="tp-dot" style="background:var(--mustard);"></span>Hospital<small>ADT-heavy</small></button>
        <button type="button" class="type-pill pharmacy" data-type="pharmacy"><span class="tp-dot" style="background:var(--purple);"></span>Pharmacy<small>RDE + RAS</small></button>
      </div>
    </div>
    <div class="f"><label>Message types (optional — type preset when none picked)</label>
      <div class="msg-chips" id="mChips"></div>
    </div>
    <div class="f"><label>Stream rate (msg/s)</label><input id="mRate" type="number" min="0.1" max="1000" step="0.1" value="1.0"></div>
    <div class="f"><label>Fault rate (%)</label><input id="mFault" type="number" min="0" max="100" step="1" value="5"></div>
    <div class="f"><label>Own port (optional — overrides the global target)</label>
      <input id="mPort" type="number" min="1" max="65535" placeholder="global target">
      <div class="hint" id="mProbe"></div>
    </div>
    <div class="m-err" id="mErr"></div>
    <div class="modal-actions">
      <button class="ins-btn" id="mCancel">Cancel</button>
      <button class="ins-btn primary" id="mCreate">Create</button>
    </div>
  </div>
</div>

<div class="modal-back" id="exportBack">
  <div class="modal">
    <h3>Export .hl7 files to a folder</h3>
    <div class="f"><label>Folder (a folderSource drains this dir → engine → Aidbox)</label>
      <input id="xDir" placeholder="/path/to/batch-test" value="${esc(exportDir)}">
    </div>
    <div class="f"><label>Message types (optional — profile mix when none picked; round-robin over picks)</label>
      <div class="msg-chips" id="xChips"></div>
    </div>
    <div class="x-grid">
      <div class="f"><label>Count <small>(batch)</small></label><input id="xCount" type="number" min="1" max="100000" step="1" value="10"></div>
      <div class="f"><label>Rate msg/s <small>(stream)</small></label><input id="xRate" type="number" min="0.1" max="200" step="0.1" value="2"></div>
      <div class="f"><label>Fault %</label><input id="xFault" type="number" min="0" max="100" step="1" value="0"></div>
    </div>
    <label class="x-clean"><input type="checkbox" id="xClean" checked> Clean the folder first <small>(batch only)</small></label>
    <div class="m-err" id="xErr"></div>
    <div class="x-status" id="xStatus"></div>
    <div class="modal-actions">
      <button class="ins-btn" id="xCancel">Close</button>
      <button class="ins-btn" id="xStream">▶ Stream</button>
      <button class="ins-btn primary" id="xBatch">⤓ Generate batch</button>
    </div>
  </div>
</div>

<script>
const COLORS = { lab:'#3463C9', clinic:'#2D8659', hospital:'#C28B25', pharmacy:'#7C3AED' };
const TYPE_LABEL = { lab:'LAB', clinic:'CLINIC', hospital:'HOSPITAL', pharmacy:'PHARMACY' };
const TYPE_MSGS  = { lab:'ORU^R01 + ORM^O01', clinic:'ADT^A08 + SIU^S12', hospital:'ADT/ORU + MDM^T02', pharmacy:'RDE^O11 + RAS^O17' };
let ALL_MSG_TYPES = ['ORU^R01','ORM^O01','ADT^A01','ADT^A03','ADT^A08','SIU^S12','MDM^T02','RDE^O11','RAS^O17']; // fallback; served list wins
fetch('/msg-types').then((r) => r.json()).then((d) => { if (d.types && d.types.length) { ALL_MSG_TYPES = d.types; fillModalChips(); } }).catch(() => {});
const typesLine = (s) => s.msgTypes && s.msgTypes.length ? s.msgTypes.join(' / ') : (TYPE_MSGS[s.type] || '');
const stage = document.getElementById('stage');
const flow = document.getElementById('flow');
const inspector = document.getElementById('inspector');

let sources = [];          // last /sources payload
let selected = null;       // selected source id
let positions = {};        // id -> {x,y,cx,cy} node rect + curve start

function stageSize() { const r = stage.getBoundingClientRect(); return { w: r.width, h: r.height }; }

// Layout: alternate left/right columns, spread vertically, hub in the middle.
function layout() {
  const { w, h } = stageSize();
  positions = {};
  const left = sources.filter((_, i) => i % 2 === 0);
  const right = sources.filter((_, i) => i % 2 === 1);
  const place = (list, x, edge) => {
    const gap = h / (list.length + 1);
    list.forEach((s, i) => {
      const y = gap * (i + 1) - 43;
      positions[s.id] = { x, y, cx: edge, cy: y + 43 };
    });
  };
  place(left, 16, 16 + 158);
  place(right, w - 16 - 158, w - 16 - 158);
  flow.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
}

function pathFor(id) {
  const { w, h } = stageSize();
  const p = positions[id];
  if (!p) return '';
  const hx = w / 2 + (p.cx < w / 2 ? -95 : 95);
  const hy = h / 2;
  const mx = (p.cx + hx) / 2;
  return 'M ' + p.cx + ' ' + p.cy + ' Q ' + mx + ' ' + p.cy + ' ' + hx + ' ' + hy;
}

function render() {
  layout();
  stage.querySelectorAll('.node').forEach((n) => n.remove());
  const curves = sources.map((s) =>
    '<path d="' + pathFor(s.id) + '" stroke="' + (COLORS[s.type] || '#888') + '" stroke-width="1.6" fill="none" opacity="' + (s.running ? 0.5 : 0.18) + '"' + (s.running ? '' : ' stroke-dasharray="4,4"') + '/>').join('');
  // Repaint ONLY the static curves. The #dots group is PERSISTENT — never wiped
  // here — so a periodic refresh no longer erases in-flight dots (that made them
  // reset every ~4s). If the layers are missing (first paint), create them once.
  let curvesG = flow.querySelector('#curves');
  if (!curvesG) { flow.innerHTML = '<g id="curves"></g><g id="dots"></g>'; curvesG = flow.querySelector('#curves'); }
  curvesG.innerHTML = curves;
  // A stopped source's lane goes dashed/idle — clear any dots still on it so
  // nothing keeps flying along an idle lane after Stop.
  const dotsG = flow.querySelector('#dots');
  for (const s of sources) {
    if (s.running) continue;
    if (dotsG) dotsG.querySelectorAll('[data-src="' + s.id + '"]').forEach((n) => n.remove());
    liveDots[s.id] = 0;
  }
  for (const s of sources) {
    const p = positions[s.id];
    const el = document.createElement('div');
    el.className = 'node' + (s.id === selected ? ' selected' : '') + (s.running ? '' : ' idle');
    el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
    el.onclick = () => { selected = s.id; render(); };
    const strip = (TYPE_LABEL[s.type] || s.type.toUpperCase()) + (s.targetPort ? ' · :' + s.targetPort : '');
    const stat = s.running
      ? '<div class="node-stat"><span class="node-sent">' + fmtRate(s.rate) + ' msg/s · <span class="sent-n">' + s.counters.sent + '</span> sent</span></div>'
      : '<div class="node-stat idle-txt">Idle · <span class="sent-n">' + s.counters.sent + '</span> sent</div>';
    el.innerHTML =
      '<div class="node-strip ' + s.type + '"><span>' + escapeHtml(strip) + '</span>' +
      '<span class="node-status-dot ' + (s.running ? 'status-live' : 'status-idle') + '"></span></div>' +
      '<div class="node-edge ' + s.type + '"></div>' +
      '<div class="node-body"><div class="node-name">' + escapeHtml(title(s.name)) + '</div>' +
      '<div class="node-types">' + escapeHtml(typesLine(s)) + '</div>' + stat + '</div>';
    stage.appendChild(el);
  }
  renderInspector();
  renderHub();
  updateAllBtn();
}

// Smart toggle: shows Stop all while anything streams, Start all otherwise.
function updateAllBtn() {
  const btn = document.getElementById('allBtn');
  if (!btn) return;
  const anyRunning = sources.some((s) => s.running);
  btn.textContent = anyRunning ? '■ Stop all' : '▶ Start all';
  btn.classList.toggle('stop', anyRunning);
}

function title(name) { return name.toLowerCase().replace(/\\b[a-z]/g, (c) => c.toUpperCase()); }
function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// Log-scale rate slider: position 0..100 -> 0.1..1000 msg/s (0.1 @0, 1 @25,
// 10 @50, 100 @75, 1000 @100) — fine control at demo rates, load rates reachable.
function rateFromPos(pos) { const r = Math.pow(10, (pos * 4) / 100 - 1); return r < 10 ? Math.round(r * 10) / 10 : Math.round(r); }
function posFromRate(rate) { return Math.max(0, Math.min(100, Math.round(((Math.log10(rate) + 1) * 100) / 4))); }
function fmtRate(r) { return r < 10 ? r.toFixed(1) : String(Math.round(r)); }

let rateHist = [];
let lastAnswered = 0;

// "No answer" must mean "never came back", not "still in flight". At any instant
// a message that has just been written is unanswered for the few milliseconds
// until its ACK lands, so the raw figure oscillates 0/1 and carries no
// information. What matters is the part that never clears — the FLOOR of the
// value over a short window: in-flight traffic floors at zero, a genuinely
// silent engine floors at however many are stuck.
const UNANSWERED_WINDOW_MS = 4000;
const unaHist = new Map();
function settledUnanswered(key, value) {
  const now = Date.now();
  const h = (unaHist.get(key) || []).filter((e) => now - e.t <= UNANSWERED_WINDOW_MS);
  h.push({ t: now, v: value });
  unaHist.set(key, h);
  return h.reduce((m, e) => Math.min(m, e.v), value);
}
let lastAnswerAt = 0;
// How long after the last answer the link still reads live. Covers a slow
// source's gap without keeping a stopped stream lit.
const LIVE_GRACE_MS = 3000;
function renderHub() {
  // This card is the ENGINE's card, so it shows only what the engine itself told
  // us — its ACKs. accepted (AA), rejected (AE/AR) and no-answer are its
  // words. What WE did — how much we sent, how much we deliberately malformed —
  // is the generator's business and lives in the generator's own header.
  const acc = sources.reduce((n, s) => n + (s.counters.accepted || 0), 0);
  const rej = sources.reduce((n, s) => n + (s.counters.rejected || 0), 0);
  const una = sources.reduce((n, s) => n + (s.counters.unanswered || 0), 0);
  const sent = sources.reduce((n, s) => n + s.counters.sent, 0);
  const malformed = sources.reduce((n, s) => n + (s.counters.malformed || 0), 0);
  const feeding = sources.filter((s) => s.running).length;
  document.getElementById('hubAcc').textContent = acc;
  document.getElementById('hubRej').textContent = rej;
  document.getElementById('hubUna').textContent = settledUnanswered('__hub', una);
  document.getElementById('hubFeed').textContent = feeding + '/' + sources.length;
  document.getElementById('brandTot').textContent =
    sent ? (sent + ' sent · ' + malformed + ' malformed') : '';

  // Ingest rate = Δ(answered)/Δt over a 5s window — paced by what the engine
  // confirms, not by what we push. Counters are exact on every tick, so this
  // reads real throughput even though ticks are sampled to ~20/s per source.
  const answered = acc + rej;
  const now = Date.now();
  rateHist.push({ t: now, total: answered });
  rateHist = rateHist.filter((h) => now - h.t <= 5000);
  const dt = (now - rateHist[0].t) / 1000;
  const rate = dt > 0.3 ? Math.max(0, (answered - rateHist[0].total) / dt) : 0;
  document.getElementById('hubRate').textContent = fmtRate(rate);

  // "live" means the engine is answering — not that we are sending. Sending into
  // a dead engine used to light this up, which is the same lie the counters told.
  //
  // Keyed on WHEN the answered total last moved, not on the windowed rate and
  // not on the previous call. renderHub() runs on ticks, on state events and on
  // the 4s poll, so comparing against the last call flickers whenever two fire
  // without an ACK between them. A source at 0.1 msg/s also produces no answers
  // inside a 5s rate window and would flap against a healthy engine.
  if (answered > lastAnswered) { lastAnswered = answered; lastAnswerAt = Date.now(); }
  const live = feeding > 0 && Date.now() - lastAnswerAt < LIVE_GRACE_MS;
  document.getElementById('hubLinkT').textContent = live ? 'live' : (feeding > 0 ? 'no answer' : 'idle');
  document.getElementById('hubLink').classList.toggle('live', live);
  document.getElementById('hub').classList.toggle('flowing', live);
}

// The inspector is REBUILT only when its structure changes (selection, running
// state, rate...). High-rate ticks must not recreate the DOM under the user's
// cursor — that made Stop feel dead (the button was replaced 20x/s mid-click).
// Counters update in place via updateInsCounters().
let insSig = '';
function updateInsCounters(s) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('insSent', s.counters.sent); set('insAcc', s.counters.accepted); set('insRej', s.counters.rejected);
  set('insUna', settledUnanswered(s.id, s.counters.unanswered)); set('insMal', s.counters.malformed);
}
function renderInspector() {
  const s = sources.find((x) => x.id === selected);
  if (!s) { inspector.innerHTML = '<div class="empty-ins">Click a source node to inspect and control it.</div>'; insSig = ''; return; }
  const sig = [s.id, s.running, s.rate, s.faultRate, s.targetPort || 0, (s.msgTypes || []).join(',')].join('|');
  if (sig === insSig) { updateInsCounters(s); return; }
  insSig = sig;
  inspector.innerHTML =
    '<div class="ins-section"><div class="ins-h">Selected source</div>' +
    '<div class="ins-name">' + escapeHtml(title(s.name)) + '<small>' + escapeHtml(s.id) + ' · ' + s.type + (s.targetPort ? ' · port ' + s.targetPort : '') + '</small></div></div>' +
    '<div class="ins-section">' +
    '<div class="ctl"><div class="ctl-row"><span class="ctl-k">Rate</span><span class="ctl-v" id="rateV">' + fmtRate(s.rate) + '<small>/s</small></span></div>' +
    '<input type="range" min="0" max="100" step="1" value="' + posFromRate(s.rate) + '" id="rateSlider" title="log scale: 0.1 — 1000 msg/s"></div>' +
    '<div class="ctl"><div class="ctl-row"><span class="ctl-k">Malformed rate</span><span class="ctl-v" id="faultV">' + Math.round(s.faultRate * 100) + '<small>%</small></span></div>' +
    '<input type="range" min="0" max="50" step="1" value="' + Math.round(s.faultRate * 100) + '" id="faultSlider"></div></div>' +
    '<div class="ins-section"><div class="ins-h">Message types</div><div class="msg-chips">' +
    ALL_MSG_TYPES.map((t) => '<button type="button" class="msg-chip' + ((s.msgTypes || []).includes(t) ? ' on' : '') + '" data-t="' + t + '">' + t + '</button>').join('') +
    '</div><div class="chips-hint">' + (s.msgTypes && s.msgTypes.length ? 'hand-picked, equal shares' : 'preset mix for ' + s.type + ' — click to hand-pick') + '</div></div>' +
    '<div class="ins-section"><div class="ins-h">Counters</div><div class="ins-stats">' +
    '<div class="ins-stat-cell"><div class="ins-stat-k">Sent</div><div class="ins-stat-v" id="insSent">' + s.counters.sent + '</div></div>' +
    '<div class="ins-stat-cell"><div class="ins-stat-k">Accepted</div><div class="ins-stat-v ok" id="insAcc">' + s.counters.accepted + '</div></div>' +
    '<div class="ins-stat-cell"><div class="ins-stat-k">Rejected</div><div class="ins-stat-v err" id="insRej">' + s.counters.rejected + '</div></div>' +
    '<div class="ins-stat-cell"><div class="ins-stat-k">Unanswered</div><div class="ins-stat-v" id="insUna">' + settledUnanswered(s.id, s.counters.unanswered) + '</div></div>' +
    '<div class="ins-stat-cell axis-split"><div class="ins-stat-k">Malformed</div><div class="ins-stat-v" id="insMal">' + s.counters.malformed + '</div></div></div></div>' +
    '<div class="ins-section"><div class="ins-h">Actions</div><div class="ins-actions">' +
    '<button class="ins-btn" id="btnSingle">Single</button>' +
    '<button class="ins-btn" id="btnBurst">Burst 25</button>' +
    (s.running
      ? '<button class="ins-btn primary" id="btnStream">■ Stop</button>'
      : '<button class="ins-btn primary" id="btnStream">▶ Stream</button>') +
    '<button class="ins-btn danger" id="btnRemove">Remove</button></div></div>';

  const sid = s.id;
  document.getElementById('rateSlider').oninput = (e) => { document.getElementById('rateV').innerHTML = fmtRate(rateFromPos(Number(e.target.value))) + '<small>/s</small>'; };
  document.getElementById('rateSlider').onchange = (e) => patch(sid, { rate: rateFromPos(Number(e.target.value)) });
  document.getElementById('faultSlider').oninput = (e) => { document.getElementById('faultV').innerHTML = e.target.value + '<small>%</small>'; };
  document.getElementById('faultSlider').onchange = (e) => patch(sid, { faultRate: Number(e.target.value) / 100 });
  // Message-type chips: toggle → PATCH the full active set (empty = back to preset)
  inspector.querySelectorAll('.msg-chip').forEach((chip) => {
    chip.onclick = () => {
      chip.classList.toggle('on');
      const active = [...inspector.querySelectorAll('.msg-chip.on')].map((c) => c.dataset.t);
      patch(sid, { msgTypes: active });
    };
  });
  document.getElementById('btnSingle').onclick = () => post('/sources/' + sid + '/send', { mode: 'single' });
  document.getElementById('btnBurst').onclick = () => post('/sources/' + sid + '/send', { mode: 'burst', count: 25 });
  document.getElementById('btnStream').onclick = () => post('/sources/' + sid + '/stream', { action: s.running ? 'stop' : 'start' });
  document.getElementById('btnRemove').onclick = async () => {
    if (!confirm('Remove ' + s.name + '?')) return;
    await fetch('/sources/' + sid, { method: 'DELETE' });
    if (selected === sid) selected = null;
    refresh();
  };
}

async function post(url, body) { await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).catch(() => {}); refresh(); }
async function patch(id, body) { await fetch('/sources/' + id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {}); refresh(); }

async function refresh() {
  try {
    const d = await (await fetch('/sources')).json();
    sources = d.sources || [];
    if (!selected && sources.length) selected = sources[0].id;
    render();
  } catch {}
}

// One dot per REAL send (SSE tick). Cap concurrent dots per source so a fast
// stream doesn't flood the SVG; extra ticks still update counters.
const liveDots = {};
function spawnDot(sourceId, malformed) {
  const s = sources.find((x) => x.id === sourceId);
  if (!s || !s.running || !positions[sourceId]) return; // no dots for a stopped source
  liveDots[sourceId] = (liveDots[sourceId] || 0);
  if (liveDots[sourceId] >= 6) return;
  liveDots[sourceId]++;
  const g = flow.querySelector('#dots');
  if (!g) return;
  const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  c.setAttribute('data-src', sourceId);
  c.setAttribute('r', malformed ? '4.5' : '3.5');
  // Orange = we corrupted it on purpose. Red is reserved for the engine's
  // rejection, so the two never read as the same thing on one screen.
  c.setAttribute('fill', malformed ? '#E55A1F' : (COLORS[s.type] || '#888'));
  const am = document.createElementNS('http://www.w3.org/2000/svg', 'animateMotion');
  const dur = 900 + Math.random() * 300;
  am.setAttribute('dur', dur + 'ms');
  am.setAttribute('repeatCount', '1');
  am.setAttribute('fill', 'freeze');
  am.setAttribute('path', pathFor(sourceId));
  c.appendChild(am);
  g.appendChild(c);
  am.beginElement && am.beginElement();
  setTimeout(() => { c.remove(); liveDots[sourceId]--; }, dur + 60);
}

// SSE: counters + dots from real events; sources list refresh on registry changes.
function connectEvents() {
  const es = new EventSource('/events');
  es.onmessage = (e) => {
    let ev; try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.type === 'tick' && ev.sourceId && ev.sourceId !== 'classic') {
      const s = sources.find((x) => x.id === ev.sourceId);
      if (s && ev.counters) s.counters = ev.counters;
      spawnDot(ev.sourceId, !!ev.malformed);
      renderHub();
      if (selected === ev.sourceId && s) updateInsCounters(s); // in place — never rebuild on a tick
      const el = [...stage.querySelectorAll('.node')][sources.indexOf(s)];
      if (el && s) { const n = el.querySelector('.sent-n'); if (n) n.textContent = s.counters.sent; }
    } else if (ev.type === 'state' && ev.sourceId && ev.state) {
      // The event already carries the snapshot — apply it in place. Re-fetching
      // /sources here would put one HTTP round-trip and a full stage rebuild on
      // every publish, against the same process running the send loops.
      const s = sources.find((x) => x.id === ev.sourceId);
      if (!s) { refresh(); return; }
      s.counters = ev.state.counters;
      s.running = ev.state.running;
      s.rate = ev.state.rate;
      s.faultRate = ev.state.faultRate;
      renderHub();
      if (selected === ev.sourceId) renderInspector();
      const el = [...stage.querySelectorAll('.node')][sources.indexOf(s)];
      if (el) { const n = el.querySelector('.sent-n'); if (n) n.textContent = s.counters.sent; }
    } else if (ev.type === 'state' || ev.type === 'sources') {
      refresh();
    }
  };
  es.onerror = () => { /* EventSource auto-reconnects */ };
}

// Global target select
document.getElementById('tgt').onchange = async (e) => {
  await post('/targets', { id: e.target.value });
  updateHubTarget();
};
async function updateHubTarget() {
  try {
    const d = await (await fetch('/targets')).json();
    const t = (d.targets || []).find((x) => x.id === d.activeId);
    if (t) document.getElementById('hubTarget').textContent = t.host + ':' + t.port;
  } catch {}
}

// Start all / Stop all
document.getElementById('allBtn').onclick = async () => {
  const action = sources.some((s) => s.running) ? 'stop' : 'start';
  await fetch('/sources/stream-all', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) }).catch(() => {});
  refresh();
};

// Add-source modal
const back = document.getElementById('modalBack');
document.getElementById('addBtn').onclick = () => { back.classList.add('open'); document.getElementById('mErr').textContent = ''; };
document.getElementById('mCancel').onclick = () => back.classList.remove('open');

// Type pills (replaces a plain select)
let mTypeVal = 'lab';
document.querySelectorAll('.type-pill').forEach((b) => {
  b.onclick = () => {
    mTypeVal = b.dataset.type;
    document.querySelectorAll('.type-pill').forEach((x) => x.classList.toggle('active', x === b));
  };
});

// Pretty-name generator — type-aware, avoids names already taken.
const NAME_FIRST = ['Sunrise','Cedar Grove','Riverbend','Maple Ridge','Harborview','Summit','Willow Creek','Lakeside','Granite Peak','Bluebird','Foxglove','Silver Birch','Aurora','Redwood','Stonebridge','Meadowbrook'];
const NAME_LAST = { lab:['Lab','Laboratory','Diagnostics','Clinical Lab'], clinic:['Clinic','Family Care','Medical Group','Health Center'], hospital:['Hospital','Medical Center','General Hospital','Regional'], pharmacy:['Pharmacy','Apothecary','Drug Store','Pharmacy Services'] };
function genName() {
  const taken = new Set(sources.map((s) => s.name));
  for (let i = 0; i < 40; i++) {
    const n = NAME_FIRST[Math.floor(Math.random() * NAME_FIRST.length)] + ' ' +
              NAME_LAST[mTypeVal][Math.floor(Math.random() * NAME_LAST[mTypeVal].length)];
    if (!taken.has(n.toUpperCase())) return n;
  }
  return 'Source ' + Math.floor(Math.random() * 999);
}
document.getElementById('mDice').onclick = () => { document.getElementById('mName').value = genName(); };

// Modal message-type chips (pure toggles; collected on Create). Refilled when
// the served /msg-types list arrives.
function fillModalChips() {
  document.getElementById('mChips').innerHTML =
    ALL_MSG_TYPES.map((t) => '<button type="button" class="msg-chip" data-t="' + t + '">' + t + '</button>').join('');
  document.querySelectorAll('#mChips .msg-chip').forEach((chip) => { chip.onclick = () => chip.classList.toggle('on'); });
}
fillModalChips();
document.getElementById('mPort').onchange = async (e) => {
  const port = Number(e.target.value);
  const el = document.getElementById('mProbe');
  if (!port) { el.textContent = ''; return; }
  el.textContent = 'probing…';
  try {
    const d = await (await fetch('/probe?port=' + port)).json();
    el.innerHTML = d.listening ? '<span class="probe-ok">✓ port ' + port + ' is listening</span>' : '<span class="probe-bad">✗ nothing listens on ' + port + '</span>';
  } catch { el.textContent = ''; }
};
document.getElementById('mCreate').onclick = async () => {
  const body = {
    name: document.getElementById('mName').value,
    type: mTypeVal,
    rate: Number(document.getElementById('mRate').value) || 1,
    faultRate: (Number(document.getElementById('mFault').value) || 0) / 100,
  };
  const port = Number(document.getElementById('mPort').value);
  if (port) body.targetPort = port;
  const picked = [...document.querySelectorAll('#mChips .msg-chip.on')].map((c) => c.dataset.t);
  if (picked.length) body.msgTypes = picked;
  const res = await fetch('/sources', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const d = await res.json();
  if (!d.ok) { document.getElementById('mErr').textContent = d.error || 'failed'; return; }
  back.classList.remove('open');
  document.getElementById('mName').value = '';
  selected = d.source.id;
  refresh();
};

// File export modal — batch (write N now) or stream (trickle at a rate).
const xBack = document.getElementById('exportBack');
document.getElementById('exportBtn').onclick = () => {
  document.getElementById('xChips').innerHTML = ALL_MSG_TYPES.map((t) => '<button type="button" class="msg-chip" data-t="' + t + '">' + t + '</button>').join('');
  document.querySelectorAll('#xChips .msg-chip').forEach((c) => { c.onclick = () => c.classList.toggle('on'); });
  document.getElementById('xErr').textContent = '';
  xBack.classList.add('open');
  refreshXStatus();
};
document.getElementById('xCancel').onclick = () => xBack.classList.remove('open');
function xPickedTypes() { return [...document.querySelectorAll('#xChips .msg-chip.on')].map((c) => c.dataset.t); }
function xCommon() {
  return { dir: document.getElementById('xDir').value.trim(), types: xPickedTypes(), faultRate: (Number(document.getElementById('xFault').value) || 0) / 100 };
}
document.getElementById('xBatch').onclick = async () => {
  const err = document.getElementById('xErr'); err.textContent = '';
  const b = { ...xCommon(), count: Number(document.getElementById('xCount').value) || 10, clean: document.getElementById('xClean').checked };
  if (!b.dir) { err.textContent = 'folder is required'; return; }
  const btn = document.getElementById('xBatch'); btn.disabled = true; btn.textContent = 'writing…';
  try {
    const d = await (await fetch('/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json();
    if (!d.ok) err.textContent = d.error || 'failed';
    else document.getElementById('xStatus').innerHTML = '✓ wrote <b>' + d.written + '</b> files to ' + escapeHtml(d.dir) + ' — ' + Object.entries(d.types).map(([k, v]) => k + '×' + v).join(', ') + (d.injectedFaults ? (' · ' + d.injectedFaults + ' faults') : '');
  } catch (e) { err.textContent = String(e); }
  btn.disabled = false; btn.textContent = '⤓ Generate batch';
};
// Stream toggle — server keeps writing after the modal closes; poll for live count.
let xStreaming = false, xPoll = null;
function applyXStream(s) {
  xStreaming = !!(s && s.running);
  const btn = document.getElementById('xStream');
  btn.textContent = xStreaming ? '■ Stop stream' : '▶ Stream';
  btn.classList.toggle('stop', xStreaming);
  if (xStreaming) document.getElementById('xStatus').innerHTML = '● streaming to ' + escapeHtml(s.dir) + ' — <b>' + s.written + '</b> files @ ' + s.rate + '/s';
  if (xStreaming && !xPoll) xPoll = setInterval(refreshXStatus, 1000);
  if (!xStreaming && xPoll) { clearInterval(xPoll); xPoll = null; }
}
async function refreshXStatus() { try { const d = await (await fetch('/export')).json(); applyXStream(d.stream); } catch {} }
document.getElementById('xStream').onclick = async () => {
  const err = document.getElementById('xErr'); err.textContent = '';
  const action = xStreaming ? 'stop' : 'start';
  const b = { action, ...xCommon(), rate: Number(document.getElementById('xRate').value) || 2 };
  if (action === 'start' && !b.dir) { err.textContent = 'folder is required'; return; }
  try {
    const d = await (await fetch('/export/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json();
    if (!d.ok) err.textContent = d.error || 'failed';
    else applyXStream(d.stream);
  } catch (e) { err.textContent = String(e); }
};
// Deep-link: /#files opens the export modal straight away.
if (location.hash === '#files') document.getElementById('exportBtn').click();

window.addEventListener('resize', render);
refresh();
updateHubTarget();
connectEvents();
setInterval(refresh, 4000); // safety net if an SSE event is missed
</script>
</body>
</html>`;
}
