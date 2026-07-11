import { readBenchResults, clearBenchResults, deleteBenchResult, recordKey } from './bench.js';
import { toast } from './kernelsu.js';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function clearNode(n) { while (n.firstChild) n.removeChild(n.firstChild); }

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function connClass(conn) {
  if (conn === 'Wi-Fi') return 'conn-wifi';
  if (conn === '5G') return 'conn-5g';
  if (conn === '4G') return 'conn-4g';
  return 'conn-other';
}

function metric(value, unit, label) {
  const m = el('div', 'metric');
  const v = el('div', 'm-val', value);
  v.appendChild(el('span', 'm-unit', ' ' + unit));
  m.appendChild(v);
  m.appendChild(el('div', 'm-label', label));
  return m;
}

function resultCard(r, onDelete) {
  const card = el('div', 'res-card');

  const head = el('div', 'res-head');
  head.appendChild(el('span', 'conn-badge ' + connClass(r.conn), r.conn || '—'));
  head.appendChild(el('span', 'res-date', fmtDate(r.ts)));
  if (r.grade && r.grade !== 'n/a') {
    head.appendChild(el('span', 'res-grade grade-' + r.grade, r.grade));
  }
  const del = el('button', 'res-del', '✕');
  del.setAttribute('aria-label', 'Delete this result');
  del.addEventListener('click', () => onDelete(r));
  head.appendChild(del);
  card.appendChild(head);

  const metrics = el('div', 'res-metrics');
  metrics.appendChild(metric(r.down != null ? String(r.down) : '—', 'Mbps ↓', 'download'));
  metrics.appendChild(metric(r.idle != null ? String(r.idle) : '—', 'ms', 'idle ping'));
  metrics.appendChild(metric(r.loaded != null ? String(r.loaded) : '—', 'ms', 'under load'));
  card.appendChild(metrics);

  const foot = el('div', 'res-foot');
  const chips = el('div', 'res-chips');
  if (r.profile) chips.appendChild(el('span', 'chip chip-profile', '★ ' + r.profile));
  if (r.cc) chips.appendChild(el('span', 'chip', r.cc));
  if (r.qdisc) chips.appendChild(el('span', 'chip', r.qdisc));
  if (r.signal) chips.appendChild(el('span', 'chip chip-dim', r.signal + ' dBm'));
  foot.appendChild(chips);
  if (r.bloat != null) foot.appendChild(el('span', 'res-bloat', '+' + r.bloat + ' ms bloat'));
  card.appendChild(foot);

  return card;
}

async function render() {
  const list = document.getElementById('results-list');
  if (!list) return;
  clearNode(list);

  const results = await readBenchResults();
  if (!results.length) {
    list.appendChild(el('div', 'results-empty',
      'No results yet. Run a Bufferbloat test in the Tools tab — each run is saved here with its settings.'));
    return;
  }

  results.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  results.forEach(r => list.appendChild(resultCard(r, onDeleteCard)));
}

async function onDeleteCard(r) {
  await deleteBenchResult(recordKey(r));
  toast('Result deleted');
  await render();
}

export async function initResults() {
  await render();

  const clearBtn = document.getElementById('results-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      await clearBenchResults();
      toast('Results cleared');
      await render();
    });
  }
}
