'use strict';
/* Hermit Stats: everything is computed at build time per video / per Hermit; this page only sums the
   current selection. Colors: up to three selected Hermits get categorical slots 1–3 (in selection order,
   so a Hermit keeps its color while selected); otherwise one series color, names on the axis. */

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const fmt = n => n == null ? '—' : Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M'
  : Math.abs(n) >= 1e4 ? (n / 1e3).toFixed(0) + 'k' : Math.abs(n) >= 1e3 ? (n / 1e3).toFixed(1) + 'k'
  : Number.isInteger(n) ? String(n) : n.toFixed(1);
const full = n => n == null ? '—' : Number(n).toLocaleString('en-GB', { maximumFractionDigits: 1 });
const sum = (a, f) => a.reduce((t, x) => t + (f(x) || 0), 0);
const hours = s => s / 3600;
const MAX_COMPARE = 3;

const state = { tab: 'overview', coll: null, sel: [], lex: 'Mobs', heat: 'rate', search: '', ep: null };
let META, VIDEOS, H = {};
let VISIT = { prev: null };       // when this browser last looked (unix seconds), for "new since your last visit"
const cache = { words: {}, trans: {}, eps: {}, vids: {} };
const charts = [];

/* ---------------------------------------------------------------- data access */

async function json(path) {
  const r = await fetch(path, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}
// Each season has its own folder: data/<season>/{videos.json, words/, transcripts/, episodes/}.
const season = (c = state.coll) => META.seasons.find(s => s.name === c);
const seasonFile = (kind, slug) => `data/${season().slug}/${kind}/${slug}.json`;
const words = slug => cache.words[`${state.coll}/${slug}`] ??= json(seasonFile('words', slug));
const transcripts = slug => cache.trans[`${state.coll}/${slug}`] ??= json(seasonFile('transcripts', slug));
const episodes = slug => cache.eps[`${state.coll}/${slug}`] ??= json(seasonFile('episodes', slug));
/** Make VIDEOS the current season's episodes, and drop an episode link that isn't in it. */
async function loadSeason() {
  VIDEOS = await (cache.vids[state.coll] ??= json(`data/${season().slug}/videos.json`));
  if (state.ep && !VIDEOS.some(v => v.id === state.ep)) state.ep = null;
}
const statusData = () => cache.status ??= json('data/status.json');
const ytUrl = (id, t) => `https://www.youtube.com/watch?v=${id}` + (t != null ? `&t=${Math.max(0, t - 2)}s` : '');
const clock = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const added = v => v.a ?? v.ts ?? 0;      // when the stats got the episode (older builds: its release time)
const longDate = d => new Date(typeof d === 'number' ? d * 1000 : d + 'T00:00:00Z')
  .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
function ago(ts) {
  const s = Date.now() / 1000 - ts;
  return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} minutes ago` : s < 129600 ? `${Math.round(s / 3600)} hours ago` : `${Math.round(s / 86400)} days ago`;
}

const collVids = () => VIDEOS.filter(v => v.c.includes(state.coll));
const present = () => [...new Set(collVids().map(v => v.h))].sort((a, b) => H[a].short.localeCompare(H[b].short));
const scope = () => state.sel.length ? state.sel : present();           // hermits the charts cover
const vids = () => { const s = new Set(scope()); return collVids().filter(v => s.has(v.h)); };
const comparing = () => state.sel.length >= 1 && state.sel.length <= MAX_COMPARE;
const color = slug => { const i = comparing() ? state.sel.indexOf(slug) : -1; return i >= 0 ? css(`--s${i + 1}`) : css('--s1'); };
const hermitcraft = () => season().series === 'Hermitcraft';
const people = () => hermitcraft() ? 'Hermits' : 'players';      // the Life Series isn't only Hermits
/** Wording for the season: outside Hermitcraft not everyone is a Hermit (the rest are friends of the Hermits). */
const words4 = s => hermitcraft() || !s ? s : s.replace(/\bHermits\b/g, 'players').replace(/\bHermit\b/g, 'player');
const friend = slug => !hermitcraft() && H[slug] && !H[slug].hermit;
const seasonTeams = () => Object.entries(META.teams?.[state.coll] ?? {});
const byHermit = list => { const m = {}; for (const v of list) (m[v.h] ??= []).push(v); return m; };
const name = slug => H[slug]?.short ?? slug;
// Channel name, plus what everyone calls them when the channel name doesn't say it (Solidarity (Jimmy)).
const fullName = slug => { const h = H[slug]; return h.name.toLowerCase().includes(h.short.toLowerCase()) ? h.name : `${h.name} (${h.short})`; };

function weekOf(d) {     // Monday of the ISO week, as YYYY-MM-DD
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return t.toISOString().slice(0, 10);
}
function weeks(list) {
  const ds = list.map(v => v.d).filter(Boolean).sort();
  if (!ds.length) return [];
  const out = [], end = weekOf(ds[ds.length - 1]);
  for (let t = new Date(weekOf(ds[0]) + 'T00:00:00Z'); t.toISOString().slice(0, 10) <= end; t.setUTCDate(t.getUTCDate() + 7))
    out.push(t.toISOString().slice(0, 10));
  return out;
}

/* ---------------------------------------------------------------- chart scaffolding */

function base() {
  return {
    backgroundColor: 'transparent', animationDuration: 300,
    textStyle: { fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif', color: css('--ink-2') },
    tooltip: {
      backgroundColor: css('--surface'), borderColor: css('--ring'), borderWidth: 1, padding: [8, 10],
      textStyle: { color: css('--ink'), fontSize: 13 }, extraCssText: 'border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.14)',
      confine: true,
    },
    grid: { left: 8, right: 40, top: 16, bottom: 8, containLabel: true },
  };
}
const axis = extra => ({
  axisLine: { lineStyle: { color: css('--axis') } }, axisTick: { show: false },
  splitLine: { lineStyle: { color: css('--grid') } }, ...extra,
  axisLabel: { color: css('--muted'), hideOverlap: true, ...extra?.axisLabel },
});
/** The heatmap colour at t (0–1) along the --seq ramp, and black or white text that reads on it. */
function cellColor(t) {
  const stops = [0, 1, 2, 3, 4].map(i => css(`--seq-${i}`)), x = Math.min(3.999, Math.max(0, t) * 4), i = Math.floor(x), f = x - i;
  const rgb = h => [1, 3, 5].map(j => parseInt(h.slice(j, j + 2), 16));
  const a = rgb(stops[i]), b = rgb(stops[i + 1]);
  return a.map((c, j) => c + (b[j] - c) * f);
}
const inkOn = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#0b0b0b' : '#ffffff';
const tip = (value, label, extra = '') => `<div class="hovercard"><b>${esc(value)}</b> ${esc(label)}${extra}</div>`;
const legend = () => ({ top: 0, left: 0, icon: 'roundRect', itemWidth: 14, itemHeight: 4, textStyle: { color: css('--ink-2') } });

const VIEW_NAMES = { bar: 'Bars', line: 'Lines', scatter: 'Dots', heatmap: 'Heatmap', graph: 'Network', wordCloud: 'Word cloud', boxplot: 'Boxes', radar: 'Radar' };

/** A card: title, subtitle, optional tools, a chart (or custom HTML) and a table view of the same numbers. */
function card(container, spec) {
  const el = document.createElement('section');
  el.className = 'card' + (spec.wide ? ' wide' : '');
  el.innerHTML = `<header><div><h3></h3><p class="sub"></p></div><div class="tools"></div></header>
    <div class="body"></div><div class="tablewrap" hidden></div>`;
  $('h3', el).textContent = words4(spec.title);
  $('.sub', el).textContent = words4(spec.sub || '');
  container.appendChild(el);
  const tools = $('.tools', el);
  for (const t of spec.tools || []) tools.appendChild(t);
  const result = spec.build();
  const body = $('.body', el);
  if (!result || result.empty) {
    body.innerHTML = `<div class="empty">${esc(result?.empty || 'Nothing to show for this selection.')}</div>`;
    return;
  }
  if (result.option) {
    const div = document.createElement('div');
    div.className = 'chart';
    div.style.height = (result.height || spec.height || 360) + 'px';
    body.appendChild(div);
    const chart = echarts.init(div, null, { renderer: 'canvas' });
    chart.setOption(result.option);
    if (result.onClick) chart.on('click', result.onClick);
    charts.push(chart);
  }
  if (result.html) body.insertAdjacentHTML('beforeend', result.html);
  if (result.node) body.appendChild(result.node);
  if (result.table) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Table';
    // While the table shows, the button names the view it switches back to.
    const back = result.option ? VIEW_NAMES[result.option.series?.[0]?.type] || 'Chart' : 'Chips';
    const wrap = $('.tablewrap', el);
    btn.onclick = () => {
      const on = wrap.hidden;
      if (on && !wrap.firstChild) wrap.appendChild(table(result.table));
      wrap.hidden = !on;
      body.hidden = on;
      btn.textContent = on ? back : 'Table';
      btn.title = on ? `Show the ${back.toLowerCase()} again` : 'Show the numbers as a table';
    };
    tools.appendChild(btn);
    if (result.tableOnly) { btn.click(); btn.remove(); }
  }
}

/** Sortable table. cols: [{k, label, n (numeric), f (format), link (row => url), internal (link stays on the page)}] */
function table({ cols, rows }) {
  const t = document.createElement('table');
  let sortK = null, dir = -1;
  const draw = () => {
    const data = sortK == null ? rows : [...rows].sort((a, b) => {
      const x = a[sortK], y = b[sortK];
      return (x == null) - (y == null) || (typeof x === 'number' ? (x - y) : String(x).localeCompare(String(y))) * dir;
    });
    t.innerHTML = '';
    const head = t.createTHead().insertRow();
    for (const c of cols) {
      const th = document.createElement('th');
      th.textContent = words4(c.label) + (sortK === c.k ? (dir < 0 ? ' ↓' : ' ↑') : '');
      if (c.n) th.className = 'n';
      th.onclick = () => { dir = sortK === c.k ? -dir : (c.n ? -1 : 1); sortK = c.k; draw(); };
      head.appendChild(th);
    }
    const tb = t.createTBody();
    for (const r of data) {
      const tr = tb.insertRow();
      for (const c of cols) {
        const td = tr.insertCell();
        if (c.n) td.className = 'n';
        const val = c.f ? c.f(r[c.k], r) : (c.n ? full(r[c.k]) : r[c.k] ?? '');
        if (c.link) {
          const a = document.createElement('a');
          a.href = c.link(r); a.textContent = val;
          if (!c.internal) { a.target = '_blank'; a.rel = 'noopener'; }
          td.appendChild(a);
        } else td.textContent = val;
      }
    }
  };
  draw();
  return t;
}

/** Ranked horizontal bars. items: [{name, value, slug?, extra?}] */
/** zoom: start the axis near the smallest value (for rates that all sit in a narrow band) and show its scale.
    avg: a dashed line at the mean of the bars. */
function hbar(items, { unit = '', top = 25, decimals, onSlug = true, valueLabel = true, zoom = false, avg = false, labelWidth = 160 } = {}) {
  items = items.filter(i => i.value > 0).sort((a, b) => b.value - a.value).slice(0, top);
  if (!items.length) return null;
  const show = v => decimals != null ? v.toFixed(decimals) : fmt(v);
  const lo = items[items.length - 1].value, hi = items[0].value;
  const step = 10 ** Math.floor(Math.log10(hi - lo || 1));
  const min = zoom && items.length > 1 ? Math.max(0, Math.floor((lo - (hi - lo) * 0.5) / step) * step) : 0;
  const mean = sum(items, i => i.value) / items.length;
  return {
    height: Math.max(160, items.length * 24 + 24) + (zoom ? 24 : 0),
    option: {
      ...base(),
      grid: { ...base().grid, left: 16, top: avg ? 28 : 16 },
      tooltip: { ...base().tooltip, trigger: 'item', formatter: p => p.componentType === 'markLine'
        ? tip(show(p.value) + (unit ? ' ' + unit : ''), 'average')
        : tip(show(p.value) + (unit ? ' ' + unit : ''), p.name, items[p.dataIndex].extra || '') },
      xAxis: axis({ type: 'value', min, axisLabel: { show: zoom, color: css('--muted') }, splitLine: { show: zoom, lineStyle: { color: css('--grid') } } }),
      yAxis: axis({ type: 'category', inverse: true, data: items.map(i => i.name), axisLine: { show: false },
        axisLabel: { color: css('--ink-2'), width: labelWidth, overflow: 'truncate', ellipsis: '…' } }),
      series: [{
        type: 'bar', barMaxWidth: 14, barCategoryGap: '30%',
        data: items.map(i => ({ value: i.value, itemStyle: { color: i.slug ? color(i.slug) : css('--s1'), borderRadius: [0, 4, 4, 0] } })),
        label: { show: valueLabel, position: 'right', color: css('--ink-2'), fontSize: 12, formatter: p => show(p.value) },
        emphasis: { itemStyle: { opacity: 0.85 } },
        markLine: avg && items.length > 2 ? { silent: false, symbol: 'none', data: [{ xAxis: +mean.toFixed(3) }],
          lineStyle: { color: css('--ink-2'), type: 'dashed', width: 1 },
          label: { position: 'start', formatter: `avg ${show(mean)}`, color: css('--ink-2'), fontSize: 11 } } : undefined,
      }],
    },
    onClick: onSlug ? p => { const s = items[p.dataIndex]?.slug; if (s) toggle(s); } : null,
    table: { cols: [{ k: 'name', label: 'Name' }, { k: 'value', label: unit || 'Value', n: true, f: v => show(v) }], rows: items },
  };
}

/** Weekly lines. series: [{name, color, data: {week: value}}] */
function weekly(list, series, { unit = '', cumulative = false, type = 'line' } = {}) {
  const ws = weeks(list);
  if (!ws.length) return null;
  const s = series.map(se => {
    let run = 0;
    const data = ws.map(w => { const v = se.data[w] || 0; run += v; return [w, +(cumulative ? run : v).toFixed(2)]; });
    return {
      name: se.name, type, data, showSymbol: false, symbolSize: 8, smooth: false,
      lineStyle: { width: 2, color: se.color }, itemStyle: { color: se.color, borderRadius: [4, 4, 0, 0] },
      barMaxWidth: 18, emphasis: { focus: 'series' },
      endLabel: series.length > 1 && type === 'line' ? { show: true, formatter: '{a}', color: css('--ink-2') } : undefined,
    };
  });
  return {
    option: {
      ...base(),
      legend: series.length > 1 ? legend() : undefined,
      grid: { ...base().grid, top: series.length > 1 ? 32 : 16, right: series.length > 1 ? 64 : 24 },
      tooltip: { ...base().tooltip, trigger: 'axis', axisPointer: { type: type === 'bar' ? 'shadow' : 'line', lineStyle: { color: css('--axis') } },
        formatter: ps => `<div class="hovercard">Week of ${esc(ps[0].value[0])}` + ps.map(p =>
          `<br><span style="display:inline-block;width:10px;height:3px;border-radius:2px;background:${p.color};vertical-align:middle;margin-right:6px"></span><b>${esc(full(p.value[1]))}</b> ${esc(p.seriesName)}`).join('') + '</div>' },
      xAxis: axis({ type: 'time', splitLine: { show: false } }),
      yAxis: axis({ type: 'value', name: unit, nameTextStyle: { color: css('--muted'), align: 'left' } }),
      series: s,
    },
    table: {
      cols: [{ k: 'week', label: 'Week of' }, ...series.map((se, i) => ({ k: 's' + i, label: se.name, n: true }))],
      rows: ws.map((w, j) => Object.fromEntries([['week', w], ...s.map((se, i) => ['s' + i, se.data[j][1]])])),
    },
  };
}

/** Series for "per Hermit when comparing, else one total". f(videoList) -> {week: value} */
function perHermitSeries(list, f, totalName) {
  if (comparing()) {
    const g = byHermit(list);
    return state.sel.filter(s => g[s]).map(s => ({ name: name(s), color: color(s), data: f(g[s]) }));
  }
  return [{ name: totalName, color: css('--s1'), data: f(list) }];
}
const countByWeek = (list, val = () => 1) => { const m = {}; for (const v of list) if (v.d) m[weekOf(v.d)] = (m[weekOf(v.d)] || 0) + val(v); return m; };

/* ---------------------------------------------------------------- selection + url state */

function toggle(slug) {
  const i = state.sel.indexOf(slug);
  if (i >= 0) state.sel.splice(i, 1); else state.sel.push(slug);
  state.ep = null;
  update();
}

/** Select exactly a team's members (those with videos this season); clicking the selected team clears it. */
function selectTeam(members) {
  state.sel = teamPressed(members) ? [] : members.filter(s => present().includes(s));
  state.ep = null;
  update();
}
const teamPressed = members => {
  const m = members.filter(s => present().includes(s));
  return m.length > 0 && m.length === state.sel.length && m.every(s => state.sel.includes(s));
};

function selectionLabel() {
  if (!state.sel.length) return `All ${people()}`;
  const team = seasonTeams().find(([, m]) => teamPressed(m));
  if (team) return `${team[0]} (${state.sel.length} ${people()})`;
  return state.sel.length <= MAX_COMPARE ? state.sel.map(name).join(', ') : `${state.sel.length} ${people()}`;
}

function readHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  if (q.get('tab')) state.tab = q.get('tab');
  if (q.get('season') && META.collections.includes(q.get('season'))) state.coll = q.get('season');
  state.sel = (q.get('h') || '').split(',').filter(s => H[s]);
  state.search = q.get('q') || '';
  state.ep = q.get('ep') || null;          // checked against the season once it's loaded
}
/** The URL hash for a state (the current one, or one with some fields changed). */
function hashFor(changes = {}) {
  const s = { ...state, ...changes }, q = new URLSearchParams();
  q.set('tab', s.tab);
  if (s.coll !== META.collections[0]) q.set('season', s.coll);
  if (s.sel.length) q.set('h', s.sel.join(','));
  if (s.tab === 'search' && s.search) q.set('q', s.search);
  if (s.ep) q.set('ep', s.ep);
  return '#' + q.toString();
}
function writeHash() { history.replaceState(null, '', hashFor()); }
const epHref = id => hashFor({ ep: id });
const searchHref = (phrase, sel = state.sel) => hashFor({ tab: 'search', search: phrase, sel, ep: null });
/** Episode pages are real history entries, so the browser's Back button closes them. */
function openEpisode(id) { location.hash = epHref(id); }

function drawFilters() {
  const sel = $('#collection');
  const series = [...new Set(META.seasons.map(s => s.series))];
  sel.innerHTML = series.map(name => `<optgroup label="${esc(name)}">` + META.seasons.filter(s => s.series === name)
    .map(s => `<option${s.name === state.coll ? ' selected' : ''}>${esc(s.name)}</option>`).join('') + '</optgroup>').join('');
  const box = $('#hermits');
  box.innerHTML = '';
  const all = document.createElement('button');
  all.type = 'button'; all.className = 'chip all'; all.textContent = `All ${people()}`;
  $('#people').textContent = people() === 'players' ? 'Players' : 'Hermits';
  all.setAttribute('aria-pressed', String(!state.sel.length));
  all.onclick = () => { state.sel = []; state.ep = null; update(); };
  box.appendChild(all);
  for (const slug of present()) {
    const h = H[slug];
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip'; b.title = fullName(slug) + (friend(slug) ? ' · friend of the Hermits' : '');
    b.setAttribute('aria-pressed', String(state.sel.includes(slug)));
    if (h.avatar) { const img = new Image(); img.src = h.avatar; img.alt = ''; img.loading = 'lazy'; b.appendChild(img); }
    else { const d = document.createElement('span'); d.className = 'dot'; b.appendChild(d); }
    b.appendChild(document.createTextNode(h.short));
    if (comparing() && state.sel.includes(slug)) {
      const k = document.createElement('span'); k.className = 'key'; k.style.background = color(slug); b.appendChild(k);
    }
    b.onclick = () => toggle(slug);
    box.appendChild(b);
  }
  const teams = seasonTeams();
  const tbox = $('#teams');
  tbox.innerHTML = '';
  tbox.hidden = !teams.length;
  for (const [team, members] of teams) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip team';
    b.title = members.map(name).join(', ');
    b.setAttribute('aria-pressed', String(teamPressed(members)));
    const faces = document.createElement('span');
    faces.className = 'faces';
    for (const s of members) {
      if (!H[s]?.avatar) continue;
      const img = new Image(); img.src = H[s].avatar; img.alt = ''; img.loading = 'lazy'; faces.appendChild(img);
    }
    b.append(faces, team);
    b.onclick = () => selectTeam(members);
    tbox.appendChild(b);
  }
  $('#sel-hint').textContent = !state.sel.length ? '— all of them; pick up to 3 to compare'
    : state.sel.length > MAX_COMPARE ? `— ${state.sel.length} selected, shown together` : '— click again to deselect';
  const list = collVids();
  $('#summary').textContent = `${state.coll} · ${full(list.length)} episodes · ${full(Math.round(hours(sum(list, v => v.dur))))} hours · ${present().length} ${people()}` + (hermitcraft() ? '' : ` (${present().filter(s => !friend(s)).length} Hermits, ${present().filter(friend).length} friends of the Hermits)`);
  $('#search-hint').textContent = `Counts every time a word or phrase is said in the selected ${people()}' episodes, and lists each moment with a link straight to it.`;
  $('#sel-summary').textContent = `${state.coll} · ${selectionLabel()}`;
  const panel = state.ep ? 'episode' : state.tab;
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === panel));
  for (const p of document.querySelectorAll('[data-panel]')) p.classList.toggle('on', p.dataset.panel === panel);
  document.body.classList.toggle('page-status', panel === 'status');     // the status page isn't per season or Hermit
}

let renderToken = 0;
async function update() {
  writeHash();
  drawFilters();
  const token = ++renderToken;
  $('#main').classList.add('loading');
  try {
    await (state.ep ? episodePage : TABS[state.tab])?.(token);
  } catch (e) {
    console.error(e);
  }
  if (token === renderToken) $('#main').classList.remove('loading');
}

function reset(id, token) {
  if (token !== renderToken) return null;      // a newer render has started
  while (charts.length) charts.pop().dispose();
  const el = document.getElementById(id);
  el.innerHTML = '';
  return el;
}

/* ---------------------------------------------------------------- aggregation helpers */

async function aggregateWords(slugs) {
  const docs = await Promise.all(slugs.map(words));
  const w = {}, b = {}, t = {};
  let n = 0;
  for (const doc of docs) {
    const d = doc[state.coll];
    if (!d) continue;
    n += d.n;
    for (const [k, c] of d.w) w[k] = (w[k] || 0) + c;
    for (const [k, c] of d.b) b[k] = (b[k] || 0) + c;
    for (const [k, c] of d.t) t[k] = (t[k] || 0) + c;
  }
  const top = (m, k) => Object.entries(m).sort((x, y) => y[1] - x[1]).slice(0, k);
  return { n, w: top(w, 150), b: top(b, 80).filter(([k]) => !noise(k)), t: top(t, 80).filter(([k]) => !noise(k)), docs };
}

// Phrases that are just sound effects or hesitation: one word repeated ("da da da") or only fillers ("mm hm mm").
const NOISE = new Set(['mm', 'hm', 'hmm', 'mhm', 'um', 'uh', 'ah', 'oh', 'eh', 'huh']);
const noise = phrase => { const ws = phrase.split(' '); return new Set(ws).size === 1 || ws.every(w => NOISE.has(w)); };

function lexTotals(list, group) {
  const m = {};
  for (const v of list) for (const [k, c] of Object.entries(v.lex[group] || {})) m[k] = (m[k] || 0) + c;
  return m;
}

function mentionsGiven(list) {
  const m = {};
  for (const v of list) for (const [k, c] of Object.entries(v.m)) m[k] = (m[k] || 0) + c;
  return m;
}

function hermitMetrics() {
  const g = byHermit(collVids()), out = {};
  const received = {};
  for (const v of collVids()) for (const [k, c] of Object.entries(v.m)) received[k] = (received[k] || 0) + c;
  for (const [slug, list] of Object.entries(g)) {
    const secs = sum(list, v => v.dur), w = sum(list, v => v.w);
    const fill = sum(list, v => sum(Object.values(v.lex.Fillers || {}), x => x));
    const rs = list.filter(v => v.r != null);
    out[slug] = {
      slug, name: name(slug), videos: list.length, hours: hours(secs), words: w,
      wpm: secs ? w / (secs / 60) : null,
      richness: rs.length ? 100 * sum(rs, v => v.r) / rs.length : null,
      laughs: secs ? sum(list, v => v.laugh) / hours(secs) : null,
      fillers: w ? 1000 * fill / w : null,
      given: secs ? sum(list, v => sum(Object.values(v.m), x => x)) / hours(secs) : null,
      received: received[slug] || 0,
      length: list.length ? secs / list.length / 60 : null,
      views: sum(list, v => v.v),
    };
  }
  return out;
}

const pick = (metrics, k) => scope().filter(s => metrics[s]).map(s => ({ name: name(s), slug: s, value: metrics[s][k] }));

/* ---------------------------------------------------------------- tabs */

const TABS = {
  async overview(token) {
    const list = vids();
    const tiles = $('#tiles');
    const secs = sum(list, v => v.dur), w = sum(list, v => v.w);
    const mentions = sum(list, v => sum(Object.values(v.m), x => x));
    const t = [
      ['Episodes', fmt(list.length)], ['Hours of footage', fmt(Math.round(hours(secs)))], ['Words spoken', fmt(w)],
      ['Words per minute', secs ? (w / (secs / 60)).toFixed(0) : '—'], ['Views', fmt(sum(list, v => v.v))],
      ['Likes', fmt(sum(list, v => v.l))], [words4('Times another Hermit is named'), fmt(mentions)],
    ];
    const sharing = comparing() ? state.sel.filter(s => present().includes(s)) : [];
    const [docs, faces] = await Promise.all([Promise.all(sharing.map(words)), Promise.all(sharing.map(s => loadImage(H[s].avatar)))]);
    const el = reset('overview-cards', token);
    if (!el) return;
    tiles.innerHTML = t.map(([k, v]) => `<div class="tile"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div></div>`).join('');

    const news = whatsNew();
    if (news) card(el, { title: news.title, sub: news.sub, wide: true, build: () => ({ html: news.html }) });
    if (sharing.length) {
      card(el, { title: sharing.length === 1 ? 'Share card' : 'Share cards', wide: true,
        sub: `${state.coll} in one picture, for Reddit, Discord or anywhere else`,
        build: () => {
          const wrap = document.createElement('div');
          wrap.className = 'shares';
          sharing.forEach((s, i) => wrap.appendChild(shareCard(s, docs[i]?.[state.coll], faces[i])));
          return { node: wrap };
        } });
    }

    card(el, { title: 'Episodes per week', sub: comparing() ? 'Selected Hermits' : 'Uploads in this season, all selected Hermits combined',
      build: () => weekly(list, perHermitSeries(list, l => countByWeek(l), 'Episodes'), { type: 'bar' }) });
    card(el, { title: 'Words spoken over the season', sub: 'Running total of words in transcripts',
      build: () => weekly(list, perHermitSeries(list, l => countByWeek(l, v => v.w), 'Words'), { cumulative: true }) });
    const m = hermitMetrics();
    card(el, { title: 'Hours of footage', sub: 'Total episode length by Hermit · click a bar to select',
      build: () => hbar(pick(m, 'hours'), { unit: 'hours', decimals: 1 }) });
    card(el, { title: 'Episode length', sub: 'Minutes per episode: the box spans the middle half, the line is the median',
      build: () => boxplot(scope(), v => v.dur / 60, 'minutes') });
    card(el, { title: 'Total views', sub: 'Across this season’s episodes',
      build: () => hbar(pick(m, 'views'), { unit: 'views' }) });
    const teams = seasonTeams();
    if (teams.length) {
      card(el, { title: 'Teams', sub: 'Average views per episode for each team’s members · click a bar to select the team',
        build: () => {
          const g = byHermit(collVids());
          const rows = teams.map(([t, members]) => {
            const l = members.flatMap(s => g[s] || []), secs = sum(l, v => v.dur), w = sum(l, v => v.w);
            return { name: t, members, value: l.length ? sum(l, v => v.v) / l.length : 0, eps: l.length, hours: hours(secs), wpm: secs ? w / (secs / 60) : 0 };
          });
          const r = hbar(rows, { unit: 'views per episode', onSlug: false });
          if (!r) return r;
          const sorted = rows.filter(x => x.value > 0).sort((a, b) => b.value - a.value);
          r.onClick = p => selectTeam(sorted[p.dataIndex].members);
          r.table = { cols: [{ k: 'name', label: 'Team' }, { k: 'eps', label: 'Episodes', n: true }, { k: 'hours', label: 'Hours', n: true, f: v => v.toFixed(0) },
            { k: 'value', label: 'Views / episode', n: true, f: v => fmt(v) }, { k: 'wpm', label: 'Words / min', n: true, f: v => v.toFixed(0) }], rows: sorted };
          return r;
        } });
    }
    card(el, { title: 'Upload days', sub: 'Which weekday episodes come out (UTC)',
      build: () => {
        const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        const c = Object.fromEntries(days.map(d => [d, 0]));
        for (const v of list) if (v.d) c[days[(new Date(v.d + 'T00:00:00Z').getUTCDay() + 6) % 7]]++;
        return hbar(days.map(d => ({ name: d, value: c[d] })), { unit: 'episodes', onSlug: false });
      } });
  },

  async words(token) {
    const agg = await aggregateWords(scope());
    const all = await Promise.all(present().map(words));
    const el = reset('words-cards', token);
    if (!el) return;
    const list = vids();
    card(el, { title: 'Most-used words', sub: `${fmt(agg.n)} words spoken · common words like “the” and “really” left out`, wide: true, height: 420,
      build: () => agg.w.length ? {
        option: {
          ...base(),
          tooltip: { ...base().tooltip, formatter: p => tip(full(p.value), p.name) },
          series: [{
            type: 'wordCloud', shape: 'square', gridSize: 8, sizeRange: [14, 84], rotationRange: [0, 0],
            width: '100%', height: '100%', drawOutOfBound: false, layoutAnimation: true,
            textStyle: { fontFamily: 'system-ui, sans-serif', fontWeight: 600,
              color: p => [css('--seq-4'), css('--seq-3'), css('--seq-2')][Math.min(2, Math.floor(p.dataIndex / 20))] },
            emphasis: { textStyle: { color: css('--s2') } },
            data: agg.w.slice(0, 120).map(([name, value]) => ({ name, value })),
          }],
        },
        table: { cols: [{ k: 'name', label: 'Word' }, { k: 'value', label: 'Times said', n: true }], rows: agg.w.map(([name, value]) => ({ name, value })) },
      } : null });
    card(el, { title: 'Top words', build: () => hbar(agg.w.map(([name, value]) => ({ name, value })), { unit: 'times', onSlug: false }) });
    card(el, { title: 'Top two-word phrases', sub: 'Repeated sounds like “da da” left out', build: () => hbar(agg.b.map(([name, value]) => ({ name, value })), { unit: 'times', onSlug: false, top: 20 }) });
    card(el, { title: 'Top three-word phrases', wide: true, sub: 'Repeated sounds like “da da da” left out', build: () => hbar(agg.t.map(([name, value]) => ({ name, value })), { unit: 'times', onSlug: false, top: 20 }) });

    card(el, { title: 'Signature words', wide: true,
      sub: 'Words each Hermit uses far more than the others this season (log-odds against everyone else)',
      build: () => {
        const rows = [];
        const html = scope().map((s, i) => {
          const d = all[present().indexOf(s)]?.[state.coll];
          const xs = (d?.x || []).slice(0, 14);
          for (const [w, z, c] of xs) rows.push({ hermit: name(s), word: w, z, c });
          const img = H[s].avatar ? `<img src="${esc(H[s].avatar)}" alt="">` : '';
          return `<div class="sig"><h4>${img}${esc(H[s].short)}</h4>${xs.map(([w, z, c]) => `<span class="w" title="said ${c} times">${esc(w)}</span>`).join('')}</div>`;
        }).join('');
        return { html: `<div class="sigs">${html}</div>`,
          table: { cols: [{ k: 'hermit', label: 'Hermit' }, { k: 'word', label: 'Word' }, { k: 'c', label: 'Times said', n: true }, { k: 'z', label: 'Distinctiveness (z)', n: true }], rows } };
      } });

    card(el, { title: 'Catchphrases', wide: true,
      sub: 'Phrases each Hermit says far more than the others, in the most of their episodes · click one to search it',
      build: () => {
        const rows = [];
        const html = scope().map(s => {
          const d = all[present().indexOf(s)]?.[state.coll];
          const ps = (d?.p || []).slice(0, 8);
          for (const [p, z, c, n] of ps) rows.push({ hermit: name(s), phrase: p, c, n, z });
          const img = H[s].avatar ? `<img src="${esc(H[s].avatar)}" alt="">` : '';
          return `<div class="sig"><h4>${img}${esc(H[s].short)}</h4>${ps.map(([p, , c, n]) =>
            `<a class="w" href="${esc(searchHref(p, []))}" title="said ${c} times, in ${n} episodes">${esc(p)}</a>`).join('') || '<span class="muted small">None yet</span>'}</div>`;
        }).join('');
        return { html: `<div class="sigs">${html}</div>`,
          table: { cols: [{ k: 'hermit', label: 'Hermit' }, { k: 'phrase', label: 'Phrase' }, { k: 'n', label: 'Episodes', n: true }, { k: 'c', label: 'Times said', n: true }, { k: 'z', label: 'Distinctiveness (z)', n: true }], rows } };
      } });

    const groupSel = document.createElement('select');
    groupSel.setAttribute('aria-label', 'Vocabulary');
    groupSel.innerHTML = Object.keys(META.lexicon).map(g => `<option${g === state.lex ? ' selected' : ''}>${esc(g)}</option>`).join('');
    groupSel.onchange = () => { state.lex = groupSel.value; update(); };
    card(el, { title: `Vocabulary: ${state.lex}`, sub: 'Times each term is said', tools: [groupSel],
      build: () => hbar(Object.entries(lexTotals(list, state.lex)).map(([name, value]) => ({ name, value })), { unit: 'times', onSlug: false }) });
    card(el, { title: `${state.lex}, by Hermit`, sub: 'Per 10,000 words spoken, so long and short seasons compare fairly',
      build: () => {
        const g = byHermit(list);
        return hbar(Object.entries(g).map(([s, l]) => {
          const n = sum(Object.values(lexTotals(l, state.lex)), x => x), w = sum(l, v => v.w);
          return { name: name(s), slug: s, value: w ? 1e4 * n / w : 0, extra: `<br>${full(n)} times in ${full(w)} words` };
        }), { unit: 'per 10k words', decimals: 1 });
      } });
  },

  async interactions(token) {
    const el = reset('interactions-cards', token);
    if (!el) return;
    const all = collVids(), list = vids(), ps = present(), sel = new Set(state.sel);
    const g = byHermit(all);
    const hrs = Object.fromEntries(Object.entries(g).map(([s, l]) => [s, hours(sum(l, v => v.dur))]));
    const pair = {};   // "a>b" -> mentions of b in a's videos
    for (const v of all) for (const [k, c] of Object.entries(v.m)) if (H[k]) pair[v.h + '>' + k] = (pair[v.h + '>' + k] || 0) + c;

    card(el, { title: 'Who talks about whom', wide: true, height: 560,
      sub: 'Each Hermit’s three most-named connections (all of them for selected Hermits). Line thickness = how often the two name each other on camera; circle size = how often a Hermit is named. Drag to rearrange, click to select.',
      build: () => {
        const nodesSet = new Set(ps);
        for (const k of Object.keys(pair)) { const b = k.split('>')[1]; if (H[b]) nodesSet.add(b); }
        const received = {};
        for (const [k, c] of Object.entries(pair)) { const b = k.split('>')[1]; received[b] = (received[b] || 0) + c; }
        const und = {};
        for (const [k, c] of Object.entries(pair)) { const [a, b] = k.split('>'); const key = [a, b].sort().join('|'); und[key] = (und[key] || 0) + c; }
        const edges = Object.entries(und).sort((x, y) => y[1] - x[1]);
        const maxE = edges[0]?.[1] || 1, maxR = Math.max(1, ...Object.values(received));
        const strongest = new Set();
        for (const s of nodesSet) edges.filter(([k]) => k.split('|').includes(s)).slice(0, 3).forEach(([k]) => strongest.add(k));
        const keep = edges.filter(([k]) => strongest.has(k) || k.split('|').some(s => sel.has(s)));
        const muted = css('--muted');
        const nodes = [...nodesSet].map(s => ({
          id: s, name: name(s), value: received[s] || 0,
          symbolSize: 14 + 38 * Math.sqrt((received[s] || 0) / maxR),
          itemStyle: { color: sel.size ? (sel.has(s) ? color(s) : muted) : css('--s1'), borderColor: css('--surface'), borderWidth: 2,
            opacity: ps.includes(s) ? 1 : 0.5 },
          label: { show: true, position: 'right', distance: 6, color: css('--ink-2'), fontSize: 12,
            textBorderColor: css('--surface'), textBorderWidth: 3 },
        }));
        const links = keep.map(([k, c]) => {
          const [a, b] = k.split('|'), hot = !sel.size || sel.has(a) || sel.has(b);
          return { source: a, target: b, value: c,
            lineStyle: { width: 0.5 + 7 * c / maxE, color: hot ? css('--seq-2') : css('--grid'), opacity: hot ? 0.55 : 0.35, curveness: 0.12 } };
        });
        return {
          option: {
            ...base(),
            tooltip: { ...base().tooltip, formatter: p => p.dataType === 'edge'
              ? tip(full(p.data.value), `mentions between ${name(p.data.source)} and ${name(p.data.target)}`,
                `<br>${esc(name(p.data.source))} → ${esc(name(p.data.target))}: ${full(pair[p.data.source + '>' + p.data.target] || 0)}` +
                `<br>${esc(name(p.data.target))} → ${esc(name(p.data.source))}: ${full(pair[p.data.target + '>' + p.data.source] || 0)}`)
              : tip(full(p.data.value), `times ${p.data.name} is named by others`) },
            series: [{
              type: 'graph', layout: 'force', roam: false, draggable: true, data: nodes, links,
              force: { repulsion: 450, edgeLength: [60, 180], gravity: 0.15, friction: 0.2 },
              emphasis: { focus: 'adjacency', lineStyle: { opacity: 0.9 } }, labelLayout: { hideOverlap: true },
            }],
          },
          onClick: p => { if (p.dataType === 'node' && ps.includes(p.data.id)) toggle(p.data.id); },
          table: { cols: [{ k: 'a', label: 'Hermit' }, { k: 'b', label: 'Hermit' }, { k: 'ab', label: 'A names B', n: true }, { k: 'ba', label: 'B names A', n: true }, { k: 't', label: 'Total', n: true }],
            rows: edges.map(([k, c]) => { const [a, b] = k.split('|'); return { a: name(a), b: name(b), ab: pair[a + '>' + b] || 0, ba: pair[b + '>' + a] || 0, t: c }; }) },
        };
      } });

    const mode = document.createElement('select');
    mode.setAttribute('aria-label', 'Scale');
    mode.innerHTML = `<option value="rate"${state.heat === 'rate' ? ' selected' : ''}>per hour</option><option value="raw"${state.heat === 'raw' ? ' selected' : ''}>total</option>`;
    mode.onchange = () => { state.heat = mode.value; update(); };
    card(el, { title: 'Mention matrix', wide: true, tools: [mode],
      sub: state.heat === 'rate' ? 'Row = whose episodes, column = who gets named · mentions per hour of the row Hermit’s footage'
        : 'Row = whose episodes, column = who gets named · total mentions',
      height: Math.max(260, scope().length * 26 + 110),
      build: () => {
        const rowsH = scope().filter(s => g[s]), cols = ps;
        const data = [];
        let max = 0;
        rowsH.forEach((a, y) => cols.forEach((b, x) => {
          if (a === b) return;
          const c = pair[a + '>' + b] || 0, v = state.heat === 'rate' ? (hrs[a] ? c / hrs[a] : 0) : c;
          max = Math.max(max, v);
          data.push([x, y, +v.toFixed(2), c]);
        }));
        return {
          option: {
            ...base(),
            grid: { left: 8, right: 16, top: 8, bottom: 56, containLabel: true },
            tooltip: { ...base().tooltip, formatter: p => tip(state.heat === 'rate' ? p.data[2].toFixed(2) + ' / hour' : full(p.data[2]),
              `${name(cols[p.data[0]])} named in ${name(rowsH[p.data[1]])}’s episodes`, state.heat === 'rate' ? `<br>${full(p.data[3])} times in total` : '') },
            xAxis: axis({ type: 'category', data: cols.map(name), splitArea: { show: false }, axisLabel: { color: css('--ink-2'), rotate: 45, interval: 0 }, axisLine: { show: false } }),
            yAxis: axis({ type: 'category', data: rowsH.map(name), inverse: true, axisLabel: { color: css('--ink-2') }, axisLine: { show: false } }),
            visualMap: { dimension: 2, min: 0, max: max || 1, calculable: false, orient: 'horizontal', left: 'center', bottom: 0, itemWidth: 10, itemHeight: 140,
              text: ['more', 'fewer'], textStyle: { color: css('--muted') },
              inRange: { color: [css('--seq-0'), css('--seq-1'), css('--seq-2'), css('--seq-3'), css('--seq-4')] } },
            series: [{ type: 'heatmap', data, itemStyle: { borderColor: css('--surface'), borderWidth: 2, borderRadius: 3 }, emphasis: { itemStyle: { borderColor: css('--ink') } } }],
          },
          table: { cols: [{ k: 'a', label: 'In episodes of' }, ...cols.map(b => ({ k: b, label: name(b), n: true }))],
            rows: rowsH.map(a => Object.fromEntries([['a', name(a)], ...cols.map(b => [b, a === b ? null : pair[a + '>' + b] || 0])])) },
        };
      } });

    const teams = seasonTeams();
    if (teams.length) {
      card(el, { title: 'Team talk', wide: true,
        sub: 'Row = whose episodes, column = which team gets named · mentions per hour of the row team’s footage. Hermits on two teams count for both; nobody counts their own name.',
        height: teams.length * 40 + 110,
        build: () => {
          const data = [];
          let max = 0;
          const raw = teams.map(([, a]) => teams.map(([, b]) => sum(a, x => sum(b, y => x === y ? 0 : pair[x + '>' + y] || 0))));
          const th = teams.map(([, a]) => sum(a, x => hrs[x] || 0));
          teams.forEach((_, y) => teams.forEach((_, x) => {
            const v = th[y] ? raw[y][x] / th[y] : 0;
            max = Math.max(max, v);
            data.push([x, y, +v.toFixed(2), raw[y][x]]);
          }));
          const tn = teams.map(([t]) => t);
          return {
            option: {
              ...base(),
              grid: { left: 8, right: 16, top: 8, bottom: 48, containLabel: true },
              tooltip: { ...base().tooltip, formatter: p => tip(p.value[2].toFixed(2) + ' / hour', `${tn[p.value[0]]} named in ${tn[p.value[1]]}’s episodes`, `<br>${full(p.value[3])} times in total`) },
              xAxis: axis({ type: 'category', data: tn, axisLabel: { color: css('--ink-2'), interval: 0 }, axisLine: { show: false } }),
              yAxis: axis({ type: 'category', data: tn, inverse: true, axisLabel: { color: css('--ink-2') }, axisLine: { show: false } }),
              visualMap: { dimension: 2, min: 0, max: max || 1, calculable: false, orient: 'horizontal', left: 'center', bottom: 0, itemWidth: 10, itemHeight: 140,
                text: ['more', 'fewer'], textStyle: { color: css('--muted') },
                inRange: { color: [css('--seq-0'), css('--seq-1'), css('--seq-2'), css('--seq-3'), css('--seq-4')] } },
              series: [{ type: 'heatmap', data: data.map(d => ({ value: d, label: { color: inkOn(cellColor(d[2] / (max || 1))) } })),
                label: { show: true, fontWeight: 600, formatter: p => p.data.value[2].toFixed(1) },
                itemStyle: { borderColor: css('--surface'), borderWidth: 2, borderRadius: 3 }, emphasis: { itemStyle: { borderColor: css('--ink') } } }],
            },
            onClick: p => selectTeam(teams[p.value[1]][1]),
            table: { cols: [{ k: 'a', label: 'In episodes of' }, ...tn.map((t, i) => ({ k: 'c' + i, label: t, n: true, f: v => v.toFixed(2) }))],
              rows: tn.map((t, y) => Object.fromEntries([['a', t], ...tn.map((_, x) => ['c' + x, th[y] ? raw[y][x] / th[y] : 0])])) },
          };
        } });
    }

    const given = mentionsGiven(list);
    card(el, { title: state.sel.length ? `Who ${state.sel.length === 1 ? name(state.sel[0]) + ' talks' : 'they talk'} about` : 'Who gets talked about most',
      sub: state.sel.length ? 'Times each Hermit is named in the selected episodes' : 'Times each Hermit is named in someone else’s episodes',
      build: () => hbar(Object.entries(given).filter(([s]) => H[s]).map(([s, value]) => ({ name: name(s), slug: s, value })), { unit: 'mentions' }) });
    if (state.sel.length) {
      card(el, { title: `Who talks about ${state.sel.length === 1 ? name(state.sel[0]) : 'them'}`,
        sub: 'Times the selected Hermits are named in each other Hermit’s episodes, per hour of that Hermit’s footage',
        build: () => hbar(Object.entries(g).filter(([s]) => !sel.has(s)).map(([s, l]) => {
          const c = sum(state.sel, t => pair[s + '>' + t] || 0);
          return { name: name(s), slug: s, value: hrs[s] ? c / hrs[s] : 0, extra: `<br>${full(c)} times in ${hrs[s].toFixed(0)} hours` };
        }), { unit: 'per hour', decimals: 2 }) });
    }
    card(el, { title: state.sel.length === 1 ? `${name(state.sel[0])}’s top 3 contacts over time` : 'Mentions over time',
      sub: state.sel.length === 1 ? 'Times each is named per week in their episodes' : 'Other Hermits named per week',
      build: () => {
        if (state.sel.length === 1) {
          const top3 = Object.entries(given).filter(([s]) => H[s]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s]) => s);
          return weekly(list, top3.map((t, i) => ({ name: name(t), color: css(`--s${i + 1}`), data: countByWeek(list, v => v.m[t] || 0) })));
        }
        return weekly(list, perHermitSeries(list, l => countByWeek(l, v => sum(Object.values(v.m), x => x)), 'Mentions'));
      } });
    card(el, { title: 'Named in episode titles', sub: 'Episodes whose title names another Hermit — usually a collab or a prank',
      build: () => {
        const c = {};
        for (const v of list) for (const s of v.tm) c[s] = (c[s] || 0) + 1;
        return hbar(Object.entries(c).filter(([s]) => H[s]).map(([s, value]) => ({ name: name(s), slug: s, value })), { unit: 'episodes' });
      } });
  },

  async speech(token) {
    const el = reset('speech-cards', token);
    if (!el) return;
    const m = hermitMetrics(), list = vids();
    card(el, { title: 'Speaking pace', sub: 'Words per minute of footage (silence and music count, so it’s lower than conversation pace)',
      build: () => hbar(pick(m, 'wpm'), { unit: 'words / min', decimals: 0, zoom: true, avg: true }) });
    card(el, { title: 'Vocabulary richness', sub: 'Different words per 100, averaged over every 500-word stretch (fair across episode lengths)',
      build: () => hbar(pick(m, 'richness'), { unit: 'per 100 words', decimals: 1, zoom: true, avg: true }) });
    card(el, { title: 'Filler words', sub: 'Um, uh, like, you know, I mean, basically… per 1,000 words',
      build: () => hbar(pick(m, 'fillers'), { unit: 'per 1,000 words', decimals: 1, avg: true }) });
    card(el, { title: 'Which fillers', sub: 'Most-used filler words in the selected episodes',
      build: () => hbar(Object.entries(lexTotals(list, 'Fillers')).map(([name, value]) => ({ name, value })), { unit: 'times', onSlug: false }) });
    card(el, { title: 'Exclamations', sub: 'Oh no, wow, let’s go… per 1,000 words',
      build: () => hbar(scope().filter(s => m[s]).map(s => {
        const l = list.filter(v => v.h === s), n = sum(Object.values(lexTotals(l, 'Exclamations')), x => x);
        return { name: name(s), slug: s, value: m[s].words ? 1000 * n / m[s].words : 0 };
      }), { unit: 'per 1,000 words', decimals: 1, avg: true }) });
    card(el, { title: 'Laughter', sub: 'Times the captions mark [Laughter], per hour of footage',
      build: () => hbar(pick(m, 'laughs'), { unit: 'per hour', decimals: 1, avg: true }) });

    if (comparing()) {
      card(el, { title: 'Profile', sub: 'Each axis scaled to the highest Hermit this season', height: 400,
        build: () => {
          const keys = [['wpm', 'Pace'], ['richness', 'Vocabulary'], ['fillers', 'Fillers'], ['given', 'Names others'], ['received', 'Gets named'], ['length', 'Episode length']];
          const max = Object.fromEntries(keys.map(([k]) => [k, Math.max(...Object.values(m).map(x => x[k] || 0)) || 1]));
          return {
            option: {
              ...base(), legend: legend(),
              tooltip: { ...base().tooltip, trigger: 'item' },
              radar: { indicator: keys.map(([k, l]) => ({ name: l, max: 1 })), radius: '62%', center: ['50%', '56%'],
                axisName: { color: css('--ink-2') }, splitLine: { lineStyle: { color: css('--grid') } }, splitArea: { show: false }, axisLine: { lineStyle: { color: css('--grid') } } },
              series: [{ type: 'radar', symbolSize: 8, data: state.sel.filter(s => m[s]).map(s => ({
                name: name(s), value: keys.map(([k]) => +((m[s][k] || 0) / max[k]).toFixed(3)),
                lineStyle: { width: 2, color: color(s) }, itemStyle: { color: color(s) }, areaStyle: { color: color(s), opacity: 0.08 } })),
                tooltip: { formatter: p => `<div class="hovercard"><b>${esc(p.name)}</b>` + keys.map(([k, l]) => `<br>${esc(l)}: ${esc(full(m[state.sel.find(s => name(s) === p.name)][k]))}`).join('') + '</div>' } }],
            },
            table: { cols: [{ k: 'name', label: 'Hermit' }, ...keys.map(([k, l]) => ({ k, label: l, n: true }))], rows: state.sel.filter(s => m[s]).map(s => m[s]) },
          };
        } });
    }

    card(el, { title: 'How they open and close an episode', wide: true, sub: 'The most common first and last few words of each Hermit’s episodes',
      build: () => {
        const rows = scope().filter(s => m[s]).map(s => {
          const l = list.filter(v => v.h === s);
          const top = key => {
            const c = {};
            for (const v of l) { const p = v[key].split(' '); const g = (key === 'open' ? p.slice(0, 5) : p.slice(-5)).join(' '); if (g) c[g] = (c[g] || 0) + 1; }
            const best = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
            return best ? [best[0], best[1]] : ['', 0];
          };
          const [o, on] = top('open'), [c, cn] = top('close');
          return { hermit: name(s), open: `“${o}…”`, on, close: `“…${c}”`, cn, n: l.length };
        });
        return { tableOnly: true, table: { cols: [{ k: 'hermit', label: 'Hermit' }, { k: 'open', label: 'Usual opening' }, { k: 'on', label: 'Episodes', n: true },
          { k: 'close', label: 'Usual sign-off' }, { k: 'cn', label: 'Episodes', n: true }], rows } };
      } });
  },

  async videos(token) {
    const el = reset('videos-cards', token);
    if (!el) return;
    const list = vids();
    const groups = comparing() ? state.sel.map(s => [s, list.filter(v => v.h === s)]) : [[null, list]];
    const scatter = (xf, xType, xName, yf, yName, yType = 'value') => ({
      option: {
        ...base(), legend: groups.length > 1 ? legend() : undefined,
        grid: { ...base().grid, top: groups.length > 1 ? 32 : 16 },
        tooltip: { ...base().tooltip, trigger: 'item', formatter: p => { const v = p.data.v; return tip(full(yf(v)) + ' ' + yName, `· ${H[v.h].short}`, `<br>${esc(v.t)}<br><span class="muted">${esc(v.d)} · ${Math.round(v.dur / 60)} min</span>`); } },
        xAxis: axis({ type: xType, name: xName, nameLocation: 'middle', nameGap: 28, nameTextStyle: { color: css('--muted') }, splitLine: { show: xType !== 'time', lineStyle: { color: css('--grid') } } }),
        yAxis: axis({ type: yType, name: yName, nameTextStyle: { color: css('--muted'), align: 'left' }, axisLabel: { color: css('--muted'), formatter: v => fmt(v) } }),
        series: groups.map(([s, l]) => ({
          type: 'scatter', name: s ? name(s) : 'Episodes', symbolSize: 8,
          itemStyle: { color: s ? color(s) : css('--s1'), opacity: 0.75, borderColor: css('--surface'), borderWidth: 2 },
          data: l.filter(v => yf(v) != null && xf(v) != null && (yType !== 'log' || yf(v) > 0)).map(v => ({ value: [xf(v), yf(v)], v })),
        })),
      },
      onClick: p => openEpisode(p.data.v.id),
    });
    card(el, { title: 'Views by upload date', sub: 'Each dot is an episode · click one for its page · log scale · recent episodes are still collecting views', build: () => list.length ? scatter(v => v.d, 'time', '', v => v.v, 'views', 'log') : null });
    card(el, { title: 'Views by episode length', sub: 'Do longer episodes get more views? · log scale', build: () => list.length ? scatter(v => Math.round(v.dur / 60), 'value', 'minutes', v => v.v, 'views', 'log') : null });
    card(el, { title: 'Episode length by episode number', sub: 'Minutes, as the season goes on', build: () => list.length ? scatter(v => v.ep, 'value', 'episode', v => Math.round(v.dur / 60), 'minutes') : null });
    card(el, { title: 'Likes per 1,000 views', sub: 'How much viewers liked each episode, relative to its reach',
      build: () => list.length ? scatter(v => v.d, 'time', '', v => v.v && v.l != null ? +(1000 * v.l / v.v).toFixed(1) : null, 'likes / 1k views') : null });
    card(el, { title: 'Every episode', wide: true, sub: 'Click a column to sort; a title opens that episode’s stats',
      build: () => ({ tableOnly: true, table: {
        cols: [{ k: 'hermit', label: 'Hermit' }, { k: 'd', label: 'Date' }, { k: 't', label: 'Title', link: r => epHref(r.id), internal: true },
          { k: 'watch', label: '', link: r => ytUrl(r.id), f: () => 'Watch' },
          { k: 'min', label: 'Minutes', n: true }, { k: 'v', label: 'Views', n: true }, { k: 'l', label: 'Likes', n: true }, { k: 'cm', label: 'Comments', n: true },
          { k: 'w', label: 'Words', n: true }, { k: 'wpm', label: 'Words/min', n: true }, { k: 'mentions', label: 'Hermits named', n: true }, { k: 'top', label: 'Most named' }],
        rows: [...list].sort((a, b) => (b.d || '').localeCompare(a.d || '')).map(v => {
          const top = Object.entries(v.m).sort((a, b) => b[1] - a[1])[0];
          return { ...v, hermit: H[v.h].short, min: Math.round(v.dur / 60), mentions: sum(Object.values(v.m), x => x), top: top ? `${name(top[0])} (${top[1]})` : '' };
        }) } }) });
  },

  async search(token) {
    const input = $('#search-input');
    input.value = state.search;
    const phrases = state.search.split(',').map(p => tokenize(p)).filter(p => p.length).slice(0, 3);
    $('#search-examples').hidden = !!phrases.length;
    searchBusy(null);
    if (!phrases.length) return catchphraseBoard(token);
    const list = vids(), slugs = [...new Set(list.map(v => v.h))];
    let loaded = 0;
    const progress = () => searchBusy(loaded < slugs.length
      ? `Loading transcripts… ${loaded} of ${slugs.length} ${people()}` : `Searching ${full(list.length)} episodes…`);
    progress();
    let docs;
    try {
      docs = Object.fromEntries(await Promise.all(slugs.map(async s => {
        const d = await transcripts(s);
        loaded++;
        if (token === renderToken) progress();
        return [s, d];
      })));
      await new Promise(r => setTimeout(r, 20));    // let the status paint before the synchronous count
    } catch (e) {
      if (token === renderToken) searchBusy(null);
      throw e;
    }
    const el = reset('search-cards', token);
    if (!el) return;
    searchBusy(null);
    const labels = phrases.map(p => p.join(' '));
    const hits = [];       // {v, start, text, p}
    const perVideo = phrases.map(() => new Map());
    for (const v of list) {
      for (const [start, text] of docs[v.h]?.[v.id] || []) {
        const toks = tokenize(text);
        phrases.forEach((p, i) => {
          const n = countPhrase(toks, p);
          if (n) { perVideo[i].set(v, (perVideo[i].get(v) || 0) + n); hits.push({ v, start, text, i }); }
        });
      }
    }
    const pcolor = i => css(`--s${i + 1}`);
    card(el, { title: 'Times said, by Hermit', sub: phrases.length > 1 ? labels.map(l => `“${l}”`).join(' · ') : `“${labels[0]}” · per hour of footage in the table`,
      build: () => {
        const g = byHermit(list);
        const rows = Object.keys(g).map(s => {
          const r = { name: name(s), slug: s, hours: hours(sum(g[s], v => v.dur)) };
          phrases.forEach((_, i) => { r['p' + i] = sum(g[s], v => perVideo[i].get(v) || 0); r['r' + i] = r.hours ? r['p' + i] / r.hours : 0; });
          return r;
        }).filter(r => phrases.some((_, i) => r['p' + i])).sort((a, b) => b.p0 - a.p0 || (b.p1 || 0) - (a.p1 || 0));
        if (!rows.length) return { empty: 'Not said in the selected episodes.' };
        return {
          height: Math.max(160, rows.length * (phrases.length > 1 ? 34 : 24) + 40),
          option: {
            ...base(), legend: phrases.length > 1 ? legend() : undefined,
            grid: { ...base().grid, top: phrases.length > 1 ? 32 : 16 },
            tooltip: { ...base().tooltip, trigger: 'axis', axisPointer: { type: 'shadow' },
              formatter: ps => `<div class="hovercard">${esc(ps[0].name)}` + ps.map(p => `<br><b>${full(p.value)}</b> “${esc(p.seriesName)}”`).join('') + '</div>' },
            xAxis: axis({ type: 'value', axisLabel: { show: false }, splitLine: { show: false } }),
            yAxis: axis({ type: 'category', inverse: true, data: rows.map(r => r.name), axisLine: { show: false }, axisLabel: { color: css('--ink-2') } }),
            series: phrases.map((_, i) => ({ type: 'bar', name: labels[i], barMaxWidth: 12, barGap: '20%',
              itemStyle: { color: phrases.length > 1 ? pcolor(i) : css('--s1'), borderRadius: [0, 4, 4, 0] },
              label: { show: true, position: 'right', color: css('--ink-2'), fontSize: 12 },
              data: rows.map(r => r['p' + i]) })),
          },
          onClick: p => toggle(rows[p.dataIndex].slug),
          table: { cols: [{ k: 'name', label: 'Hermit' }, ...phrases.flatMap((_, i) => [{ k: 'p' + i, label: `“${labels[i]}”`, n: true }, { k: 'r' + i, label: 'per hour', n: true, f: v => v.toFixed(2) }])], rows },
        };
      } });
    card(el, { title: 'Over the season', sub: 'Times said per week',
      build: () => weekly(list, phrases.map((_, i) => ({ name: labels[i], color: phrases.length > 1 ? pcolor(i) : css('--s1'), data: countByWeek([...perVideo[i].keys()], v => perVideo[i].get(v)) })), { type: phrases.length > 1 ? 'line' : 'bar' }) });
    card(el, { title: 'Every moment', wide: true, sub: `${full(hits.length)} moments${hits.length > 400 ? ' · newest 400 shown' : ''} · click a time to jump straight to it`,
      build: () => {
        if (!hits.length) return { empty: 'Not said in the selected episodes.' };
        hits.sort((a, b) => (b.v.d || '').localeCompare(a.v.d || '') || a.start - b.start);
        const ul = document.createElement('ul');
        ul.className = 'kwic';
        for (const h of hits.slice(0, 400)) {
          const li = document.createElement('li');
          const meta = document.createElement('div');
          meta.className = 'meta';
          const a = document.createElement('a');
          a.href = ytUrl(h.v.id, h.start);
          a.target = '_blank'; a.rel = 'noopener';
          a.textContent = clock(h.start);
          const ep = document.createElement('a');
          ep.href = epHref(h.v.id); ep.textContent = h.v.t; ep.className = 'ep-link';
          meta.append(`${H[h.v.h].short} · ${h.v.d} · `, a, ' · ', ep);
          const p = document.createElement('div');
          p.innerHTML = highlight(excerpt(h.text, phrases[h.i]), phrases[h.i]);
          li.append(meta, p);
          ul.appendChild(li);
        }
        return { node: ul };
      } });
  },
};

/* ---------------------------------------------------------------- what's new */

const byNewest = (a, b) => (b.d || '').localeCompare(a.d || '') || (b.ts || 0) - (a.ts || 0);

/** Episodes since this browser's last visit (or, with none, the season's last week of uploads), pairs of
    Hermits talking about each other for the first time in that stretch, and the words of the week. */
function whatsNew() {
  const list = vids(), wk = META.week?.[state.coll];
  const fresh = VISIT.prev ? list.filter(v => added(v) > VISIT.prev) : [];
  let title, sub, eps, from;
  if (fresh.length) {
    eps = fresh; from = new Date(VISIT.prev * 1000).toISOString().slice(0, 10);
    title = 'New since your last visit';
    sub = `${fresh.length} episode${fresh.length === 1 ? '' : 's'} added since ${longDate(VISIT.prev)}`;
  } else if (wk) {
    eps = list.filter(v => v.d && v.d >= wk.from); from = wk.from;
    title = Date.now() - Date.parse(wk.to + 'T00:00:00Z') < 8 * 86400e3 ? 'This week' : 'The last week of uploads';
    sub = `${longDate(wk.from)} – ${longDate(wk.to)}` + (VISIT.prev ? ' · nothing new since your last visit' : '');
  } else return null;
  eps = [...eps].sort(byNewest);

  // First episode of the season where one Hermit names another (twice or more: one could be a mishearing).
  const first = {};
  for (const v of [...collVids()].sort((a, b) => byNewest(b, a)))
    for (const [k, c] of Object.entries(v.m)) if (H[k] && c >= 2) first[v.h + '>' + k] ??= v;
  const sc = new Set(scope());
  const firsts = Object.entries(first).filter(([k, v]) => v.d && v.d >= from && (sc.has(v.h) || sc.has(k.split('>')[1])))
    .sort((a, b) => byNewest(a[1], b[1])).slice(0, 8);

  const face = s => H[s]?.avatar ? `<img src="${esc(H[s].avatar)}" alt="" loading="lazy">` : '<span class="dot"></span>';
  const epList = eps.length ? `<ul class="news-list">${eps.slice(0, 8).map(v => `<li>${face(v.h)}<div><a href="${esc(epHref(v.id))}">${esc(v.t)}</a>
      <div class="muted small">${esc(name(v.h))} · ${esc(longDate(v.d))}</div></div></li>`).join('')}</ul>
      ${eps.length > 8 ? `<a class="small" href="${esc(hashFor({ tab: 'videos', ep: null }))}">and ${eps.length - 8} more in Videos</a>` : ''}`
    : `<p class="muted small">No episodes from the selected ${people()} in this stretch.</p>`;
  const pairList = firsts.length ? `<ul class="news-list">${firsts.map(([k, v]) => {
      const b = k.split('>')[1];
      return `<li>${face(v.h)}<div>${esc(name(v.h))} talks about ${esc(name(b))} <span class="muted">(${v.m[b]} times)</span>
        <div class="muted small"><a href="${esc(epHref(v.id))}">${esc(longDate(v.d))}</a></div></div></li>`;
    }).join('')}</ul>` : '<p class="muted small">No new pairs in this stretch.</p>';
  const ww = wk?.words?.length ? `<div class="phrases">${wk.words.map(([w, , c]) => `<a class="w" href="${esc(searchHref(w))}" title="said ${c} times that week">${esc(w)}</a>`).join('')}</div>
      <p class="muted small">Said far more from ${esc(longDate(wk.from))} to ${esc(longDate(wk.to))} than earlier in the season, by all ${people()} · click one to search it</p>`
    : '<p class="muted small">Not enough that week to say.</p>';
  return { title, sub, html: `<div class="news">
    <div><h4>Episodes</h4>${epList}</div>
    <div><h4>Talking about each other for the first time this season</h4>${pairList}</div>
    <div><h4>Words of the week</h4>${ww}</div></div>` };
}

/* ---------------------------------------------------------------- share cards */

const loadImage = src => !src ? Promise.resolve(null) : new Promise(res => {
  const img = new Image();
  img.onload = () => res(img); img.onerror = () => res(null); img.src = src;
});

/** Shorten text with an ellipsis until it fits maxW on the canvas. */
function fitText(ctx, s, maxW) {
  if (ctx.measureText(s).width <= maxW) return s;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s.trimEnd() + '…';
}

/** A 1200×630 picture of a Hermit's season (the size link previews use), with Download and Share buttons. */
function shareCard(slug, doc, img) {
  const m = hermitMetrics()[slug], all = collVids();
  const top = c => { const e = Object.entries(c).filter(([s, n]) => H[s] && s !== slug && n > 0).sort((a, b) => b[1] - a[1])[0]; return e ? `${name(e[0])} (${full(e[1])} times)` : null; };
  const by = {};
  for (const v of all) if (v.h !== slug && v.m[slug]) by[v.h] = (by[v.h] || 0) + v.m[slug];
  const facts = [['Signature word', doc?.x?.[0]?.[0]], ['Catchphrase', doc?.p?.[0] ? `“${doc.p[0][0]}”` : null],
    ['Talks about most', top(mentionsGiven(all.filter(v => v.h === slug)))], ['Most talked about by', top(by)]].filter(f => f[1]);
  const stats = [[fmt(m.videos), 'episodes'], [fmt(Math.round(m.hours)), 'hours of footage'], [fmt(m.words), 'words spoken'], [m.wpm ? m.wpm.toFixed(0) : '—', 'words a minute']];

  const W = 1200, HT = 630, F = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = HT; cv.className = 'share-canvas';
  cv.setAttribute('role', 'img');
  cv.setAttribute('aria-label', `${fullName(slug)}, ${state.coll}: ` + [...stats.map(([v, k]) => `${v} ${k}`), ...facts.map(([k, v]) => `${k} ${v}`)].join(', '));
  const x = cv.getContext('2d');
  x.fillStyle = css('--surface'); x.fillRect(0, 0, W, HT);
  x.fillStyle = color(slug); x.fillRect(0, 0, W, 12);
  if (img) {
    x.save(); x.beginPath(); x.arc(64 + 68, 64 + 68, 68, 0, 2 * Math.PI); x.clip(); x.drawImage(img, 64, 64, 136, 136); x.restore();
  }
  const text = (s, px, weight, ink, tx, ty, maxW) => { x.font = `${weight} ${px}px ${F}`; x.fillStyle = css(ink); x.fillText(maxW ? fitText(x, s, maxW) : s, tx, ty); };
  const left = img ? 232 : 64;
  text(fullName(slug), 64, 700, '--ink', left, 132, W - left - 64);
  text(hermitcraft() ? `Hermitcraft ${state.coll}` : `${season().series}: ${state.coll}`, 30, 400, '--ink-2', left, 180);
  stats.forEach(([v, k], i) => { text(v, 56, 650, '--ink', 64 + i * 272, 306); text(k, 24, 400, '--ink-2', 64 + i * 272, 342, 250); });
  x.fillStyle = css('--grid'); x.fillRect(64, 378, W - 128, 2);
  facts.forEach(([k, v], i) => {
    const fx = 64 + (i % 2) * 560, fy = 428 + Math.floor(i / 2) * 92;
    text(k, 22, 400, '--muted', fx, fy); text(v, 34, 600, '--ink', fx, fy + 40, 520);
  });
  text((META.site || location.origin).replace(/^https?:\/\//, ''), 22, 600, '--accent', 64, 598);
  x.textAlign = 'right';
  text('From every episode’s captions · unofficial fan project', 20, 400, '--muted', W - 64, 598);

  const file = `hermit-stats-${slug}-${state.coll.toLowerCase().replace(/\W+/g, '-')}.png`;
  const blob = () => new Promise(res => cv.toBlob(res, 'image/png'));
  const wrap = document.createElement('figure');
  wrap.className = 'share';
  const bar = document.createElement('figcaption');
  const dl = document.createElement('button');
  dl.type = 'button'; dl.className = 'ghost'; dl.textContent = 'Download PNG';
  dl.onclick = async () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await blob()); a.download = file; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  bar.appendChild(dl);
  if (navigator.canShare?.({ files: [new File([''], file, { type: 'image/png' })] })) {
    const sh = document.createElement('button');
    sh.type = 'button'; sh.className = 'ghost'; sh.textContent = 'Share…';
    sh.onclick = async () => {
      const f = new File([await blob()], file, { type: 'image/png' });
      navigator.share({ files: [f], title: `${fullName(slug)} · Hermit Stats`, text: location.href }).catch(() => { /* cancelled */ });
    };
    bar.appendChild(sh);
  }
  wrap.append(cv, bar);
  return wrap;
}

/* ---------------------------------------------------------------- one episode */

const TAB_NAMES = { overview: 'Overview', search: 'Search', words: 'Words', interactions: 'Interactions', speech: 'Speech', videos: 'Videos', status: 'Status' };

async function episodePage(token) {
  const v = VIDEOS.find(x => x.id === state.ep);
  const [tr, ex] = await Promise.all([transcripts(v.h), episodes(v.h)]);
  const el = reset('episode-cards', token);
  if (!el) return;
  const coll = v.c.includes(state.coll) ? state.coll : v.c[0];
  const mine = VIDEOS.filter(x => x.h === v.h && x.c.includes(coll)).sort((a, b) => (a.d || '').localeCompare(b.d || '') || (a.ts || 0) - (b.ts || 0));
  const i = mine.indexOf(v), prev = mine[i - 1], next = mine[i + 1];
  const chunks = tr[v.id] || [], extra = ex[v.id] || { mt: [], x: [] };
  const h = H[v.h], mins = v.dur / 60;
  const src = { 'auto-captions': 'auto-captions', 'manual-captions': 'creator’s captions', whisper: 'Whisper transcript' }[v.src] || v.src;

  const head = $('#episode-head');
  head.innerHTML = `<div class="ep-nav"><button type="button" class="ghost" id="ep-back">← ${esc(TAB_NAMES[state.tab] || 'Back')}</button>
      <span class="ep-step">${prev ? `<a href="${esc(epHref(prev.id))}" title="${esc(prev.t)}">← Previous</a>` : ''}
      ${next ? `<a href="${esc(epHref(next.id))}" title="${esc(next.t)}">Next →</a>` : ''}</span></div>
    <div class="ep-title">${h.avatar ? `<img src="${esc(h.avatar)}" alt="">` : ''}
      <div><h2>${esc(v.t)}</h2>
      <p class="muted small">${esc(h.short)} · ${esc(coll)}${v.ep ? ` · episode ${v.ep}` : ''} · ${esc(longDate(v.d))} · ${Math.round(mins)} min · ${esc(src)}</p></div>
      <a class="watch" href="${esc(ytUrl(v.id))}" target="_blank" rel="noopener">Watch on YouTube</a></div>`;
  $('#ep-back').onclick = () => { state.ep = null; update(); };

  // Each number next to this Hermit's usual for the season.
  const avg = f => { const xs = mine.map(f).filter(x => x != null && isFinite(x)); return xs.length ? sum(xs, x => x) / xs.length : null; };
  const named = x => sum(Object.values(x.m), c => c);
  const likes = x => x.v && x.l != null ? 1000 * x.l / x.v : null;
  const tiles = [
    ['Words spoken', x => x.w, fmt], ['Words per minute', x => x.wpm, n => n.toFixed(0)],
    ['Vocabulary richness', x => x.r != null ? 100 * x.r : null, n => n.toFixed(1)], ['Minutes', x => x.dur / 60, n => n.toFixed(0)],
    [words4('Hermits named'), named, fmt], ['Views', x => x.v, fmt], ['Likes per 1k views', likes, n => n.toFixed(1)],
  ];
  $('#episode-tiles').innerHTML = tiles.map(([k, f, show]) => {
    const val = f(v), usual = avg(f);
    let cmp = '';
    if (val != null && usual) {
      const d = 100 * (val - usual) / usual;
      cmp = Math.abs(d) < 5 ? 'about usual' : `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(0)}% vs usual`;
    }
    return `<div class="tile"><div class="v">${esc(val == null ? '—' : show(val))}</div><div class="k">${esc(k)}</div>${cmp ? `<div class="cmp small muted" title="${esc(h.short)}’s average this season: ${esc(usual == null ? '—' : show(usual))}">${esc(cmp)}</div>` : ''}</div>`;
  }).join('');

  card(el, { title: 'Who’s named, and when', wide: true, sub: 'Each dot is a time another Hermit is named · click one to watch from there',
    build: () => {
      const counts = {};
      for (const [, s] of extra.mt) if (H[s]) counts[s] = (counts[s] || 0) + 1;
      const cats = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
      if (!cats.length) return { empty: words4('No other Hermit is named in this episode.') };
      const pts = extra.mt.filter(([, s]) => H[s]);
      return {
        height: Math.max(160, cats.length * 30 + 60),
        option: {
          ...base(),
          grid: { ...base().grid, right: 24, bottom: 24 },
          tooltip: { ...base().tooltip, trigger: 'item', formatter: p => tip(name(p.data.s), `at ${clock(p.data.t)}`) },
          xAxis: axis({ type: 'value', min: 0, max: Math.ceil(mins), name: 'minutes', nameLocation: 'middle', nameGap: 26, nameTextStyle: { color: css('--muted') } }),
          yAxis: axis({ type: 'category', inverse: true, data: cats.map(s => `${name(s)} (${counts[s]})`), axisLine: { show: false }, axisLabel: { color: css('--ink-2') }, splitLine: { show: true, lineStyle: { color: css('--grid') } } }),
          series: [{ type: 'scatter', symbolSize: 10, itemStyle: { color: css('--s1'), opacity: 0.8, borderColor: css('--surface'), borderWidth: 1.5 },
            data: pts.map(([t, s]) => ({ value: [+(t / 60).toFixed(2), cats.indexOf(s)], t, s })) }],
        },
        onClick: p => window.open(ytUrl(v.id, p.data.t), '_blank', 'noopener'),
        table: { cols: [{ k: 'name', label: 'Hermit' }, { k: 'n', label: 'Times named', n: true }, { k: 'first', label: 'First at' }, { k: 'last', label: 'Last at' }],
          rows: cats.map(s => { const ts = pts.filter(p => p[1] === s).map(p => p[0]); return { name: name(s), n: counts[s], first: clock(ts[0]), last: clock(ts[ts.length - 1]) }; }) },
      };
    } });

  card(el, { title: 'Pace through the episode', sub: `Words per minute, two minutes at a time · dashed line: ${h.short}’s average this season`,
    build: () => {
      const bins = [];
      for (const [t, text] of chunks) { const b = Math.floor(t / 120); bins[b] = (bins[b] || 0) + tokenize(text).length; }
      if (!bins.length) return null;
      const data = [...bins].map((n, b) => [b * 2, +((n || 0) / 2).toFixed(0)]);
      const usual = avg(x => x.wpm);
      return {
        option: {
          ...base(),
          tooltip: { ...base().tooltip, trigger: 'axis', formatter: ps => tip(ps[0].value[1] + ' words / min', `from ${ps[0].value[0]}:00`) },
          xAxis: axis({ type: 'value', min: 0, name: 'minutes', nameLocation: 'middle', nameGap: 26, nameTextStyle: { color: css('--muted') } }),
          yAxis: axis({ type: 'value' }),
          series: [{ type: 'line', data, showSymbol: false, step: 'end', lineStyle: { width: 2, color: color(v.h) }, itemStyle: { color: color(v.h) },
            markLine: usual ? { symbol: 'none', silent: true, data: [{ yAxis: +usual.toFixed(0) }], lineStyle: { color: css('--ink-2'), type: 'dashed', width: 1 },
              label: { formatter: `avg ${usual.toFixed(0)}`, color: css('--ink-2'), fontSize: 11 } } : undefined }],
        },
        table: { cols: [{ k: 'from', label: 'From' }, { k: 'wpm', label: 'Words / min', n: true }], rows: data.map(([m, w]) => ({ from: `${m}:00`, wpm: w })) },
      };
    } });

  card(el, { title: 'Words that stand out', sub: `Said far more here than in ${h.short}’s other ${coll} episodes · click one to search it`,
    build: () => {
      if (!extra.x.length) return { empty: 'Nothing stands out from their other episodes.' };
      return { html: `<div class="phrases">${extra.x.map(([w, , c]) => `<a class="w" href="${esc(searchHref(w, [v.h]))}" title="said ${c} times">${esc(w)}</a>`).join('')}</div>`,
        table: { cols: [{ k: 'w', label: 'Word' }, { k: 'c', label: 'Times said', n: true }, { k: 'z', label: 'Distinctiveness (z)', n: true }],
          rows: extra.x.map(([w, z, c]) => ({ w, z, c })) } };
    } });

  card(el, { title: 'Transcript', wide: true, sub: `${src[0].toUpperCase() + src.slice(1)}, in 20-second stretches · click a time to watch from there`,
    build: () => {
      if (!chunks.length) return null;
      const ul = document.createElement('ul');
      ul.className = 'kwic transcript';
      for (const [t, text] of chunks) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = ytUrl(v.id, t); a.target = '_blank'; a.rel = 'noopener'; a.textContent = clock(t); a.className = 'meta';
        li.append(a, ' ', text);
        ul.appendChild(li);
      }
      return { node: ul };
    } });
}

/* ---------------------------------------------------------------- status */

/** How the nightly job is doing: when the site was built, the last sync, and videos still without a transcript. */
TABS.status = async function (token) {
  const st = await statusData();
  const el = reset('status-cards', token);
  if (!el) return;
  const run = st.sync, now = Date.now() / 1000, DAY = 86400;
  const problems = [];
  if (now - st.generated > 1.5 * DAY) problems.push(`the site was last built ${ago(st.generated)}`);
  if (!run) problems.push('no sync run has been recorded yet');
  else {
    if (now - run.finished > 1.5 * DAY) problems.push(`the last sync finished ${ago(run.finished)}`);
    if (run.bot_check) problems.push('YouTube bot-checked the last sync, so it stopped early');
    if (run.failed) problems.push(`${run.failed} video${run.failed === 1 ? '' : 's'} failed in the last sync`);
  }
  $('#status-head').innerHTML = `<div class="health ${problems.length ? 'warn' : 'ok'}" role="status"><b>${problems.length ? 'Needs a look' : 'All good'}</b>
    <span>${problems.length ? esc(problems.join('; ')) + '.' : 'Built and synced in the last day, nothing failed.'}</span></div>`;

  const why = {};
  for (const w of st.waiting) why[w.why] = (why[w.why] || 0) + 1;
  const tiles = [
    ['Site built', ago(st.generated)], ['Last sync finished', run ? ago(run.finished) : '—'],
    ['Last sync took', run ? `${Math.max(1, Math.round((run.finished - run.started) / 60))} min` : '—'],
    ['Transcribed last sync', run?.transcribed != null ? `${full(run.transcribed)} of ${full(run.todo)}` : '—'],
    ['Via Whisper last sync', run ? full(run.whispered) : '—'], ['Waiting for a transcript', full(st.waiting.length)],
    ['Waiting for Whisper', full(why['Waiting for Whisper'] || 0)], ['Episodes in the stats', full(sum(Object.values(st.counts).flatMap(Object.values), c => sum(Object.values(c), n => n)))],
  ];
  $('#status-tiles').innerHTML = tiles.map(([k, v]) => `<div class="tile"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div></div>`).join('');

  card(el, { title: 'Why videos are waiting', sub: 'Videos found in a season playlist that have no transcript yet',
    build: () => st.waiting.length ? hbar(Object.entries(why).map(([n, value]) => ({ name: n, value })), { unit: 'videos', onSlug: false, labelWidth: 220 })
      : { empty: 'Every video found has a transcript.' } });
  card(el, { title: 'Where transcripts come from', sub: 'Every episode in the stats, by season',
    build: () => {
      const label = { 'auto-captions': 'YouTube auto-captions', 'manual-captions': 'Creator’s captions', whisper: 'Whisper (no captions)' };
      const rows = META.collections.map(c => {
        const r = { name: c };
        for (const k of Object.keys(label)) r[k] = sum(Object.values(st.counts[c] || {}), n => n[k] || 0);
        return r;
      }).filter(r => Object.keys(label).some(k => r[k]));
      return { tableOnly: true, table: { cols: [{ k: 'name', label: 'Season' }, ...Object.entries(label).map(([k, l]) => ({ k, label: l, n: true }))], rows } };
    } });
  card(el, { title: 'Waiting for a transcript', wide: true, sub: 'Newest first · the nightly run retries these',
    build: () => st.waiting.length ? { tableOnly: true, table: {
      cols: [{ k: 'hermit', label: 'Hermit' }, { k: 'season', label: 'Season' }, { k: 'd', label: 'Uploaded' },
        { k: 't', label: 'Title', link: r => ytUrl(r.id) }, { k: 'why', label: 'Why' }, { k: 'since', label: 'Since' }],
      rows: st.waiting.map(w => ({ ...w, hermit: name(w.h), season: w.c.join(', '), t: w.t || w.id, since: w.at ? ago(w.at) : '' })) } } : null });
  card(el, { title: 'Episodes by Hermit', wide: true, sub: 'Transcribed episodes in the stats and videos still waiting, per season',
    build: () => {
      const rows = [];
      for (const c of META.collections) for (const h of META.hermits) {
        const n = st.counts[c]?.[h.slug] || {}, have = sum(Object.values(n), x => x), wait = st.waiting.filter(w => w.h === h.slug && w.c.includes(c)).length;
        if (have || wait) rows.push({ season: c, hermit: h.short, have, wait, whisper: n.whisper || 0 });
      }
      return { tableOnly: true, table: { cols: [{ k: 'season', label: 'Season' }, { k: 'hermit', label: 'Hermit' }, { k: 'have', label: 'In the stats', n: true },
        { k: 'wait', label: 'Waiting', n: true }, { k: 'whisper', label: 'Via Whisper', n: true }], rows } };
    } });
};

/** With nothing searched: each Hermit's top catchphrase, ranked by how many of their episodes it's in. */
async function catchphraseBoard(token) {
  const slugs = scope();
  const docs = await Promise.all(slugs.map(words));
  const el = reset('search-cards', token);
  if (!el) return;
  const eps = byHermit(collVids());
  const items = slugs.map((s, i) => {
    const p = docs[i]?.[state.coll]?.p?.[0], n = eps[s]?.length || 0;
    return p && n ? { name: `${name(s)}: “${p[0]}”`, slug: s, phrase: p[0], value: 100 * p[3] / n,
      extra: `<br>in ${p[3]} of ${n} episodes · said ${full(p[2])} times` } : null;
  }).filter(Boolean);
  card(el, { title: 'Catchphrase leaderboard', wide: true,
    sub: 'Each Hermit’s most characteristic phrase and the share of their episodes it’s in · click one to search it',
    build: () => {
      const r = hbar(items, { unit: '% of episodes', decimals: 0, onSlug: false, top: 40, labelWidth: 300 });
      if (!r) return { empty: 'No catchphrases for this selection yet.' };
      const sorted = [...items].sort((a, b) => b.value - a.value);
      r.onClick = p => { location.hash = searchHref(sorted[p.dataIndex].phrase, []); };
      r.table = { cols: [{ k: 'hermit', label: 'Hermit' }, { k: 'phrase', label: 'Catchphrase', link: x => searchHref(x.phrase, []), internal: true },
        { k: 'value', label: '% of episodes', n: true, f: v => v.toFixed(0) }], rows: sorted.map(x => ({ ...x, hermit: name(x.slug) })) };
      return r;
    } });
}

function searchBusy(msg) {
  const status = $('#search-status'), btn = $('#search-form button');
  status.hidden = !msg;
  status.lastElementChild.textContent = msg || '';
  btn.disabled = !!msg;
  btn.textContent = msg ? 'Searching…' : 'Search';
}

function boxplot(slugs, f, unit) {
  const g = byHermit(vids());
  const rows = slugs.filter(s => g[s]?.length).map(s => {
    const xs = g[s].map(f).filter(x => x > 0).sort((a, b) => a - b);
    const q = p => { const i = (xs.length - 1) * p, lo = Math.floor(i); return xs[lo] + (xs[Math.ceil(i)] - xs[lo]) * (i - lo); };
    return { slug: s, name: name(s), min: xs[0], q1: q(0.25), med: q(0.5), q3: q(0.75), max: xs[xs.length - 1] };
  }).sort((a, b) => b.med - a.med);
  if (!rows.length) return null;
  return {
    height: Math.max(160, rows.length * 24 + 40),
    option: {
      ...base(),
      tooltip: { ...base().tooltip, trigger: 'item', formatter: p => { const r = rows[p.dataIndex]; return tip(r.med.toFixed(0) + ' ' + unit, `median · ${r.name}`, `<br>middle half ${r.q1.toFixed(0)}–${r.q3.toFixed(0)}<br>range ${r.min.toFixed(0)}–${r.max.toFixed(0)}`); } },
      xAxis: axis({ type: 'value', name: unit, nameTextStyle: { color: css('--muted') } }),
      yAxis: axis({ type: 'category', inverse: true, data: rows.map(r => r.name), axisLine: { show: false }, axisLabel: { color: css('--ink-2') } }),
      series: [{ type: 'boxplot', boxWidth: [6, 12], data: rows.map(r => ({ value: [r.min, r.q1, r.med, r.q3, r.max],
        itemStyle: { color: css('--mark'), borderColor: color(r.slug), borderWidth: 1.5 } })) }],
    },
    onClick: p => toggle(rows[p.dataIndex].slug),
    table: { cols: [{ k: 'name', label: 'Hermit' }, { k: 'min', label: 'Shortest', n: true }, { k: 'q1', label: '25%', n: true }, { k: 'med', label: 'Median', n: true },
      { k: 'q3', label: '75%', n: true }, { k: 'max', label: 'Longest', n: true }], rows },
  };
}

/* ---------------------------------------------------------------- text (mirrors hermitstats/text.py) */

function tokenize(s) {
  return (s.toLowerCase().replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/’/g, "'").match(/[a-z0-9]+(?:'[a-z]+)?/g)) || [];
}
function countPhrase(toks, p) {
  let n = 0;
  outer: for (let i = 0; i + p.length <= toks.length; i++) {
    for (let j = 0; j < p.length; j++) if (toks[i + j] !== p[j]) continue outer;
    n++;
  }
  return n;
}
function excerpt(text, p, around = 140) {      // the chunk trimmed to the first match, ± ~25 words
  const i = text.toLowerCase().indexOf(p[0]);
  if (i < 0 || text.length <= around * 2) return text;
  const a = Math.max(0, text.lastIndexOf(' ', Math.max(0, i - around))), b = text.indexOf(' ', Math.min(text.length, i + around));
  return (a > 0 ? '… ' : '') + text.slice(a, b < 0 ? undefined : b).trim() + (b > 0 ? ' …' : '');
}
function highlight(text, p) {
  const words = p.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join("[^a-z0-9']+");
  const re = new RegExp(`(^|[^a-z0-9'])(${words})(?![a-z0-9'])`, 'gi');
  let out = '', last = 0, m;
  while ((m = re.exec(text))) {
    const s = m.index + m[1].length;
    out += esc(text.slice(last, s)) + '<mark>' + esc(m[2]) + '</mark>';
    last = s + m[2].length;
  }
  return out + esc(text.slice(last));
}

/* ---------------------------------------------------------------- boot */

function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
}

/** Remember when this browser last looked. Reloads within a few hours count as the same visit, so what's
    new doesn't vanish on refresh. */
function readVisit() {
  try {
    const now = Math.floor(Date.now() / 1000), v = JSON.parse(localStorage.getItem('visit') || '{}');
    VISIT.prev = v.seen && now - v.seen < 6 * 3600 ? v.prev ?? null : v.seen ?? null;
    localStorage.setItem('visit', JSON.stringify({ seen: now, prev: VISIT.prev }));
  } catch { /* storage blocked: everything counts as this week */ }
}

async function boot() {
  try { applyTheme(localStorage.getItem('theme')); } catch { /* storage blocked */ }
  readVisit();
  META = await json('data/meta.json');
  for (const h of META.hermits) H[h.slug] = h;
  state.coll = META.collections[0];
  readHash();
  await loadSeason();
  $('#updated').textContent = `Updated ${new Date(META.generated * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.`;

  $('#collection').onchange = async e => {
    state.coll = e.target.value; state.ep = null;
    await loadSeason();
    state.sel = state.sel.filter(s => present().includes(s));
    update();
  };
  for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => { state.tab = b.dataset.tab; state.ep = null; if (scrollY > $('#bar-anchor').offsetTop) scrollTo({ top: 0 }); update(); };
  $('#search-form').onsubmit = e => { e.preventDefault(); state.search = $('#search-input').value.trim(); update(); };
  $('#theme').onclick = () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    const t = dark ? 'light' : 'dark';
    applyTheme(t);
    try { localStorage.setItem('theme', t); } catch { /* storage blocked */ }
    update();
  };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => update());
  addEventListener('hashchange', async () => {     // pasted / shared links, episode links, Back
    const was = [state.ep, state.tab];
    readHash();
    await loadSeason();
    if (state.ep !== was[0] || state.tab !== was[1]) scrollTo({ top: 0 });
    update();
  });
  let rt;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => charts.forEach(c => c.resize()), 120); });
  // Once scrolled into the charts, fold the filters into one line so the tabs stay in reach.
  // Different thresholds for folding and unfolding, so the bar's change in height can't make it flicker.
  const bar = $('#bar');
  addEventListener('scroll', () => {
    const y = scrollY, top = $('#bar-anchor').offsetTop;
    if (y > top + 160) bar.classList.add('compact'); else if (y < top + 8) bar.classList.remove('compact');
  }, { passive: true });
  $('#sel-edit').onclick = () => scrollTo({ top: 0, behavior: 'smooth' });
  for (const b of document.querySelectorAll('.examples button')) b.onclick = () => { state.search = b.textContent; update(); };
  update();
}

boot().catch(e => { console.error(e); $('#summary').textContent = 'Could not load the stats.'; });
