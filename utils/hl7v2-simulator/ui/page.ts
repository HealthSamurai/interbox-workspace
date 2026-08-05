/**
 * Source UI — page renderer (v0.1)
 *
 * Returns an HTML string for the H-skin pocket widget with mode-aware controls.
 * Single-page, Alpine.js for interactivity, inline CSS for portability.
 *
 * The UI shows the same three modes (Single / Burst / Stream); the control
 * area between mode-pills and the faults slider reshapes based on the selected
 * mode. Send / Start are local stubs in v0.1 — they bump counters so the
 * visual rhythm of the demo is observable without wiring the generator yet.
 */

export interface Target {
  id: string;
  label: string;
  host: string;
  port: number;
}

export interface PageProps {
  engineTarget: string;
  profile: string;
  targets: Target[];
  activeTargetId: string;
}

export function renderPage({ engineTarget, profile, targets, activeTargetId }: PageProps): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Source · interbox upstream simulator</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
<style>
  :root {
    --bg: #F5F5F2;
    --paper: #FFFFFF;
    --paper-2: #F9F9F6;
    --paper-3: #EFEEEA;
    --line: #E8E5DE;
    --line-2: #D2CFC6;
    --ink: #18181A;
    --ink-2: #5C5B58;
    --ink-3: #98968F;
    --teal: #10B981;
    --teal-soft: #D1FAE5;
    --rose: #E1647B;
    --rose-soft: #FBE3E8;
    --amber: #C28B25;
    --amber-soft: #FBF0D6;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  [x-cloak] { display: none !important; }
  body {
    background: var(--bg);
    color: var(--ink);
    font-family: 'Geist', -apple-system, BlinkMacSystemFont, sans-serif;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 40px 20px;
    background-image: radial-gradient(circle at 50% 30%, rgba(15, 139, 125, 0.04), transparent 60%);
  }
  .mono { font-family: 'Geist Mono', monospace; }
  .tnum { font-variant-numeric: tabular-nums; }

  /* WIDGET */
  .widget {
    width: 400px;
    background: var(--paper);
    border-radius: 24px;
    padding: 24px;
    border: 1px solid var(--line);
    box-shadow:
      0 1px 0 rgba(255,255,255,0.7) inset,
      0 1px 2px rgba(0,0,0,0.04),
      0 20px 48px rgba(0,0,0,0.08),
      0 4px 14px rgba(0,0,0,0.04);
  }

  /* HEAD */
  .head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 22px; }
  .head-l { display: flex; align-items: center; gap: 10px; }
  .mark {
    width: 28px; height: 28px;
    display: flex; align-items: center; justify-content: center;
    color: var(--teal);
    flex-shrink: 0;
  }
  .mark svg { width: 100%; height: 100%; display: block; }
  .head-title { font-weight: 700; font-size: 14.5px; letter-spacing: -0.01em; }
  .head-title small { color: var(--ink-3); display: block; font-size: 11px; font-weight: 500; letter-spacing: 0.02em; }
  .live {
    display: flex; align-items: center; gap: 6px;
    background: var(--teal-soft); color: var(--teal);
    padding: 5px 10px;
    border-radius: 99px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .live.idle { background: var(--paper-3); color: var(--ink-3); }
  .live-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .live.streaming .live-dot { animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.3; } }

  /* TARGET STRIP */
  .target-strip {
    position: relative;
    margin-bottom: 20px;
  }
  .target-pill {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 12px;
    background: var(--paper-2);
    border: 1px solid var(--line);
    border-radius: 12px;
    cursor: pointer;
    transition: border-color .12s, background .12s;
  }
  .target-pill:hover { border-color: var(--line-2); background: var(--paper-3); }
  .target-pill.open { border-color: var(--ink); }
  .target-icon {
    width: 26px; height: 26px;
    background: var(--rose); color: var(--paper);
    border-radius: 7px;
    display: flex; align-items: center; justify-content: center;
    font-family: 'Geist Mono', monospace;
    font-weight: 600; font-size: 12px;
    flex-shrink: 0;
  }
  .target-icon.mock {
    background: var(--ink-3);
  }
  .target-info { flex: 1; }
  .target-name {
    font-size: 13px; font-weight: 600;
    display: flex; align-items: center; gap: 6px;
  }
  .target-name .send-indicator {
    font-family: 'Geist Mono', monospace;
    font-size: 10px;
    color: var(--ink-3);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 500;
  }
  .target-name .send-indicator::before {
    content: '→';
    margin-right: 3px;
    color: var(--ink-3);
  }
  .target-meta { font-family: 'Geist Mono', monospace; font-size: 11px; color: var(--ink-3); }
  .target-chev { color: var(--ink-3); font-size: 12px; transition: transform .15s; }
  .target-pill.open .target-chev { transform: rotate(180deg); }

  .target-menu {
    position: absolute;
    left: 0; right: 0;
    top: calc(100% + 4px);
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 12px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.1), 0 2px 6px rgba(0,0,0,0.04);
    overflow: hidden;
    z-index: 10;
  }
  .target-option {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 12px;
    cursor: pointer;
    border-bottom: 1px solid var(--line);
    transition: background .1s;
  }
  .target-option:last-child { border-bottom: none; }
  .target-option:hover { background: var(--paper-2); }
  .target-option.active { background: var(--teal-soft); }
  .target-option-tick {
    width: 14px; color: var(--teal);
    text-align: center; font-weight: 700;
  }
  .target-option-info { flex: 1; }
  .target-option-label {
    font-size: 13px; font-weight: 600;
    display: flex; align-items: center; gap: 6px;
  }
  .target-option-label .mock-badge {
    background: var(--amber-soft);
    color: var(--amber);
    font-family: 'Geist Mono', monospace;
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 1px 5px;
    border-radius: 3px;
  }
  .target-option-addr { font-family: 'Geist Mono', monospace; font-size: 11px; color: var(--ink-3); }
  .target-section-header {
    padding: 6px 12px 4px;
    font-family: 'Geist Mono', monospace;
    font-size: 9px;
    color: var(--ink-3);
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-weight: 600;
    background: var(--paper-2);
    border-bottom: 1px solid var(--line);
  }

  /* READOUT — EKG hero */
  .readout {
    padding: 14px 0 14px;
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
    margin-bottom: 18px;
    position: relative;
  }
  .ekg-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 2px 8px;
  }
  .ekg-head-l {
    font-family: 'Geist Mono', monospace;
    font-size: 10px;
    color: var(--ink-3);
    text-transform: uppercase;
    letter-spacing: 0.18em;
    font-weight: 600;
  }
  .ekg-rate {
    font-family: 'Geist Mono', monospace;
    font-size: 14px;
    font-weight: 600;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }
  .ekg-rate small { color: var(--ink-3); margin-left: 2px; font-weight: 500; }
  .ekg-frame {
    position: relative;
    background:
      repeating-linear-gradient(0deg, rgba(16,185,129,0.05) 0 1px, transparent 1px 14px),
      repeating-linear-gradient(90deg, rgba(16,185,129,0.05) 0 1px, transparent 1px 14px),
      linear-gradient(180deg, #FBFFFD 0%, #F1FBF5 100%);
    border: 1px solid var(--line);
    border-radius: 10px;
    height: 96px;
    overflow: hidden;
  }
  .ekg-svg {
    width: 100%;
    height: 100%;
    display: block;
  }
  .ekg-baseline {
    position: absolute;
    inset: 0;
    pointer-events: none;
    border-top: 1px dashed rgba(16,185,129,0.18);
    margin-top: 53px;
  }
  .ekg-footer {
    margin-top: 10px;
    display: flex;
    justify-content: center;
    gap: 18px;
    font-family: 'Geist Mono', monospace;
    font-size: 11px;
    color: var(--ink-2);
  }
  .ekg-footer .err { color: var(--rose); }
  .ekg-footer .warn { color: var(--amber); }
  .ekg-footer .ok { color: var(--teal); }
  .ekg-footer strong { color: var(--ink); font-weight: 600; }

  /* MODE TABS */
  .modes {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    background: var(--paper-2);
    border-radius: 11px;
    padding: 4px;
    margin-bottom: 18px;
    border: 1px solid var(--line);
  }
  .mode {
    padding: 8px 0;
    text-align: center;
    font-size: 13px;
    font-weight: 600;
    color: var(--ink-2);
    border-radius: 8px;
    cursor: pointer;
    transition: all .12s;
  }
  .mode:hover { color: var(--ink); }
  .mode.active {
    background: var(--teal);
    color: var(--paper);
    box-shadow: 0 1px 2px rgba(16,185,129,0.3), 0 1px 0 rgba(255,255,255,0.2) inset;
  }

  /* MODE-AWARE CONTROL AREA */
  .mode-area {
    background: var(--paper-2);
    border: 1px dashed var(--line-2);
    border-radius: 12px;
    padding: 14px;
    margin-bottom: 18px;
    min-height: 96px;
  }
  .ma-label { font-family: 'Geist Mono', monospace; font-size: 10px; color: var(--ink-3); text-transform: uppercase; letter-spacing: 0.14em; font-weight: 600; margin-bottom: 10px; }

  /* type select */
  .type-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-bottom: 12px; }
  .type-btn {
    background: var(--paper);
    border: 1.5px solid var(--line);
    padding: 8px 6px;
    border-radius: 8px;
    font-family: 'Geist Mono', monospace;
    font-size: 11.5px;
    font-weight: 600;
    color: var(--ink-2);
    cursor: pointer;
    text-align: center;
    transition: all .12s;
  }
  .type-btn:hover { color: var(--ink); border-color: var(--line-2); }
  .type-btn.active { background: var(--ink); color: var(--paper); border-color: var(--ink); }

  /* count input */
  .count-row { display: grid; grid-template-columns: 1fr auto auto auto; gap: 8px; align-items: center; margin-bottom: 12px; }
  .count-input {
    background: var(--paper);
    border: 1.5px solid var(--line);
    padding: 10px 12px;
    border-radius: 9px;
    font-family: 'Geist Mono', monospace;
    font-size: 18px;
    font-weight: 600;
    color: var(--ink);
    width: 100%;
    font-variant-numeric: tabular-nums;
  }
  .count-input:focus { outline: none; border-color: var(--ink); }
  .count-chip {
    background: var(--paper);
    border: 1.5px solid var(--line);
    padding: 8px 12px;
    border-radius: 9px;
    font-family: 'Geist Mono', monospace;
    font-size: 12px;
    font-weight: 600;
    color: var(--ink-2);
    cursor: pointer;
  }
  .count-chip:hover { color: var(--ink); border-color: var(--line-2); }

  /* rate slider in mode area */
  .rate-row { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }
  .rate-v { font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
  .rate-v small { font-size: 12px; color: var(--ink-3); font-weight: 500; margin-left: 4px; font-family: 'Geist Mono', monospace; }
  .slider-bar { height: 6px; background: var(--line); border-radius: 3px; position: relative; cursor: pointer; }
  .slider-fill { position: absolute; height: 100%; background: var(--ink); border-radius: 3px; pointer-events: none; }
  .slider-fill.warn { background: var(--amber); }
  .slider-knob {
    position: absolute;
    top: 50%; transform: translate(-50%, -50%);
    width: 18px; height: 18px;
    border-radius: 50%;
    background: var(--paper);
    border: 2.5px solid var(--ink);
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    pointer-events: none;
  }
  .slider-knob.warn { border-color: var(--amber); }
  /* slider marks — absolutely positioned so each tick lines up with its actual value on the bar */
  .slider-marks {
    position: relative;
    height: 14px;
    margin-top: 6px;
    font-family: 'Geist Mono', monospace;
    font-size: 10px;
    color: var(--ink-3);
  }
  .slider-marks span {
    position: absolute;
    top: 0;
    transform: translateX(-50%);
    white-space: nowrap;
  }
  .slider-marks span:first-child { transform: translateX(0); }     /* anchor left at 0% */
  .slider-marks span:last-child { transform: translateX(-100%); }  /* anchor right at 100% */

  /* ACTION (Send / Start-Stop) */
  .ma-action {
    margin-top: 12px;
    display: flex;
    gap: 8px;
  }
  .action-btn {
    flex: 1;
    padding: 12px;
    background: var(--ink);
    color: var(--paper);
    border: none;
    border-radius: 10px;
    font-family: inherit;
    font-size: 13.5px;
    font-weight: 600;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center; gap: 8px;
    transition: background .12s, transform .08s;
  }
  .action-btn:hover { background: #2A2A2C; }
  .action-btn:active { transform: translateY(1px); }
  .action-btn.streaming { background: var(--rose); }
  .action-btn.streaming:hover { background: #C04C5F; }
  .action-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .action-btn.streaming .action-dot { animation: pulse 1.2s ease-in-out infinite; }

  /* CLI HINT */
  .cli-hint {
    margin-top: 10px;
    background: var(--paper-3);
    border: 1px dashed var(--line-2);
    border-radius: 8px;
    padding: 8px 10px;
    font-family: 'Geist Mono', monospace;
    font-size: 11px;
    color: var(--ink-2);
    display: flex;
    align-items: center;
    gap: 8px;
    overflow: hidden;
  }
  .cli-hint-cmd {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--ink);
  }
  .cli-hint-cmd .dim { color: var(--ink-3); }
  .cli-copy {
    background: var(--paper);
    border: 1px solid var(--line);
    color: var(--ink-2);
    padding: 4px 8px;
    border-radius: 5px;
    font-family: inherit;
    font-size: 10.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    cursor: pointer;
    transition: all .12s;
    flex-shrink: 0;
  }
  .cli-copy:hover { background: var(--paper-3); color: var(--ink); }
  .cli-copy.copied { background: var(--teal-soft); color: var(--teal); border-color: var(--teal); }

  /* ERROR BANNER */
  .err-banner {
    background: var(--rose-soft);
    color: var(--rose);
    border: 1px solid var(--rose);
    border-radius: 9px;
    padding: 8px 12px;
    font-family: 'Geist Mono', monospace;
    font-size: 11px;
    margin-bottom: 14px;
    word-break: break-word;
  }
  .err-banner strong { font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; margin-right: 6px; }

  /* FAULTS (always visible) */
  .faults { margin-bottom: 18px; }
  .faults-row { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
  .faults-k { font-family: 'Geist Mono', monospace; font-size: 11px; color: var(--ink-2); text-transform: uppercase; letter-spacing: 0.12em; font-weight: 600; }
  .faults-v { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
  .faults-v small { font-size: 10px; color: var(--ink-3); margin-left: 3px; font-weight: 500; font-family: 'Geist Mono', monospace; }

  /* TYPE MIX (footer) */
  .types {
    display: flex;
    justify-content: space-between;
    padding: 10px 14px;
    background: var(--paper-2);
    border: 1px solid var(--line);
    border-radius: 11px;
    margin-bottom: 14px;
  }
  .tt { display: flex; align-items: center; gap: 7px; font-family: 'Geist Mono', monospace; font-size: 12px; font-weight: 500; }
  .tt-dot { width: 7px; height: 7px; border-radius: 50%; }
  .tt-pct { color: var(--ink-2); font-variant-numeric: tabular-nums; font-size: 11px; }

  /* MICRO FOOT */
  .micro {
    display: flex;
    justify-content: space-between;
    font-family: 'Geist Mono', monospace;
    font-size: 10.5px;
    color: var(--ink-3);
  }
</style>
</head>
<body>

<div class="widget"
  x-data="sourceUi()"
  x-cloak
>
  <div class="head">
    <div class="head-l">
      <div class="mark">
        <svg viewBox="0 0 28 28" fill="none">
          <path d="M2 14 L8 14 L10 8 L12 20 L14 6 L16 22 L18 14 L26 14"
                stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" fill="none"/>
        </svg>
      </div>
      <div class="head-title">Source<small>upstream simulator</small></div>
    </div>
    <div class="live" :class="status === 'streaming' ? 'streaming' : (status === 'idle' ? 'idle' : '')">
      <span class="live-dot"></span>
      <span x-text="statusLabel()"></span>
    </div>
  </div>

  <div class="target-strip" @click.outside="targetMenuOpen = false">
    <div class="target-pill" :class="targetMenuOpen && 'open'" @click="targetMenuOpen = !targetMenuOpen">
      <div class="target-icon" :class="activeTarget.mock && 'mock'" x-text="activeTarget.label[0] || '?'"></div>
      <div class="target-info">
        <div class="target-name">
          <span x-text="activeTarget.label"></span>
          <span class="send-indicator" x-text="activeTarget.mock ? 'mock' : 'target'"></span>
        </div>
        <div class="target-meta" x-text="activeTarget.mock ? ('mock://' + activeTarget.id) : (activeTarget.host + ':' + activeTarget.port)"></div>
      </div>
      <div class="target-chev">▾</div>
    </div>
    <div class="target-menu" x-show="targetMenuOpen" x-cloak>
      <div class="target-section-header">Real · MLLP listeners</div>
      <template x-for="t in targets.filter(x => !x.mock)" :key="t.id">
        <div class="target-option" :class="t.id === activeTargetId && 'active'" @click="switchTarget(t.id)">
          <span class="target-option-tick" x-text="t.id === activeTargetId ? '✓' : ''"></span>
          <div class="target-option-info">
            <div class="target-option-label" x-text="t.label"></div>
            <div class="target-option-addr" x-text="t.host + ':' + t.port"></div>
          </div>
        </div>
      </template>
      <div class="target-section-header">Demo · mocked ACK in-process</div>
      <template x-for="t in targets.filter(x => x.mock)" :key="t.id">
        <div class="target-option" :class="t.id === activeTargetId && 'active'" @click="switchTarget(t.id)">
          <span class="target-option-tick" x-text="t.id === activeTargetId ? '✓' : ''"></span>
          <div class="target-option-info">
            <div class="target-option-label">
              <span x-text="t.label"></span>
              <span class="mock-badge">mock</span>
            </div>
            <div class="target-option-addr" x-text="'mock://' + t.id"></div>
          </div>
        </div>
      </template>
    </div>
  </div>

  <div class="readout">
    <div class="ekg-head">
      <span class="ekg-head-l">Live channel · HL7</span>
      <span class="ekg-rate tnum"><span x-text="throughputDisplay()"></span><small>msg/s</small></span>
    </div>
    <div class="ekg-frame">
      <div class="ekg-baseline"></div>
      <svg class="ekg-svg" viewBox="0 0 360 96" preserveAspectRatio="none">
        <defs>
          <linearGradient id="ekg-fade" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="#10B981" stop-opacity="0"/>
            <stop offset="0.15" stop-color="#10B981" stop-opacity="0.6"/>
            <stop offset="0.95" stop-color="#10B981" stop-opacity="1"/>
          </linearGradient>
          <linearGradient id="ekg-fade-err" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="#E1647B" stop-opacity="0"/>
            <stop offset="0.6" stop-color="#E1647B" stop-opacity="0.5"/>
            <stop offset="0.95" stop-color="#E1647B" stop-opacity="0.9"/>
          </linearGradient>
          <filter id="ekg-glow" x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur :stdDeviation="ekgGlow()" result="b"/>
            <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs>
        <!-- main trace -->
        <polyline :points="beat.line" fill="none" :stroke="beat.errFlash > 0 ? 'url(#ekg-fade-err)' : 'url(#ekg-fade)'" :stroke-width="ekgStroke()" stroke-linejoin="round" stroke-linecap="round" filter="url(#ekg-glow)"/>
        <!-- leading dot -->
        <circle :cx="beat.headX" :cy="beat.headY" r="3" :fill="beat.errFlash > 0 ? '#E1647B' : '#10B981'" filter="url(#ekg-glow)"/>
      </svg>
    </div>
    <div class="ekg-footer">
      <span title="written to the socket">sent <strong x-text="counters.sent.toLocaleString('en-US')"></strong></span>
      <span class="ok-c" title="engine ACK = AA: accepted">accepted <strong x-text="counters.accepted.toLocaleString('en-US')"></strong></span>
      <span class="err" title="engine ACK = AE or AR: refused">rejected <strong x-text="counters.rejected.toLocaleString('en-US')"></strong></span>
      <span title="sent with no ACK back and not clearing — messages in flight are not counted">no answer <strong x-text="unaSettled.toLocaleString('en-US')"></strong></span>
      <span class="warn" title="we deliberately corrupted these — a property of the content, already inside sent">malformed <strong x-text="counters.malformed.toLocaleString('en-US')"></strong></span>
    </div>
  </div>

  <div class="modes">
    <div class="mode" :class="mode === 'single' && 'active'" @click="mode = 'single'">Single</div>
    <div class="mode" :class="mode === 'burst' && 'active'" @click="mode = 'burst'">Burst</div>
    <div class="mode" :class="mode === 'stream' && 'active'" @click="mode = 'stream'">Stream</div>
  </div>

  <!-- MODE-AWARE CONTROL AREA -->
  <div class="mode-area">

    <!-- SINGLE -->
    <div x-show="mode === 'single'">
      <div class="ma-label">Pick a message type</div>
      <div class="type-grid">
        <template x-for="t in singleTypes" :key="t">
          <div class="type-btn" :class="type === t && 'active'" @click="type = t" x-text="t"></div>
        </template>
      </div>
      <div class="ma-action">
        <button class="action-btn" @click="fakeSendSingle()">
          <span>Send 1 message</span>
        </button>
      </div>
    </div>

    <!-- BURST -->
    <div x-show="mode === 'burst'">
      <div class="ma-label">How many at once</div>
      <div class="count-row">
        <input type="number" class="count-input tnum" x-model.number="count" min="1" max="10000">
        <button class="count-chip" @click="count = 10">10</button>
        <button class="count-chip" @click="count = 100">100</button>
        <button class="count-chip" @click="count = 500">500</button>
      </div>
      <div class="ma-action">
        <button class="action-btn" @click="fakeSendBurst()">
          <span>Send burst (<span x-text="count"></span>)</span>
        </button>
      </div>
    </div>

    <!-- STREAM -->
    <div x-show="mode === 'stream'">
      <div class="rate-row">
        <span class="ma-label" style="margin: 0;">Rate</span>
        <span class="rate-v tnum"><span x-text="rate.toFixed(1)"></span><small>msg/s</small></span>
      </div>
      <div class="slider-bar" @mousedown="startRateDrag($event)">
        <div class="slider-fill" :style="\`width: \${rateSliderPct()}%\`"></div>
        <div class="slider-knob" :style="\`left: \${rateSliderPct()}%\`"></div>
      </div>
      <div class="slider-marks">
        <span style="left: 0%">0.1</span>
        <span style="left: 33.3%">1</span>
        <span style="left: 66.7%">10</span>
        <span style="left: 100%">100</span>
      </div>
      <div class="ma-action">
        <button class="action-btn" :class="status === 'streaming' && 'streaming'" @click="toggleStream()">
          <span class="action-dot"></span>
          <span x-text="status === 'streaming' ? 'Stop stream' : 'Start stream'"></span>
        </button>
      </div>
    </div>

  </div>

  <!-- ERROR BANNER (only on failure) -->
  <div class="err-banner" x-show="lastError" x-cloak>
    <strong>error</strong><span x-text="lastError"></span>
  </div>

  <!-- FAULTS (always visible) -->
  <div class="faults">
    <div class="faults-row">
      <span class="faults-k">Faults</span>
      <span class="faults-v tnum"><span x-text="faultRate"></span><small>%</small></span>
    </div>
    <div class="slider-bar" @mousedown="startFaultsDrag($event)">
      <div class="slider-fill warn" :style="\`width: \${(faultRate / 50) * 100}%\`"></div>
      <div class="slider-knob warn" :style="\`left: \${(faultRate / 50) * 100}%\`"></div>
    </div>
    <div class="slider-marks">
      <span style="left: 0%">0%</span>
      <span style="left: 20%">10%</span>
      <span style="left: 50%">25%</span>
      <span style="left: 80%">40%</span>
      <span style="left: 100%">50%</span>
    </div>
  </div>

  <!-- TYPE MIX (read-only) -->
  <div class="types">
    <div class="tt"><span class="tt-dot" style="background: var(--teal);"></span>ADT <span class="tt-pct">58%</span></div>
    <div class="tt"><span class="tt-dot" style="background: var(--amber);"></span>ORU <span class="tt-pct">31%</span></div>
    <div class="tt"><span class="tt-dot" style="background: var(--rose);"></span>SIU <span class="tt-pct">11%</span></div>
  </div>

  <div class="micro">
    <span>v0.1 · <span x-text="profile"></span></span>
    <span x-text="'λ · ' + rate.toFixed(1) + ' msg/s · Poisson'"></span>
  </div>
</div>

<script>
  function sourceUi() {
    return {
      // env
      engineTarget: ${JSON.stringify(engineTarget)},
      profile: ${JSON.stringify(profile)},
      targets: ${JSON.stringify(targets)},
      activeTargetId: ${JSON.stringify(activeTargetId)},
      targetMenuOpen: false,

      get activeTarget() {
        return this.targets.find(t => t.id === this.activeTargetId) || this.targets[0];
      },

      async switchTarget(id) {
        this.targetMenuOpen = false;
        if (id === this.activeTargetId) return;
        try {
          const r = await fetch('/targets', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id }),
          });
          if (!r.ok) {
            const data = await r.json().catch(() => ({}));
            this.lastError = data.error || ('HTTP ' + r.status);
            return;
          }
          this.activeTargetId = id;
          this.lastError = null;
        } catch (e) {
          this.lastError = e.message || String(e);
        }
      },

      // mode state
      mode: 'stream',
      type: 'ADT^A01',
      count: 100,
      rate: 3.0,
      faultRate: 5,   // default 5%
      // only types with builders in src/gen/grammar/message-types.ts (BUILDERS registry)
      singleTypes: ['ADT^A01', 'ADT^A03', 'ADT^A08', 'ORU^R01', 'ORU^R03', 'SIU^S12'],

      // runtime state
      status: 'idle',     // 'idle' | 'streaming'
      // Two axes: delivery (sent = accepted + rejected + unanswered) and
      // content (malformed — deliberately corrupted, already inside sent).
      counters: { sent: 0, accepted: 0, rejected: 0, unanswered: 0, malformed: 0 },
      // "No answer" must mean "never came back", not "still in flight". The raw
      // figure flickers 0/1 as each message waits the few milliseconds for its
      // ACK. What is displayed is the FLOOR over a short window: in-flight
      // traffic floors at zero, a silent engine floors at the stuck count.
      unaSettled: 0,
      unaHist: [],
      settleUna() {
        const now = Date.now();
        this.unaHist = this.unaHist.filter((e) => now - e.t <= 4000);
        this.unaHist.push({ t: now, v: this.counters.unanswered });
        this.unaSettled = this.unaHist.reduce((m, e) => Math.min(m, e.v), this.counters.unanswered);
      },

      // EKG beat — running waveform; flat baseline + per-frame aggregated peaks
      beat: {
        buffer: new Array(120).fill(0),
        pending: [],         // queue of next sample values (QRS injection)
        pendingCount: 0,     // messages accumulated since last frame — drives peak height
        pendingErrCount: 0,  // errored subset of pendingCount
        line: '',
        headX: 0,
        headY: 54,
        errFlash: 0,         // ticks remaining where last QRS was errored
      },

      // Rolling timestamp ring for measured throughput (5-second window)
      throughputBuffer: [],
      // Reactive tick so Alpine re-renders the rate display even after the
      // buffer drains (otherwise display would freeze at last computed value)
      throughputTick: 0,

      _beatTimer: null,

      init() {
        this._renderBeat();
        // 60ms tick = ~17fps — smooth enough, easy on CPU
        this._beatTimer = setInterval(() => this._tickBeat(), 60);
        // Slower kick so throughput display ticks down to 0 after stream stops
        setInterval(() => { this.throughputTick++; }, 500);
        this._initDrag();
        this._openEvents();
      },

      _events: null,
      _disconnectTimer: null,
      _openEvents() {
        const es = new EventSource('/events');
        this._events = es;
        es.onmessage = (e) => {
          // any message means the connection is healthy — clear any pending notice
          if (this._disconnectTimer) {
            clearTimeout(this._disconnectTimer);
            this._disconnectTimer = null;
          }
          if (this.lastError && this.lastError.startsWith('event stream')) {
            this.lastError = null;
          }
          try {
            const ev = JSON.parse(e.data);
            if (ev.type === 'state') {
              // server is authoritative for counters + running flag
              this.counters = { ...this.counters, ...ev.state.counters }; this.settleUna();
              this.status = ev.state.running ? 'streaming' : 'idle';
              // Sync rate/faults from server ONLY when stream is running —
              // otherwise locally-set defaults (faults=5%) survive page refresh
              if (ev.state.running) {
                if (typeof ev.state.rate === 'number') this.rate = ev.state.rate;
                if (typeof ev.state.faultRate === 'number') this.faultRate = Math.round(ev.state.faultRate * 100);
              }
            } else if (ev.type === 'tick') {
              this.counters = { ...this.counters, ...ev.counters }; this.settleUna();
              this._recordBeat(1, ev.malformed ? 1 : 0);
              this._recordSends(1);
            } else if (ev.type === 'error') {
              this.lastError = ev.error;
            }
          } catch {}
        };
        es.onerror = () => {
          // EventSource fires onerror on any transition to CONNECTING, including
          // benign retries (server restart, brief network blip, browser tab
          // throttling). Debounce by 1.2s — if still not reconnected by then,
          // surface a notice. Terminal CLOSED state is shown as a real error.
          if (this._disconnectTimer) return;
          this._disconnectTimer = setTimeout(() => {
            this._disconnectTimer = null;
            if (es.readyState === EventSource.CLOSED) {
              this.lastError = 'event stream closed';
            } else if (es.readyState === EventSource.CONNECTING) {
              this.lastError = 'event stream reconnecting…';
            }
            // else: re-OPEN'd within the window, no notice needed
          }, 1200);
        };
      },

      _tickBeat() {
        // Flat baseline (0) between events. When messages have accumulated
        // since the last frame, queue a peak whose height = count / 100.
        let next = 0;
        if (this.beat.pending.length > 0) {
          next = this.beat.pending.shift();
        } else if (this.beat.pendingCount > 0) {
          // Log-scaled with a 50% floor — single send (1 msg) reads 50%,
          // burst 10 ≈ 75%, burst 100 = full height. Floor keeps even tiny
          // events visually present on the trace.
          const c = Math.max(1, this.beat.pendingCount);
          const h = Math.min(1, 0.50 + 0.50 * Math.log10(c) / Math.log10(100));
          const errored = this.beat.pendingErrCount > 0;
          this.beat.pending.push(...this._pulseShape(h, errored));
          this.beat.pendingCount = 0;
          this.beat.pendingErrCount = 0;
          next = this.beat.pending.shift();
        }
        this.beat.buffer.push(next);
        if (this.beat.buffer.length > 120) this.beat.buffer.shift();
        if (this.beat.errFlash > 0) this.beat.errFlash--;
        // trim throughput window so display decays even when no new sends
        const cutoff = Date.now() - 5000;
        while (this.throughputBuffer.length > 0 && this.throughputBuffer[0] < cutoff) {
          this.throughputBuffer.shift();
        }
        this._renderBeat();
      },

      _recordSends(n) {
        const now = Date.now();
        for (let i = 0; i < n; i++) this.throughputBuffer.push(now);
      },

      // Stroke width scales with effective rate (1.6 idle → 2.6 streaming high)
      ekgStroke() {
        const r = this.status === 'streaming' ? this.rate : 0;
        return (1.6 + Math.min(1.0, Math.log10(r + 1) / Math.log10(101))).toFixed(2);
      },

      // Glow blur scales with rate — higher rate, more bloom
      ekgGlow() {
        const r = this.status === 'streaming' ? this.rate : 0;
        return (1.0 + Math.min(1.2, Math.log10(r + 1) / Math.log10(101) * 1.2)).toFixed(2);
      },

      _renderBeat() {
        const w = 360, h = 96, mid = 54, amp = 36;
        const step = w / (this.beat.buffer.length - 1);
        let pts = '';
        let lastX = 0, lastY = mid;
        for (let i = 0; i < this.beat.buffer.length; i++) {
          const x = i * step;
          const y = mid - this.beat.buffer[i] * amp;
          pts += (i === 0 ? '' : ' ') + x.toFixed(1) + ',' + y.toFixed(1);
          lastX = x; lastY = y;
        }
        this.beat.line = pts;
        this.beat.headX = lastX;
        this.beat.headY = lastY;
      },

      // QRS shape — same for all message types. P / Q / R / S / T-ish in 7
      // samples, R-peak height scales with input. Error variant is broader
      // and asymmetric (arrhythmic look).
      _pulseShape(height, errored) {
        const r = height;
        if (errored) {
          return [0.05*r, -0.2*r, 0.85*r, 0.3*r, -0.5*r, -0.15*r, 0.05*r];
        }
        return [0.08*r, -0.06*r, r, -0.35*r, 0.12*r, 0.02*r, 0];
      },

      // Record N messages (errored fraction) into the per-frame aggregator.
      // _tickBeat will pick them up next frame and emit a peak whose height
      // is proportional to count (cap at 100).
      _recordBeat(count, erroredCount = 0) {
        this.beat.pendingCount += count;
        this.beat.pendingErrCount += erroredCount;
        if (erroredCount > 0) this.beat.errFlash = Math.max(this.beat.errFlash, 18);
      },

      statusLabel() {
        if (this.status === 'streaming') return 'Live';
        if (this.counters.sent > 0) return 'Idle';
        return 'Ready';
      },

      // measured throughput from last 5 seconds, regardless of mode
      throughputDisplay() {
        // touch tick + counters for reactivity (force re-eval on each tick/refresh)
        const _t = this.throughputTick + this.counters.sent;
        // trim defensively in case _tickBeat skipped a frame
        const cutoff = Date.now() - 5000;
        while (this.throughputBuffer.length > 0 && this.throughputBuffer[0] < cutoff) {
          this.throughputBuffer.shift();
        }
        return (this.throughputBuffer.length / 5).toFixed(2);
      },


      // Slider drag plumbing — mousedown starts a drag, document mousemove
      // tracks it, mouseup ends it. Same handler is used for click-to-position.
      _dragState: null,  // { el, setter } or null

      _initDrag() {
        // bind once so addEventListener / removeEventListener match
        this._onDragMove = (e) => {
          if (!this._dragState) return;
          const r = this._dragState.el.getBoundingClientRect();
          const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
          this._dragState.setter(pct);
        };
        this._onDragEnd = () => {
          if (!this._dragState) return;
          document.removeEventListener('mousemove', this._onDragMove);
          document.removeEventListener('mouseup', this._onDragEnd);
          this._dragState = null;
          document.body.style.userSelect = '';
        };
      },

      startRateDrag(e) {
        this._dragState = { el: e.currentTarget, setter: (pct) => this._setRateFromPct(pct) };
        this._onDragMove(e);
        document.addEventListener('mousemove', this._onDragMove);
        document.addEventListener('mouseup', this._onDragEnd);
        document.body.style.userSelect = 'none';
        e.preventDefault();
      },

      startFaultsDrag(e) {
        this._dragState = { el: e.currentTarget, setter: (pct) => this._setFaultsFromPct(pct) };
        this._onDragMove(e);
        document.addEventListener('mousemove', this._onDragMove);
        document.addEventListener('mouseup', this._onDragEnd);
        document.body.style.userSelect = 'none';
        e.preventDefault();
      },

      _setRateFromPct(pct) {
        // Log scale: 0.1 ↔ pct=0, 1 ↔ pct=1/3, 10 ↔ pct=2/3, 100 ↔ pct=1
        const v = Math.pow(10, pct * 3 - 1);
        const next = v < 1 ? Math.round(v * 10) / 10
                   : v < 10 ? Math.round(v * 10) / 10
                   : Math.round(v);
        if (next === this.rate) return;
        this.rate = next;
        this._patchStream({ rate: this.rate });
      },

      // Reverse of _setRateFromPct: rate → visual position 0..100%
      rateSliderPct() {
        const r = Math.max(0.1, Math.min(100, this.rate));
        return ((Math.log10(r) + 1) / 3) * 100;
      },

      _setFaultsFromPct(pct) {
        const next = Math.round(pct * 50);
        if (next === this.faultRate) return;
        this.faultRate = next;
        this._patchStream({ faultRate: this.faultRate / 100 });
      },

      // last engine response — surfaced in UI when something fails
      lastError: null,
      busy: false,
      cliCopied: false,

      // Renders the equivalent CLI invocation for the current mode + settings.
      // Mirrors what /send and /stream/* call internally — handy teaching aid
      // for technical viewers during the demo.
      cliCommand() {
        const fr = (this.faultRate / 100).toFixed(2);
        const target = ${JSON.stringify(engineTarget)};
        const [host, port] = target.split(':');
        const conn = ' <span class="dim">--host ' + host + ' --port ' + port + '</span>';
        if (this.mode === 'single') {
          return 'bun run send batch --count 1 --errorRate ' + fr + conn;
        }
        if (this.mode === 'burst') {
          return 'bun run send batch --count ' + this.count + ' --errorRate ' + fr + conn;
        }
        // stream
        return 'bun run send stream --rate ' + this.rate.toFixed(1) + ' --errorRate ' + fr + conn;
      },

      copyCli() {
        const tmp = document.createElement('div');
        tmp.innerHTML = this.cliCommand();
        const plain = tmp.textContent || '';
        navigator.clipboard.writeText(plain).then(() => {
          this.cliCopied = true;
          setTimeout(() => { this.cliCopied = false; }, 1200);
        }).catch(() => {
          this.lastError = 'clipboard write failed';
        });
      },

      // Single message — real MLLP via POST /send; sent only if engine ACK'd
      async fakeSendSingle() {
        if (this.busy) return;
        this.busy = true;
        try {
          const r = await fetch('/send', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              mode: 'single',
              type: this.type,
              faultRate: this.faultRate / 100,
            }),
          });
          const data = await r.json();
          const errored = !data.ok || data.failed > 0;
          if (errored) {
            this.lastError = data.error || ('HTTP ' + r.status);
          } else {
            this.lastError = null;
          }
          // 1 message in this moment → tiny peak (1/100 height)
          this._recordBeat(1, errored ? 1 : 0);
          if (data.sent) this._recordSends(data.sent);
        } catch (e) {
          this.lastError = e.message || String(e);
          this._injectPulse(0.95, true);
        } finally {
          this.busy = false;
        }
      },

      // Burst — real MLLP via POST /send. Response comes back with N sent;
      // one peak is queued with height = N/100 (capped at 1.0). So burst 100
      // = max-height peak, burst 50 = half, burst 500 = capped at max.
      async fakeSendBurst() {
        if (this.busy) return;
        this.busy = true;
        try {
          const r = await fetch('/send', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              mode: 'burst',
              count: this.count,
              faultRate: this.faultRate / 100,
            }),
          });
          const data = await r.json();
          if (!data.ok) {
            this.lastError = data.error || ('HTTP ' + r.status);
          } else {
            this.lastError = null;
          }
          if (data.sent) this._recordSends(data.sent);
          this._recordBeat(data.sent || 0, data.failed || 0);
        } catch (e) {
          this.lastError = e.message || String(e);
          this._recordBeat(1, 1);
        } finally {
          this.busy = false;
        }
      },

      async toggleStream() {
        if (this.status === 'streaming') {
          try {
            await fetch('/stream/stop', { method: 'POST' });
            this.lastError = null;
          } catch (e) {
            this.lastError = e.message || String(e);
          }
        } else {
          try {
            const r = await fetch('/stream/start', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ rate: this.rate, faultRate: this.faultRate / 100 }),
            });
            if (!r.ok) {
              const data = await r.json().catch(() => ({}));
              this.lastError = data.error || ('HTTP ' + r.status);
            } else {
              this.lastError = null;
            }
          } catch (e) {
            this.lastError = e.message || String(e);
          }
        }
        // status flips on next SSE 'state' event
      },

      // patch server with live rate/faults — fire-and-forget; OK if it races
      _patchStream(payload) {
        if (this.status !== 'streaming') return;
        fetch('/stream', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => { /* PATCH failures surface via SSE error event */ });
      },
    };
  }
</script>
</body>
</html>`;
}
