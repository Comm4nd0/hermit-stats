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

const state = { tab: 'overview', coll: null, sel: [], lex: 'Mobs', heat: 'rate', search: '' };
let META, VIDEOS, H = {};
const cache = { words: {}, trans: {} };
const charts = [];

/* ---------------------------------------------------------------- data access */

async function json(path) {
  const r = await fetch(path, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}
const words = slug => cache.words[slug] ??= json(`data/words/${slug}.json`);
const transcripts = slug => cache.trans[slug] ??= json(`data/transcripts/${slug}.json`);

const collVids = () => VIDEOS.filter(v => v.c.includes(state.coll));
const present = () => [...new Set(collVids().map(v => v.h))].sort((a, b) => H[a].short.localeCompare(H[b].short));
const scope = () => state.sel.length ? state.sel : present();           // hermits the charts cover
const vids = () => { const s = new Set(scope()); return collVids().filter(v => s.has(v.h)); };
const comparing = () => state.sel.length >= 1 && state.sel.length <= MAX_COMPARE;
const color = slug => { const i = state.sel.indexOf(slug); return i >= 0 && i < MAX_COMPARE ? css(`--s${i + 1}`) : css('--s1'); };
const byHermit = list => { const m = {}; for (const v of list) (m[v.h] ??= []).push(v); return m; };
const name = slug => H[slug]?.short ?? slug;

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
  axisLabel: { color: css('--muted') }, splitLine: { lineStyle: { color: css('--grid') } }, ...extra,
});
const tip = (value, label, extra = '') => `<div class="hovercard"><b>${esc(value)}</b> ${esc(label)}${extra}</div>`;
const legend = () => ({ top: 0, left: 0, icon: 'roundRect', itemWidth: 14, itemHeight: 4, textStyle: { color: css('--ink-2') } });

/** A card: title, subtitle, optional tools, a chart (or custom HTML) and a table view of the same numbers. */
function card(container, spec) {
  const el = document.createElement('section');
  el.className = 'card' + (spec.wide ? ' wide' : '');
  el.innerHTML = `<header><div><h3></h3><p class="sub"></p></div><div class="tools"></div></header>
    <div class="body"></div><div class="tablewrap" hidden></div>`;
  $('h3', el).textContent = spec.title;
  $('.sub', el).textContent = spec.sub || '';
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
    btn.setAttribute('aria-pressed', 'false');
    const wrap = $('.tablewrap', el);
    btn.onclick = () => {
      const on = wrap.hidden;
      if (on && !wrap.firstChild) wrap.appendChild(table(result.table));
      wrap.hidden = !on;
      if (result.option) body.hidden = on;
      btn.setAttribute('aria-pressed', String(on));
    };
    tools.appendChild(btn);
    if (result.tableOnly) { btn.click(); btn.remove(); }
  }
}

/** Sortable table. cols: [{k, label, n (numeric), f (format), link (row => url)}] */
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
      th.textContent = c.label + (sortK === c.k ? (dir < 0 ? ' ↓' : ' ↑') : '');
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
          a.href = c.link(r); a.target = '_blank'; a.rel = 'noopener'; a.textContent = val;
          td.appendChild(a);
        } else td.textContent = val;
      }
    }
  };
  draw();
  return t;
}

/** Ranked horizontal bars. items: [{name, value, slug?, extra?}] */
function hbar(items, { unit = '', top = 25, decimals, onSlug = true, valueLabel = true } = {}) {
  items = items.filter(i => i.value > 0).sort((a, b) => b.value - a.value).slice(0, top);
  if (!items.length) return null;
  const show = v => decimals != null ? v.toFixed(decimals) : fmt(v);
  return {
    height: Math.max(160, items.length * 24 + 24),
    option: {
      ...base(),
      tooltip: { ...base().tooltip, trigger: 'item', formatter: p => tip(show(p.value) + (unit ? ' ' + unit : ''), p.name, items[p.dataIndex].extra || '') },
      xAxis: axis({ type: 'value', axisLabel: { show: false }, splitLine: { show: false } }),
      yAxis: axis({ type: 'category', inverse: true, data: items.map(i => i.name), axisLine: { show: false },
        axisLabel: { color: css('--ink-2'), width: 150, overflow: 'truncate' } }),
      series: [{
        type: 'bar', barMaxWidth: 14, barCategoryGap: '30%',
        data: items.map(i => ({ value: i.value, itemStyle: { color: i.slug ? color(i.slug) : css('--s1'), borderRadius: [0, 4, 4, 0] } })),
        label: { show: valueLabel, position: 'right', color: css('--ink-2'), fontSize: 12, formatter: p => show(p.value) },
        emphasis: { itemStyle: { opacity: 0.85 } },
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
  update();
}

function readHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  if (q.get('tab')) state.tab = q.get('tab');
  if (q.get('season') && META.collections.includes(q.get('season'))) state.coll = q.get('season');
  state.sel = (q.get('h') || '').split(',').filter(s => H[s]);
  state.search = q.get('q') || '';
}
function writeHash() {
  const q = new URLSearchParams();
  q.set('tab', state.tab);
  if (state.coll !== META.collections[0]) q.set('season', state.coll);
  if (state.sel.length) q.set('h', state.sel.join(','));
  if (state.tab === 'search' && state.search) q.set('q', state.search);
  history.replaceState(null, '', '#' + q.toString());
}

function drawFilters() {
  const sel = $('#collection');
  sel.innerHTML = META.collections.map(c => `<option${c === state.coll ? ' selected' : ''}>${esc(c)}</option>`).join('');
  const box = $('#hermits');
  box.innerHTML = '';
  const all = document.createElement('button');
  all.type = 'button'; all.className = 'chip all'; all.textContent = 'All Hermits';
  all.setAttribute('aria-pressed', String(!state.sel.length));
  all.onclick = () => { state.sel = []; update(); };
  box.appendChild(all);
  for (const slug of present()) {
    const h = H[slug];
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip'; b.title = h.name;
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
  $('#sel-hint').textContent = !state.sel.length ? '— all of them; pick up to 3 to compare'
    : state.sel.length > MAX_COMPARE ? `— ${state.sel.length} selected, shown together` : '— click again to deselect';
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === state.tab));
  for (const p of document.querySelectorAll('[data-panel]')) p.classList.toggle('on', p.dataset.panel === state.tab);
}

let renderToken = 0;
async function update() {
  writeHash();
  drawFilters();
  const token = ++renderToken;
  $('#main').classList.add('loading');
  try {
    await TABS[state.tab]?.(token);
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
  return { n, w: top(w, 150), b: top(b, 25), t: top(t, 25), docs };
}

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
      ['Episodes', fmt(list.length)], ['Hours of footage', fmt(hours(secs))], ['Words spoken', fmt(w)],
      ['Words per minute', secs ? (w / (secs / 60)).toFixed(0) : '—'], ['Views', fmt(sum(list, v => v.v))],
      ['Likes', fmt(sum(list, v => v.l))], ['Times another Hermit is named', fmt(mentions)],
    ];
    const el = reset('overview-cards', token);
    if (!el) return;
    tiles.innerHTML = t.map(([k, v]) => `<div class="tile"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div></div>`).join('');

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
    card(el, { title: 'Top two-word phrases', build: () => hbar(agg.b.map(([name, value]) => ({ name, value })), { unit: 'times', onSlug: false, top: 20 }) });
    card(el, { title: 'Top three-word phrases', build: () => hbar(agg.t.map(([name, value]) => ({ name, value })), { unit: 'times', onSlug: false, top: 20 }) });

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
      sub: 'Line thickness = how often two Hermits name each other on camera; circle size = how often a Hermit is named. Drag to rearrange, click to select.',
      build: () => {
        const nodesSet = new Set(ps);
        for (const k of Object.keys(pair)) { const b = k.split('>')[1]; if (H[b]) nodesSet.add(b); }
        const received = {};
        for (const [k, c] of Object.entries(pair)) { const b = k.split('>')[1]; received[b] = (received[b] || 0) + c; }
        const und = {};
        for (const [k, c] of Object.entries(pair)) { const [a, b] = k.split('>'); const key = [a, b].sort().join('|'); und[key] = (und[key] || 0) + c; }
        const edges = Object.entries(und).sort((x, y) => y[1] - x[1]);
        const maxE = edges[0]?.[1] || 1, maxR = Math.max(1, ...Object.values(received));
        const keep = edges.filter(([k, c], i) => i < 90 || k.split('|').some(s => sel.has(s)));
        const muted = css('--muted');
        const nodes = [...nodesSet].map(s => ({
          id: s, name: name(s), value: received[s] || 0,
          symbolSize: 14 + 38 * Math.sqrt((received[s] || 0) / maxR),
          itemStyle: { color: sel.size ? (sel.has(s) ? color(s) : muted) : css('--s1'), borderColor: css('--surface'), borderWidth: 2,
            opacity: ps.includes(s) ? 1 : 0.5 },
          label: { show: true, position: 'right', color: css('--ink-2'), fontSize: 12 },
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
              type: 'graph', layout: 'force', roam: true, draggable: true, data: nodes, links,
              force: { repulsion: 420, edgeLength: [60, 220], gravity: 0.08, friction: 0.2 },
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
      build: () => hbar(pick(m, 'wpm'), { unit: 'words / min', decimals: 0 }) });
    card(el, { title: 'Vocabulary richness', sub: 'Different words per 100, averaged over every 500-word stretch (fair across episode lengths)',
      build: () => hbar(pick(m, 'richness'), { unit: 'per 100 words', decimals: 1 }) });
    card(el, { title: 'Filler words', sub: 'Um, uh, like, you know, I mean, basically… per 1,000 words',
      build: () => hbar(pick(m, 'fillers'), { unit: 'per 1,000 words', decimals: 1 }) });
    card(el, { title: 'Which fillers', sub: 'Most-used filler words in the selected episodes',
      build: () => hbar(Object.entries(lexTotals(list, 'Fillers')).map(([name, value]) => ({ name, value })), { unit: 'times', onSlug: false }) });
    card(el, { title: 'Exclamations', sub: 'Oh no, wow, let’s go… per 1,000 words',
      build: () => hbar(scope().filter(s => m[s]).map(s => {
        const l = list.filter(v => v.h === s), n = sum(Object.values(lexTotals(l, 'Exclamations')), x => x);
        return { name: name(s), slug: s, value: m[s].words ? 1000 * n / m[s].words : 0 };
      }), { unit: 'per 1,000 words', decimals: 1 }) });
    card(el, { title: 'Laughter', sub: 'Times the captions mark [Laughter], per hour of footage',
      build: () => hbar(pick(m, 'laughs'), { unit: 'per hour', decimals: 1 }) });

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
    const scatter = (xf, xType, xName, yf, yName) => ({
      option: {
        ...base(), legend: groups.length > 1 ? legend() : undefined,
        grid: { ...base().grid, top: groups.length > 1 ? 32 : 16 },
        tooltip: { ...base().tooltip, trigger: 'item', formatter: p => { const v = p.data.v; return tip(full(yf(v)) + ' ' + yName, `· ${H[v.h].short}`, `<br>${esc(v.t)}<br><span class="muted">${esc(v.d)} · ${Math.round(v.dur / 60)} min</span>`); } },
        xAxis: axis({ type: xType, name: xName, nameLocation: 'middle', nameGap: 28, nameTextStyle: { color: css('--muted') }, splitLine: { show: xType !== 'time', lineStyle: { color: css('--grid') } } }),
        yAxis: axis({ type: 'value', name: yName, nameTextStyle: { color: css('--muted'), align: 'left' }, axisLabel: { color: css('--muted'), formatter: v => fmt(v) } }),
        series: groups.map(([s, l]) => ({
          type: 'scatter', name: s ? name(s) : 'Episodes', symbolSize: 8,
          itemStyle: { color: s ? color(s) : css('--s1'), opacity: 0.75, borderColor: css('--surface'), borderWidth: 2 },
          data: l.filter(v => yf(v) != null && xf(v) != null).map(v => ({ value: [xf(v), yf(v)], v })),
        })),
      },
      onClick: p => window.open(`https://www.youtube.com/watch?v=${p.data.v.id}`, '_blank', 'noopener'),
    });
    card(el, { title: 'Views by upload date', sub: 'Each dot is an episode · click to watch', build: () => list.length ? scatter(v => v.d, 'time', '', v => v.v, 'views') : null });
    card(el, { title: 'Views by episode length', sub: 'Do longer episodes get more views?', build: () => list.length ? scatter(v => Math.round(v.dur / 60), 'value', 'minutes', v => v.v, 'views') : null });
    card(el, { title: 'Episode length by episode number', sub: 'Minutes, as the season goes on', build: () => list.length ? scatter(v => v.ep, 'value', 'episode', v => Math.round(v.dur / 60), 'minutes') : null });
    card(el, { title: 'Likes per 1,000 views', sub: 'How much viewers liked each episode, relative to its reach',
      build: () => list.length ? scatter(v => v.d, 'time', '', v => v.v && v.l != null ? +(1000 * v.l / v.v).toFixed(1) : null, 'likes / 1k views') : null });
    card(el, { title: 'Every episode', wide: true, sub: 'Click a column to sort; titles open the video',
      build: () => ({ tableOnly: true, table: {
        cols: [{ k: 'hermit', label: 'Hermit' }, { k: 'd', label: 'Date' }, { k: 't', label: 'Title', link: r => `https://www.youtube.com/watch?v=${r.id}` },
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
    if (!phrases.length) { reset('search-cards', token); return; }
    const list = vids(), slugs = [...new Set(list.map(v => v.h))];
    const docs = Object.fromEntries(await Promise.all(slugs.map(async s => [s, await transcripts(s)])));
    const el = reset('search-cards', token);
    if (!el) return;
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
          a.href = `https://www.youtube.com/watch?v=${h.v.id}&t=${Math.max(0, h.start - 2)}s`;
          a.target = '_blank'; a.rel = 'noopener';
          a.textContent = `${Math.floor(h.start / 60)}:${String(h.start % 60).padStart(2, '0')}`;
          meta.append(`${H[h.v.h].short} · ${h.v.d} · `, a, ` · ${h.v.t}`);
          const p = document.createElement('div');
          p.innerHTML = highlight(excerpt(h.text, phrases[h.i]), phrases[h.i]);
          li.append(meta, p);
          ul.appendChild(li);
        }
        return { node: ul };
      } });
  },
};

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

async function boot() {
  try { applyTheme(localStorage.getItem('theme')); } catch { /* storage blocked */ }
  [META, VIDEOS] = await Promise.all([json('data/meta.json'), json('data/videos.json')]);
  for (const h of META.hermits) H[h.slug] = h;
  state.coll = META.collections.find(c => VIDEOS.some(v => v.c.includes(c))) || META.collections[0];
  readHash();
  const n = VIDEOS.length, hrs = hours(sum(VIDEOS, v => v.dur));
  $('#summary').textContent = `${full(n)} episodes · ${full(Math.round(hrs))} hours · ${present().length} Hermits`;
  $('#updated').textContent = `Updated ${new Date(META.generated * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.`;

  $('#collection').onchange = e => { state.coll = e.target.value; state.sel = state.sel.filter(s => present().includes(s)); update(); };
  for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => { state.tab = b.dataset.tab; update(); };
  $('#search-form').onsubmit = e => { e.preventDefault(); state.search = $('#search-input').value.trim(); update(); };
  $('#theme').onclick = () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    const t = dark ? 'light' : 'dark';
    applyTheme(t);
    try { localStorage.setItem('theme', t); } catch { /* storage blocked */ }
    update();
  };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => update());
  addEventListener('hashchange', () => { readHash(); update(); });     // pasted / shared links
  let rt;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => charts.forEach(c => c.resize()), 120); });
  update();
}

boot().catch(e => { console.error(e); $('#summary').textContent = 'Could not load the stats.'; });
