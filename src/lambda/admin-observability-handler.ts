import pino from "pino";

import { env } from "../config/env.js";
import {
  computeHealthStatus,
  createEventStoreClient,
  readJourneyByDeliveryId,
  readPerRepoStats,
  readRecentEvents,
  readRecentFailures,
  readSummaryProjection,
  readTopReposLastMinutes,
} from "../async/event-store.js";

const log = pino({ level: env.LOG_LEVEL });

type ApiGatewayV2Event = {
  rawPath: string;
  queryStringParameters?: Record<string, string | undefined>;
};

type ApiGatewayV2Response = {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
};

function jsonResponse(statusCode: number, data: unknown): ApiGatewayV2Response {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  };
}

function htmlPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Dispatcher Admin</title>
  <style>
    :root{--bg:#f0f4f0;--ink:#1c2025;--accent:#0f766e;--success:#15803d;--warn:#b45309;--danger:#b91c1c;--unknown:#6b7280;--panel:#ffffff;--muted:#6b7280;--line:#e2e8e0}
    *{box-sizing:border-box}
    body{margin:0;font-family:"IBM Plex Sans","Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--ink);padding:16px 20px}
    .wrap{max-width:1080px;margin:0 auto}
    h2{margin:16px 0 8px;font-size:1rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
    .banner{border-radius:12px;padding:14px 20px;display:flex;align-items:center;gap:14px;margin-bottom:16px;font-weight:600}
    .banner.green{background:#dcfce7;border:1px solid #86efac;color:#14532d}
    .banner.amber{background:#fef3c7;border:1px solid #fcd34d;color:#78350f}
    .banner.red{background:#fee2e2;border:1px solid #fca5a5;color:#7f1d1d}
    .banner.unknown{background:#f3f4f6;border:1px solid #d1d5db;color:#374151}
    .dot{width:14px;height:14px;border-radius:50%;flex-shrink:0}
    .dot.green{background:#16a34a}.dot.amber{background:#d97706}.dot.red{background:#dc2626}.dot.unknown{background:#9ca3af}
    .banner-text{flex:1}.banner-title{font-size:1.1rem}.banner-reasons{font-size:.82rem;font-weight:400;margin-top:2px;opacity:.85}
    .meta{font-size:.8rem;color:var(--muted);margin-left:auto;white-space:nowrap}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:16px}
    .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px;box-shadow:0 2px 8px rgba(0,0,0,.04)}
    .k{color:var(--muted);font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}
    .v{font-size:2rem;font-weight:700;color:var(--accent);line-height:1}
    .v.danger{color:var(--danger)}.v.warn{color:var(--warn)}.v.success{color:var(--success)}
    .vsub{font-size:.75rem;color:var(--muted);margin-top:2px}
    .funnel{display:flex;flex-direction:column;gap:6px;margin-bottom:16px}
    .frow{display:flex;align-items:center;gap:10px;font-size:.85rem}
    .fbar-bg{flex:1;background:#e5e7eb;border-radius:4px;height:18px;overflow:hidden;max-width:600px}
    .fbar{height:100%;background:var(--accent);border-radius:4px;transition:width .4s ease;min-width:2px}
    .flabel{width:160px;color:var(--muted);text-align:right;white-space:nowrap}
    .fcount{width:60px;text-align:right;font-weight:600}
    table{width:100%;border-collapse:collapse;font-size:.85rem}
    th,td{text-align:left;border-bottom:1px solid var(--line);padding:8px 10px;vertical-align:top}
    th{color:var(--muted);font-weight:600;font-size:.75rem;text-transform:uppercase;letter-spacing:.04em}
    tr:last-child td{border-bottom:none}
    .badge{display:inline-block;padding:1px 7px;border-radius:20px;font-size:.72rem;font-weight:600;white-space:nowrap}
    .badge.accepted{background:#dbeafe;color:#1e40af}
    .badge.planned{background:#e0e7ff;color:#3730a3}
    .badge.queued{background:#fef3c7;color:#92400e}
    .badge.succeeded{background:#d1fae5;color:#065f46}
    .badge.failed{background:#fee2e2;color:#7f1d1d}
    .badge.other{background:#f3f4f6;color:#374151}
    .mono{font-family:"IBM Plex Mono",monospace;font-size:.75rem;color:var(--muted)}
    .trunc{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:16px;box-shadow:0 2px 8px rgba(0,0,0,.04)}
    .refresh-bar{display:flex;align-items:center;gap:10px;margin-bottom:16px;font-size:.82rem;color:var(--muted)}
    .btn{padding:5px 14px;border-radius:8px;border:1px solid var(--line);background:var(--panel);cursor:pointer;font-size:.82rem;color:var(--ink)}
    .btn:hover{background:#f9fafb}
    #journey-result{margin-top:12px}
    .tl-event{padding:8px 0;border-left:2px solid var(--line);padding-left:12px;margin-left:6px;position:relative;font-size:.82rem}
    .tl-event::before{content:'';position:absolute;left:-5px;top:12px;width:8px;height:8px;border-radius:50%;background:var(--accent)}
    .tl-time{color:var(--muted);font-size:.75rem}
    .empty{color:var(--muted);font-style:italic;padding:12px 0}
    .rate-pill{display:inline-block;padding:2px 8px;border-radius:10px;font-size:.75rem;font-weight:600}
    .rate-pill.green{background:#d1fae5;color:#065f46}
    .rate-pill.amber{background:#fef3c7;color:#92400e}
    .rate-pill.red{background:#fee2e2;color:#7f1d1d}
    .filters{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:999px;padding:4px 10px;font-size:.75rem;background:#f8faf9;color:var(--ink)}
    .chip strong{font-weight:700}
    .link-btn{border:none;background:none;padding:0;color:var(--accent);cursor:pointer;font:inherit;text-decoration:underline;text-underline-offset:2px}
    .link-btn:hover{color:#0b5a54}
    .tabs{display:flex;gap:8px;align-items:center}
    .tab{padding:6px 12px;border:1px solid var(--line);border-radius:999px;background:#f8faf9;cursor:pointer;font-size:.8rem}
    .tab.active{background:var(--accent);border-color:var(--accent);color:#fff}
  </style>
</head>
<body>
<div class="wrap">
  <div style="display:flex;align-items:center;margin-bottom:8px">
    <div>
      <h1 style="margin:0;font-size:1.5rem">Dispatcher Admin</h1>
      <div style="font-size:.8rem;color:var(--muted)" id="version-line">Loading…</div>
    </div>
    <div style="margin-left:auto;display:flex;align-items:center;gap:8px">
      <div class="refresh-bar" style="margin:0">
        <label><input type="checkbox" id="auto-refresh"> Auto-refresh (30s)</label>
        <button class="btn" onclick="loadAll()">Refresh now</button>
      </div>
    </div>
  </div>

  <div id="health-banner" class="banner unknown">
    <div class="dot unknown"></div>
    <div class="banner-text"><div class="banner-title">Loading health status…</div></div>
  </div>

  <div class="section" style="padding:10px 12px">
    <div class="tabs" id="mode-tabs" style="margin-bottom:8px"></div>
    <div class="filters" id="filter-bar"></div>
  </div>

  <div class="ops-section">
  <h2>Pipeline Metrics</h2>
  <div class="grid" id="metrics"></div>

  <h2>Dispatch Funnel</h2>
  <div class="section">
    <div class="funnel" id="funnel"></div>
  </div>
  </div>

  <div class="intel-section">
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
    <div>
      <h2>Top Source Repos (<span id="top-window-label">Last 5 min</span>)</h2>
      <div class="section" style="padding:0">
        <table>
          <thead><tr><th>Repo</th><th>Events</th></tr></thead>
          <tbody id="top-repos"></tbody>
        </table>
      </div>
    </div>
    <div>
      <h2>Per-Repo Stats</h2>
      <div class="section" style="padding:0">
        <table>
          <thead><tr><th>Repo</th><th>Requests</th><th>Rate</th><th>Last Seen</th></tr></thead>
          <tbody id="repo-stats"></tbody>
        </table>
      </div>
    </div>
  </div>

  <h2>Recent Events</h2>
  <div class="section" style="padding:0">
    <table>
      <thead><tr><th>When</th><th>Type</th><th>Repo</th><th>Target</th><th>Version</th><th>Trace</th><th>Journey</th></tr></thead>
      <tbody id="recent-events"></tbody>
    </table>
  </div>
  </div>

  <div class="ops-section">
  <h2>Journey Explorer</h2>
  <div class="section">
    <div style="display:flex;gap:8px;align-items:center">
      <input id="delivery-id-input" type="text" placeholder="Enter deliveryId (e.g. abc123-def...)"
             style="flex:1;padding:6px 10px;border:1px solid var(--line);border-radius:8px;font-size:.85rem">
      <button class="btn" onclick="lookupJourney()">Look up</button>
    </div>
    <div id="journey-result"></div>
  </div>

  <h2>Recent Failures</h2>
  <div class="section" style="padding:0">
    <table>
      <thead><tr><th>When</th><th>Source</th><th>Target</th><th>Error</th></tr></thead>
      <tbody id="failures"></tbody>
    </table>
  </div>
  </div>
</div>

<script>
const state = {
  mode: 'ops',
  timeRange: '5m',
  filters: {
    sourceRepo: '',
    targetRepo: '',
    eventType: '',
  },
  data: {
    summary: null,
    topReposLast5m: [],
    recentFailures: [],
    repos: [],
    events: [],
  },
};

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, function(c) {
    return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
  });
}

function readStateFromUrl() {
  const q = new URLSearchParams(window.location.search);
  state.mode = q.get('mode') === 'intel' ? 'intel' : 'ops';
  state.timeRange = q.get('range') || '5m';
  state.filters.sourceRepo = q.get('sourceRepo') || '';
  state.filters.targetRepo = q.get('targetRepo') || '';
  state.filters.eventType = q.get('eventType') || '';
}

function writeStateToUrl() {
  const q = new URLSearchParams();
  if (state.mode !== 'ops') q.set('mode', state.mode);
  if (state.timeRange !== '5m') q.set('range', state.timeRange);
  if (state.filters.sourceRepo) q.set('sourceRepo', state.filters.sourceRepo);
  if (state.filters.targetRepo) q.set('targetRepo', state.filters.targetRepo);
  if (state.filters.eventType) q.set('eventType', state.filters.eventType);
  const next = q.toString() ? ('?' + q.toString()) : window.location.pathname;
  history.replaceState(null, '', next);
}

function setMode(value) {
  state.mode = value;
  writeStateToUrl();
  renderAll();
}

function setTimeRange(value) {
  state.timeRange = value;
  writeStateToUrl();
  loadSummary().then(renderAll);
}

function setFilter(key, value) {
  state.filters[key] = state.filters[key] === value ? '' : value;
  writeStateToUrl();
  renderAll();
}

function clearFilters() {
  state.filters.sourceRepo = '';
  state.filters.targetRepo = '';
  state.filters.eventType = '';
  writeStateToUrl();
  renderAll();
}

function eventTypeLabel(value) {
  return value ? value.split('.').pop() : '';
}

function renderFilterBar() {
  document.getElementById('mode-tabs').innerHTML = [
    '<button class="tab ' + (state.mode === 'ops' ? 'active' : '') + '" onclick="setMode(&quot;ops&quot;)">Operations</button>',
    '<button class="tab ' + (state.mode === 'intel' ? 'active' : '') + '" onclick="setMode(&quot;intel&quot;)">Management Intelligence</button>',
    '<span style="margin-left:auto"></span>',
    '<button class="tab ' + (state.timeRange === '5m' ? 'active' : '') + '" onclick="setTimeRange(&quot;5m&quot;)">5m</button>',
    '<button class="tab ' + (state.timeRange === '15m' ? 'active' : '') + '" onclick="setTimeRange(&quot;15m&quot;)">15m</button>',
    '<button class="tab ' + (state.timeRange === '60m' ? 'active' : '') + '" onclick="setTimeRange(&quot;60m&quot;)">60m</button>',
  ].join('');

  const chips = [];
  if (state.filters.sourceRepo) {
    chips.push('<span class="chip"><strong>Source</strong> ' + esc(state.filters.sourceRepo) + '</span>');
  }
  if (state.filters.targetRepo) {
    chips.push('<span class="chip"><strong>Target</strong> ' + esc(state.filters.targetRepo) + '</span>');
  }
  if (state.filters.eventType) {
    chips.push('<span class="chip"><strong>Type</strong> ' + esc(eventTypeLabel(state.filters.eventType)) + '</span>');
  }

  const hasFilters = chips.length > 0;
  document.getElementById('filter-bar').innerHTML =
    (hasFilters ? chips.join('') : '<span class="chip">No filters</span>') +
    '<button class="btn" style="margin-left:auto" onclick="clearFilters()" ' + (hasFilters ? '' : 'disabled') + '>Reset filters</button>';

  document.getElementById('top-window-label').textContent = 'Last ' + state.timeRange.replace('m', ' min');
}

function relTime(iso) {
  if (!iso) return '—';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (d < 60) return d + 's ago';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  return new Date(iso).toLocaleDateString();
}

function shortTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
}

function typeBadge(t) {
  const cls = t.endsWith('request.accepted') ? 'accepted' :
              t.endsWith('plan.created') ? 'planned' :
              t.endsWith('target.queued') ? 'queued' :
              t.endsWith('trigger.succeeded') ? 'succeeded' :
              t.endsWith('trigger.failed') ? 'failed' : 'other';
  const label = t.split('.').pop() ?? t;
  return '<span class="badge ' + cls + '">' + esc(label) + '</span>';
}

function ratePill(succeeded, failed) {
  const total = succeeded + failed;
  if (total === 0) return '<span class="rate-pill">—</span>';
  const pct = Math.round(succeeded / total * 100);
  const cls = pct >= 95 ? 'green' : pct >= 80 ? 'amber' : 'red';
  return '<span class="rate-pill ' + cls + '">' + pct + '%</span>';
}

function funnelBar(count, base) {
  if (base === 0) return '<div class="fbar-bg"><div class="fbar" style="width:0%"></div></div>';
  const pct = Math.min(100, Math.round(count / base * 100));
  return '<div class="fbar-bg"><div class="fbar" style="width:' + pct + '%"></div></div>';
}

async function loadHealth() {
  const res = await fetch('/admin/api/health');
  const h = await res.json();
  const status = h.status || 'unknown';
  const banner = document.getElementById('health-banner');
  banner.className = 'banner ' + status;
  const dot = banner.querySelector('.dot');
  dot.className = 'dot ' + status;
  const reasons = (h.reasons || []).join(' · ');
  const rateStr = h.successRate != null ? ' · Success rate: ' + Math.round(h.successRate * 100) + '%' : '';
  const lastStr = h.lastEventAt ? ' · Last event: ' + relTime(h.lastEventAt) : '';
  banner.querySelector('.banner-text').innerHTML =
    '<div class="banner-title">System: ' + status.charAt(0).toUpperCase() + status.slice(1) + '</div>' +
    '<div class="banner-reasons">' + esc(reasons) + rateStr + lastStr + '</div>';
}

async function loadSummary() {
  const res = await fetch('/admin/projections?minutes=' + encodeURIComponent(state.timeRange.replace('m', '')));
  const data = await res.json();
  state.data.summary = data.summary || {};
  state.data.topReposLast5m = data.topReposLast5m || [];
  state.data.recentFailures = data.recentFailures || [];
}

function renderSummary() {
  const s = state.data.summary || {};
  const succeeded = s.triggerSucceeded || 0;
  const failed = s.triggerFailed || 0;
  const total = succeeded + failed;
  const pct = total > 0 ? Math.round(succeeded / total * 100) : null;

  document.getElementById('version-line').textContent =
    'ENV: ' + (s.appversion || 'unknown') + ' · Total events all time: ' + (s.totalEvents || 0) +
    (s.lastEventAt ? ' · Last event: ' + relTime(s.lastEventAt) : '');

  document.getElementById('metrics').innerHTML = [
    '<div class="card"><div class="k">Requests Accepted</div><div class="v">' + (s.requestAccepted || 0) + '</div></div>',
    '<div class="card"><div class="k">Plans Created</div><div class="v">' + (s.planCreated || 0) + '</div></div>',
    '<div class="card"><div class="k">Targets Queued</div><div class="v">' + (s.targetQueued || 0) + '</div></div>',
    '<div class="card"><div class="k">Triggers Succeeded</div><div class="v success">' + succeeded + '</div></div>',
    '<div class="card"><div class="k">Triggers Failed</div><div class="v ' + (failed > 0 ? 'danger' : '') + '">' + failed + '</div></div>',
    '<div class="card"><div class="k">Success Rate</div><div class="v ' + (pct !== null ? (pct >= 95 ? 'success' : pct >= 80 ? 'warn' : 'danger') : '') + '">' + (pct !== null ? pct + '%' : '—') + '</div></div>',
  ].join('');

  const base = s.requestAccepted || 1;
  document.getElementById('funnel').innerHTML = [
    '<div class="frow"><div class="flabel">Requests accepted</div>' + funnelBar(s.requestAccepted || 0, base) + '<div class="fcount">' + (s.requestAccepted || 0) + '</div></div>',
    '<div class="frow"><div class="flabel">Plans created</div>' + funnelBar(s.planCreated || 0, base) + '<div class="fcount">' + (s.planCreated || 0) + '</div></div>',
    '<div class="frow"><div class="flabel">Targets queued</div>' + funnelBar(s.targetQueued || 0, base) + '<div class="fcount">' + (s.targetQueued || 0) + '</div></div>',
    '<div class="frow"><div class="flabel">Triggers succeeded</div>' + funnelBar(succeeded, base) + '<div class="fcount">' + succeeded + '</div></div>',
    '<div class="frow"><div class="flabel">Triggers failed</div>' + funnelBar(failed, base) + '<div class="fcount">' + failed + '</div></div>',
  ].join('');

  const topReposFiltered = (state.data.topReposLast5m || []).filter(function(r) {
    if (state.filters.sourceRepo && r.repo !== state.filters.sourceRepo) return false;
    return true;
  });

  document.getElementById('top-repos').innerHTML = topReposFiltered.map(function(r) {
    return '<tr><td class="trunc"><button class="link-btn" onclick="setFilter(&quot;sourceRepo&quot;,&quot;' + esc(r.repo) + '&quot;)">' + esc(r.repo) + '</button></td><td>' + esc(r.count) + '</td></tr>';
  }).join('') || '<tr><td colspan="2" class="empty">No activity in selected window</td></tr>';

  document.getElementById('failures').innerHTML = (state.data.recentFailures || []).filter(function(r) {
    if (state.filters.sourceRepo && r.sourceRepo !== state.filters.sourceRepo) return false;
    if (state.filters.targetRepo && r.targetRepo !== state.filters.targetRepo) return false;
    return true;
  }).map(function(r) {
    const when = (r.sk || '').split('#')[0];
    const sourceRepo = r.sourceRepo || '';
    const targetRepo = r.targetRepo || '';
    return '<tr><td class="mono">' + esc(shortTime(when)) + '</td><td class="trunc"><button class="link-btn" onclick="setFilter(&quot;sourceRepo&quot;,&quot;' + esc(sourceRepo) + '&quot;)">' + esc(sourceRepo) + '</button></td><td class="trunc">' + (targetRepo ? '<button class="link-btn" onclick="setFilter(&quot;targetRepo&quot;,&quot;' + esc(targetRepo) + '&quot;)">' + esc(targetRepo) + '</button>' : '—') + '</td><td class="trunc">' + esc(r.error) + '</td></tr>';
  }).join('') || '<tr><td colspan="4" class="empty">No recent failures</td></tr>';
}

async function loadRepos() {
  const res = await fetch('/admin/api/repos');
  state.data.repos = await res.json();
}

function renderRepos() {
  document.getElementById('repo-stats').innerHTML = (state.data.repos || []).filter(function(r) {
    if (state.filters.sourceRepo && r.repo !== state.filters.sourceRepo) return false;
    return true;
  }).slice(0, 15).map(function(r) {
    return '<tr><td class="trunc"><button class="link-btn" onclick="setFilter(&quot;sourceRepo&quot;,&quot;' + esc(r.repo) + '&quot;)">' + esc(r.repo) + '</button></td><td>' + esc(r.requestAccepted || 0) + '</td><td>' + ratePill(r.triggerSucceeded || 0, r.triggerFailed || 0) + '</td><td class="mono">' + relTime(r.lastEventAt) + '</td></tr>';
  }).join('') || '<tr><td colspan="4" class="empty">No data yet</td></tr>';
}

async function loadRecentEvents() {
  const res = await fetch('/admin/api/recent-events');
  state.data.events = await res.json();
}

function renderRecentEvents() {
  const events = (state.data.events || []).filter(function(e) {
    if (state.filters.sourceRepo && (e.sourceRepo || e.subject) !== state.filters.sourceRepo) return false;
    if (state.filters.targetRepo && (e.targetRepo || '') !== state.filters.targetRepo) return false;
    if (state.filters.eventType && (e.type || '') !== state.filters.eventType) return false;
    return true;
  });

  document.getElementById('recent-events').innerHTML = events.map(function(e) {
    const trace = e.traceparent ? '<span class="mono" title="' + esc(e.traceparent) + '">' + esc(e.traceparent.slice(0, 20)) + '…</span>' : '—';
    const sourceRepo = e.sourceRepo || e.subject;
    const targetRepo = e.targetRepo || '';
    const journey = e.deliveryId ? '<button class="btn" onclick="openJourney(&quot;' + esc(e.deliveryId) + '&quot;)">Open</button>' : '—';
    return '<tr><td class="mono">' + esc(shortTime(e.time)) + '</td><td><button class="link-btn" onclick="setFilter(&quot;eventType&quot;,&quot;' + esc(e.type || '') + '&quot;)">' + typeBadge(e.type || '') + '</button></td><td class="trunc"><button class="link-btn" onclick="setFilter(&quot;sourceRepo&quot;,&quot;' + esc(sourceRepo) + '&quot;)">' + esc(sourceRepo) + '</button></td><td class="trunc">' + (targetRepo ? '<button class="link-btn" onclick="setFilter(&quot;targetRepo&quot;,&quot;' + esc(targetRepo) + '&quot;)">' + esc(targetRepo) + '</button>' : '—') + '</td><td class="mono">' + esc(e.appversion || '—') + '</td><td>' + trace + '</td><td>' + journey + '</td></tr>';
  }).join('') || '<tr><td colspan="7" class="empty">No events yet</td></tr>';
}

function openJourney(deliveryId) {
  document.getElementById('delivery-id-input').value = deliveryId;
  if (state.mode !== 'ops') {
    state.mode = 'ops';
    writeStateToUrl();
    renderAll();
  }
  lookupJourney();
}

async function lookupJourney() {
  const deliveryId = document.getElementById('delivery-id-input').value.trim();
  const container = document.getElementById('journey-result');
  if (!deliveryId) { container.innerHTML = '<p class="empty">Enter a deliveryId to search</p>'; return; }
  container.innerHTML = '<p class="empty">Loading…</p>';
  try {
    const res = await fetch('/admin/api/journey?deliveryId=' + encodeURIComponent(deliveryId));
    const events = await res.json();
    if (!events || events.length === 0) {
      container.innerHTML = '<p class="empty">No events found for delivery: ' + esc(deliveryId) + '</p>';
      return;
    }
    container.innerHTML = '<div style="margin-top:8px">' + events.map(function(e) {
      return '<div class="tl-event">' +
        '<div>' + typeBadge(e.type || '') + ' <span style="font-weight:600">' + esc(e.subject) + '</span></div>' +
        '<div class="tl-time">' + esc(e.time) + (e.appversion ? ' · v' + esc(e.appversion) : '') + '</div>' +
        (e.traceparent ? '<div class="mono" style="margin-top:2px">' + esc(e.traceparent) + '</div>' : '') +
        (e.error ? '<div style="color:var(--danger);margin-top:2px;font-size:.8rem">' + esc(e.error) + '</div>' : '') +
        '</div>';
    }).join('') + '</div>';
  } catch (err) {
    container.innerHTML = '<p class="empty">Error: ' + esc(err.message) + '</p>';
  }
}

let refreshTimer = null;
document.getElementById('auto-refresh').addEventListener('change', function() {
  if (this.checked) {
    refreshTimer = setInterval(loadAll, 30000);
  } else {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
});

async function loadAll() {
  await Promise.allSettled([loadHealth(), loadSummary(), loadRepos(), loadRecentEvents()]);
  renderAll();
}

function renderAll() {
  document.querySelectorAll('.ops-section').forEach(function(node) {
    node.style.display = state.mode === 'ops' ? '' : 'none';
  });
  document.querySelectorAll('.intel-section').forEach(function(node) {
    node.style.display = state.mode === 'intel' ? '' : 'none';
  });
  renderFilterBar();
  renderSummary();
  renderRepos();
  renderRecentEvents();
}

readStateFromUrl();
loadAll();
</script>
</body>
</html>`;
}

export async function handler(event: ApiGatewayV2Event): Promise<ApiGatewayV2Response> {
  if (!env.DISPATCH_PROJECTIONS_TABLE_NAME) {
    throw new Error("DISPATCH_PROJECTIONS_TABLE_NAME must be set");
  }

  const ddb = createEventStoreClient();
  const projectionsTableName = env.DISPATCH_PROJECTIONS_TABLE_NAME;
  const eventsTableName = env.DISPATCH_EVENTS_TABLE_NAME;

  // Serve rich HTML dashboard
  if (event.rawPath === "/admin" || event.rawPath === "/admin/") {
    return {
      statusCode: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: htmlPage(),
    };
  }

  // Legacy projections endpoint (kept for backward compat)
  if (event.rawPath === "/admin/projections") {
    const requestedMinutes = Number(event.queryStringParameters?.minutes ?? "5");
    const minutes = requestedMinutes === 15 || requestedMinutes === 60 ? requestedMinutes : 5;
    const [summary, topReposLast5m, recentFailures] = await Promise.all([
      readSummaryProjection({ ddb, projectionsTableName }),
      readTopReposLastMinutes({ ddb, projectionsTableName, minutes, limit: 10 }),
      readRecentFailures({ ddb, projectionsTableName, limit: 20 }),
    ]);
    return jsonResponse(200, { summary, topReposLast5m, recentFailures });
  }

  // Health API
  if (event.rawPath === "/admin/api/health") {
    const summary = await readSummaryProjection({ ddb, projectionsTableName });
    const health = computeHealthStatus(summary);
    return jsonResponse(200, health);
  }

  // Repos API
  if (event.rawPath === "/admin/api/repos") {
    const repos = await readPerRepoStats({ ddb, projectionsTableName });
    return jsonResponse(200, repos);
  }

  // Recent events API
  if (event.rawPath === "/admin/api/recent-events") {
    if (!eventsTableName) {
      return jsonResponse(503, { error: "DISPATCH_EVENTS_TABLE_NAME not configured" });
    }
    const events = await readRecentEvents({ ddb, eventsTableName, limit: 50 });
    return jsonResponse(200, events);
  }

  // Journey API
  if (event.rawPath === "/admin/api/journey") {
    if (!eventsTableName) {
      return jsonResponse(503, { error: "DISPATCH_EVENTS_TABLE_NAME not configured" });
    }
    const deliveryId = event.queryStringParameters?.deliveryId;
    if (!deliveryId) {
      return jsonResponse(400, { error: "Missing required query parameter: deliveryId" });
    }
    const events = await readJourneyByDeliveryId({ ddb, eventsTableName, deliveryId });
    return jsonResponse(200, events);
  }

  log.info({ path: event.rawPath }, "Admin observability path not found");
  return jsonResponse(404, { error: "Not Found" });
}

