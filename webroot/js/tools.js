import { exec, toast } from './kernelsu.js';
import router_state from './router.js';
import { addLog } from './logs.js';
import { getBenchContext, saveBenchResult } from './bench.js';

/* ---------- safe DOM helpers (no innerHTML) ---------- */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function row(k, v) {
  const r = el('div', 'row');
  r.appendChild(el('span', 'k', k));
  r.appendChild(el('span', 'v', v));
  return r;
}
function note(text) {
  const n = el('div', 'row', text);
  n.style.marginTop = '6px';
  n.style.color = 'var(--text-secondary)';
  n.style.fontSize = '.8rem';
  return n;
}
function clearNode(n) { while (n.firstChild) n.removeChild(n.firstChild); }
function spinner() {
  const s = el('span', 'spinner');
  s.setAttribute('aria-hidden', 'true');
  return s;
}

/* ---------- profiles ---------- */
const PROFILES = {
  gaming:   { name: 'Gaming',    cc: ['bbr3', 'bbr', 'cubic'], qdisc: 'cake',     sysctl: ['net.ipv4.tcp_notsent_lowat=16384', 'net.ipv4.tcp_autocorking=0'] },
  stream:   { name: 'Streaming', cc: ['bbr3', 'bbr', 'cubic'], qdisc: 'fq',       sysctl: ['net.ipv4.tcp_autocorking=1'] },
  balanced: { name: 'Balanced',  cc: ['bbr3', 'bbr', 'cubic'], qdisc: 'fq_codel', sysctl: [] },
  battery:  { name: 'Battery',   cc: ['cubic', 'bbr'],         qdisc: 'fq_codel', sysctl: ['net.ipv4.tcp_autocorking=1'] },
};

async function pickCc(pref) {
  try {
    const { stdout } = await exec('cat /proc/sys/net/ipv4/tcp_available_congestion_control');
    const have = stdout.trim().split(/\s+/);
    return pref.find(a => have.includes(a)) || 'cubic';
  } catch { return 'cubic'; }
}

async function applyProfile(key, btn) {
  const P = PROFILES[key];
  const md = router_state.moduleInformation.moduleDir;
  const box = document.getElementById('profile-result');
  btn.classList.add('busy');
  try {
    const cc = await pickCc(P.cc);
    const q = P.qdisc;

    const { stdout: ifRaw } = await exec(`ip route get 192.0.2.1 2>/dev/null | awk '/dev/ {for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}'`);
    const ifn = ifRaw.trim();
    const isWifi = /^wlan|^tun/.test(ifn);
    const isCell = /rmnet|ccmni/.test(ifn);
    const netLabel = isWifi ? 'Wi-Fi' : (isCell ? 'Cellular' : (ifn || 'this network'));

    if (isWifi) {
      await exec(`rm -f ${md}/wlan_*`);
      await exec(`touch ${md}/wlan_${cc}_${q} && chmod 644 ${md}/wlan_${cc}_${q}`);
      router_state.settingsPageParams.wlanAlgo = cc;
      router_state.settingsPageParams.wlanQdisc = q;
    } else if (isCell) {
      await exec(`rm -f ${md}/rmnet_data_*`);
      await exec(`touch ${md}/rmnet_data_${cc}_${q} && chmod 644 ${md}/rmnet_data_${cc}_${q}`);
      router_state.settingsPageParams.rmnetAlgo = cc;
      router_state.settingsPageParams.rmnetQdisc = q;
    } else {
      await exec(`rm -f ${md}/wlan_* ${md}/rmnet_data_*`);
      await exec(`touch ${md}/wlan_${cc}_${q} ${md}/rmnet_data_${cc}_${q} && chmod 644 ${md}/wlan_${cc}_${q} ${md}/rmnet_data_${cc}_${q}`);
    }

    await exec(`echo ${cc} > /proc/sys/net/ipv4/tcp_congestion_control 2>/dev/null`);
    for (const sc of P.sysctl) await exec(`sysctl -w ${sc} 2>/dev/null`);
    await exec(`echo "${P.name}" > ${md}/active_profile && chmod 644 ${md}/active_profile`);
    await exec(`touch ${md}/force_apply && chmod 644 ${md}/force_apply`);

    document.querySelectorAll('.profile-btn').forEach(b => b.classList.remove('active-profile'));
    btn.classList.add('active-profile');
    clearNode(box);
    box.appendChild(row('Profile', P.name));
    box.appendChild(row('Applied to', netLabel));
    box.appendChild(row('Congestion control', cc));
    box.appendChild(row('Queue (qdisc)', q));
    box.appendChild(note('Applied to ' + netLabel + ' only. The other network keeps its setting.'));
    box.classList.remove('hidden');
    toast(`${P.name} applied to ${netLabel}`);
    addLog(`Profile ${P.name} -> ${netLabel}: cc=${cc}, qdisc=${q}`);
    // remember it so a bufferbloat run can tag its Results record with this profile
    router_state.activeProfile = { name: P.name, cc, qdisc: q };
  } catch (e) {
    console.error(e); toast('Error applying profile.'); addLog('Error applying profile.');
  } finally {
    btn.classList.remove('busy');
  }
}

/* ---------- bufferbloat test ---------- */
// Download load is spread across several fast public mirrors in parallel. A single
// provider (e.g. OVH) can cap ~40-50 Mbps and under-saturate a fast link, which
// under-reads BOTH download and bufferbloat; hitting distinct servers/paths at
// once reaches the real link ceiling (verified on-device: 1 OVH stream and 8 OVH
// streams both ~43 Mbps, but 3 mirrors in parallel reached the true ~49 Mbps).
// Cloudflare's __down 403s bare curl, so it's excluded.
const LOAD_URLS = [
  'https://proof.ovh.net/files/100Mb.dat',    // OVH — Roubaix (FR)
  'https://ash-speed.hetzner.com/100MB.bin',  // Hetzner — Ashburn (US)
  'https://cachefly.cachefly.net/100mb.test', // Cachefly — global anycast CDN
];
const STREAMS_PER = 3;                            // streams per mirror
const STREAMS = LOAD_URLS.length * STREAMS_PER;   // total parallel streams (9)
// Throughput is the SUM of each stream's own curl speed (test traffic only, not
// the whole interface). Below this the link wasn't saturated, so grading would
// be meaningless — report "inconclusive" instead.
const SAT_FLOOR_MBPS = 5;

function grade(inc) {
  if (inc <= 30)  return 'A';
  if (inc <= 60)  return 'B';
  if (inc <= 100) return 'C';
  if (inc <= 200) return 'D';
  return 'F';
}

async function stopLoad() {
  await exec(`rm -rf /data/local/tmp/.bloat_res; for h in proof.ovh.net hetzner.com cachefly.net; do pkill -f "$h" 2>/dev/null; done; true`);
}

// The whole measurement runs as one root shell script so the parallel download
// streams and the loaded-latency ping share a process (needed for `wait`), and
// so throughput is summed straight from each stream's curl report. Streams are
// spread STREAMS_PER across each mirror in LOAD_URLS to reach the real link
// ceiling. (JS interpolates ${urlList}/${STREAMS_PER}; shell keeps $VAR only.)
function bloatScript(streamsPer = STREAMS_PER, maxTime = 12, idleN = 10, loadN = 15) {
  const urlList = LOAD_URLS.map(u => `"${u}"`).join(' ');
  return `
IDLE=$(ping -c ${idleN} -i 0.3 -W 2 1.1.1.1 2>/dev/null | awk -F'/' 'END{print $5}')
D=/data/local/tmp/.bloat_res
rm -rf "$D"; mkdir -p "$D"
i=0
for URL in ${urlList}; do
  s=1
  while [ "$s" -le ${streamsPer} ]; do
    i=$((i+1))
    ( curl -s -o /dev/null -w '%{speed_download} %{http_code}\\n' --max-time ${maxTime} "$URL" > "$D/$i" 2>/dev/null ) &
    s=$((s+1))
  done
done
sleep 2
LOADED=$(ping -c ${loadN} -i 0.3 -W 2 1.1.1.1 2>/dev/null | awk -F'/' 'END{print $5}')
wait
STATS=$(awk '{s+=$1} ($2==200||$2==206){c++} END{printf "%.0f %d", s, c+0}' "$D"/* 2>/dev/null)
set -- $STATS
SUM=$1; OK=$2
rm -rf "$D"
echo "RESULT idle=$IDLE loaded=$LOADED sumbps=$SUM okstreams=$OK"
`;
}

async function runBloat(btn) {
  const out = document.getElementById('bloat-out');

  // Button -> spinner + "Running…" (obvious the test has started)
  const btnLabel = btn.textContent;
  btn.classList.add('busy');
  clearNode(btn);
  btn.appendChild(spinner());
  btn.appendChild(el('span', null, 'Running…'));

  // Result box -> spinner + "Running test…"
  out.classList.remove('hidden');
  clearNode(out);
  const status = el('div', 'run-status');
  status.appendChild(spinner());
  status.appendChild(el('span', null, 'Running test… (~15 s)'));
  out.appendChild(status);

  // The ksu.exec bridge blocks the JS thread for the whole test, so nothing
  // would repaint until it finishes. Yield (paint frame + macrotask) so the
  // spinner / "Running…" state is actually drawn before we call it.
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise(r => setTimeout(r, 30));

  try {
    const { stdout } = await exec(bloatScript());
    const m = stdout.match(/RESULT idle=(\S*) loaded=(\S*) sumbps=(\S*) okstreams=(\S*)/);
    if (!m) { clearNode(out); out.appendChild(row('Test error.', '')); return; }

    const idle = parseFloat(m[1]);
    const loaded = parseFloat(m[2]);
    const sumbps = parseFloat(m[3]);
    const ok = parseInt(m[4], 10) || 0;

    if (isNaN(idle))   { clearNode(out); out.appendChild(row('No internet / no reply.', '')); return; }
    if (isNaN(loaded)) { clearNode(out); out.appendChild(row('No reply under load.', '')); return; }

    const mbps = isNaN(sumbps) ? 0 : (sumbps * 8 / 1e6);
    const loadWorked = ok >= 1 && mbps >= SAT_FLOOR_MBPS;
    const inc = Math.max(0, loaded - idle);
    const g = loadWorked ? grade(inc) : null;

    clearNode(out);
    if (g) {
      const gw = el('div', 'grade-wrap');
      gw.appendChild(el('div', 'grade grade-' + g, g));
      out.appendChild(gw);
    }
    out.appendChild(row('Idle latency', idle.toFixed(1) + ' ms'));
    out.appendChild(row('Under load', loaded.toFixed(1) + ' ms'));
    out.appendChild(row('Bufferbloat', '+' + inc.toFixed(1) + ' ms'));
    out.appendChild(row('Download speed', mbps >= 0.1 ? mbps.toFixed(1) + ' Mbps' : '-'));
    if (!loadWorked) {
      out.appendChild(note(`Link only reached ${mbps.toFixed(1)} Mbps (${ok}/${STREAMS} streams) — not enough to saturate it, so no grade is shown. Check signal/data and try again.`));
    } else {
      out.appendChild(note('A = little lag under load, F = heavy bufferbloat. fq / cake / fq_codel help most.'));
    }
    addLog(`Bufferbloat: idle=${idle.toFixed(1)} load=${loaded.toFixed(1)} inc=${inc.toFixed(1)} dl=${mbps.toFixed(1)}Mbps ok=${ok} grade=${g || 'n/a'}`);

    // Record the run (with the settings it ran under) for the Results tab.
    try {
      const ctx = await getBenchContext();
      // Feed the measured link rate + idle RTT to "smart cake": set_qdisc reads
      // cake_hint_<wlan|rmnet> and shapes cake to it (bandwidth+rtt) on next apply.
      if (loadWorked && (ctx.iftype === 'wifi' || ctx.iftype === 'cell')) {
        const md = router_state.moduleInformation.moduleDir;
        const pfx = ctx.iftype === 'wifi' ? 'wlan' : 'rmnet';
        const bwHint = Math.max(2, Math.round(mbps));
        const rttHint = Math.max(5, Math.round(idle));
        await exec(`echo "${bwHint} ${rttHint}" > ${md}/cake_hint_${pfx} && chmod 644 ${md}/cake_hint_${pfx}`);
      }
      // Tag with the applied profile only while it's still the active one. Matched
      // on cc alone (live qdisc reads are unreliable — htb-wrapping/timing); a
      // manual Settings apply clears activeProfile so the tag drops immediately.
      const ap = router_state.activeProfile;
      const profile = (ap && ap.cc === ctx.cc) ? ap.name : '';
      await saveBenchResult({
        ts: Date.now(),
        conn: ctx.conn, iface: ctx.iface, signal: ctx.signal,
        cc: ctx.cc, qdisc: ctx.qdisc, profile: profile,
        down: Number(mbps.toFixed(1)),
        idle: Number(idle.toFixed(1)),
        loaded: Number(loaded.toFixed(1)),
        bloat: Number(inc.toFixed(1)),
        grade: g || 'n/a'
      });
      out.appendChild(note('Saved to Results ✓'));
    } catch (e) { console.error('save bench failed', e); }
  } catch (e) {
    console.error(e);
    clearNode(out); out.appendChild(row('Test error.', ''));
    await stopLoad();
  } finally {
    btn.classList.remove('busy');
    clearNode(btn);
    btn.textContent = btnLabel;
  }
}

/* ---------- live BBR telemetry ---------- */
// Rolling model-state graph of the busiest bbr connection, sampled from
// `ss -tin` once per second (plus /sys/kernel/debug/tcp_bbr3/sockets when the
// 0002 kernel patch is present). Self-stops when the user leaves this page.
const TELE = { running: false, bw: [], rtt: [], max: 90, lastTick: 0, period: 1000, prev: null, prevT: 0 };
const BBR_MODES = ['STARTUP', 'DRAIN', 'PROBE_BW', 'PROBE_RTT'];

function toMbps(s) {
  const m = String(s).match(/([\d.]+)\s*([GMK]?)bps/);
  if (!m) return 0;
  const v = parseFloat(m[1]);
  // ss rates are bits/s; scale to Mbps. The base (plain `bps`, no prefix) is
  // /1e6 — the case that was missing, which made sub-Kbps sockets read as huge.
  const mult = m[2] === 'G' ? 1e3 : m[2] === 'M' ? 1 : m[2] === 'K' ? 1e-3 : 1e-6;
  return v * mult;
}

function teleParse(stdout) {
  const [ssPart, dbgPart] = stdout.split('---DBGFS---');
  const all = [];   // every established conn: {key, rx, tx} for throughput deltas
  let best = null, retrans = 0, bbrCount = 0, curKey = null;
  for (const line of (ssPart || '').split('\n')) {
    // `ss -tin` prints two lines per socket: an address row (Recv-Q Send-Q Local
    // Peer) then a tab-indented info row. Pair them so byte counters can be keyed.
    const addr = line.match(/^\d+\s+\d+\s+(\S+:\d+)\s+(\S+:\d+)/);
    if (addr) { curKey = addr[1] + '>' + addr[2]; continue; }
    if (!/^\s/.test(line)) continue;   // skip the column header row
    const rx = parseInt((line.match(/bytes_received:(\d+)/) || [])[1] || '0', 10);
    const tx = parseInt((line.match(/bytes_acked:(\d+)/) || [])[1] || '0', 10);
    if (curKey) all.push({ key: curKey, rx, tx });
    const bm = line.match(/bbr:\(bw:([^,]+),mrtt:([\d.]+),pacing_gain:([\d.]+),cwnd_gain:([\d.]+)\)/);
    if (!bm) continue;
    bbrCount++;
    const rt = line.match(/retrans:\d+\/(\d+)/);
    if (rt) retrans += parseInt(rt[1], 10);
    const c = {
      bw: toMbps(bm[1]), mrtt: parseFloat(bm[2]),
      pacingGain: parseFloat(bm[3]), cwndGain: parseFloat(bm[4]),
      cwnd: parseInt((line.match(/cwnd:(\d+)/) || [])[1] || '0', 10),
      pacing: toMbps((line.match(/pacing_rate ([\d.]+[GMK]?bps)/) || [])[1] || ''),
      delivery: toMbps((line.match(/delivery_rate ([\d.]+[GMK]?bps)/) || [])[1] || ''),
    };
    if (!best || c.bw > best.bw) best = c;
  }
  let dbg = null;
  const dbgLines = (dbgPart || '').split('\n').filter(l => l && !l.startsWith('#'));
  if (dbgLines.length) {
    const modes = {};
    for (const l of dbgLines) {
      const f = l.trim().split(/\s+/);
      const name = BBR_MODES[parseInt(f[2], 10)] || '?';
      modes[name] = (modes[name] || 0) + 1;
    }
    dbg = { count: dbgLines.length, modes };
  }
  return { all, best, retrans, bbrCount, dbg };
}

// Light EMA so single-sample spikes don't zigzag the trace.
function teleSmooth(arr, alpha) {
  const out = new Array(arr.length);
  let s = arr[0];
  for (let i = 0; i < arr.length; i++) {
    s = alpha * arr[i] + (1 - alpha) * s;
    out[i] = s;
  }
  return out;
}

function teleDraw() {
  const cv = document.getElementById('tele-canvas');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height, PAD = 6;
  ctx.clearRect(0, 0, W, H);
  const n = TELE.bw.length;
  // Glide: between samples the whole trace slides left continuously.
  // Right after a sample lands the trace is shifted one slot right and
  // eases back to 0 over one period, so points never jump.
  const slotW = (W - 2 * PAD) / TELE.max;
  const frac = TELE.lastTick ?
    Math.min(1, (performance.now() - TELE.lastTick) / TELE.period) : 1;
  const shift = (1 - frac) * slotW;
  const x = i => PAD + (W - 2 * PAD) * (TELE.max - n + i) / TELE.max + shift;
  // Each series gets its own vertical band (bw top, RTT bottom) with
  // per-series min-max scaling, so flat lines sit centered in their lane
  // instead of overlapping pixel-perfectly at a shared normalized max.
  // Paths are quadratic curves through midpoints (rounded corners).
  const plotBand = (raw, color, top, hgt) => {
    if (raw.length < 2) return;
    const arr = teleSmooth(raw, 0.45);
    let mn = Math.min(...arr), mx = Math.max(...arr);
    if (mx - mn < 1e-9) { mn -= 1; mx += 1; }   // flat series: center it
    const pad = (mx - mn) * 0.12;
    mn -= pad; mx += pad;
    const py = i => top + hgt - hgt * ((arr[i] - mn) / (mx - mn));
    ctx.beginPath();
    ctx.moveTo(x(0), py(0));
    for (let i = 1; i < arr.length; i++) {
      const mxp = (x(i - 1) + x(i)) / 2, myp = (py(i - 1) + py(i)) / 2;
      ctx.quadraticCurveTo(x(i - 1), py(i - 1), mxp, myp);
    }
    ctx.lineTo(x(arr.length - 1), py(arr.length - 1));
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
  };
  const bandH = (H - 2 * PAD - 8) / 2;
  ctx.strokeStyle = 'rgba(128,128,128,0.25)';
  ctx.lineWidth = 1;
  ctx.strokeRect(PAD, PAD, W - 2 * PAD, H - 2 * PAD);
  ctx.beginPath();                               // faint lane separator
  ctx.moveTo(PAD, H / 2);
  ctx.lineTo(W - PAD, H / 2);
  ctx.strokeStyle = 'rgba(128,128,128,0.15)';
  ctx.stroke();
  ctx.save();                                    // clip the gliding traces
  ctx.beginPath();
  ctx.rect(PAD, PAD, W - 2 * PAD, H - 2 * PAD);
  ctx.clip();
  plotBand(TELE.bw,  '#4a9eff', PAD, bandH);
  plotBand(TELE.rtt, '#ff9f43', PAD + bandH + 8, bandH);
  ctx.restore();
}

// 60fps redraw loop while the card is live — drives the glide animation.
function teleAnim() {
  if (!TELE.running) return;
  teleDraw();
  requestAnimationFrame(teleAnim);
}

async function teleTick() {
  if (!TELE.running) return;
  if (router_state.current_active_page !== 'tools') { teleStop(); return; }
  try {
    const { stdout } = await exec(
      'ss -tin state established 2>/dev/null; echo ---DBGFS---; ' +
      'cat /sys/kernel/debug/tcp_bbr3/sockets 2>/dev/null');
    const s = teleParse(stdout);
    const now = performance.now();
    // REAL throughput: sum per-connection byte deltas across ticks. Only count
    // sockets present in both snapshots and only positive deltas, so sockets
    // opening/closing (whose cumulative counters would appear/vanish) can't spike
    // the rate. bytes_received = download, bytes_acked = upload.
    const dt = TELE.prevT ? (now - TELE.prevT) / 1000 : 0;
    let dRx = 0, dTx = 0;
    if (TELE.prev && dt > 0) {
      for (const c of s.all) {
        const p = TELE.prev.get(c.key);
        if (!p) continue;
        if (c.rx > p.rx) dRx += c.rx - p.rx;
        if (c.tx > p.tx) dTx += c.tx - p.tx;
      }
    }
    const down = dt > 0 ? dRx * 8 / 1e6 / dt : 0;
    const up   = dt > 0 ? dTx * 8 / 1e6 / dt : 0;
    TELE.prev = new Map(s.all.map(c => [c.key, { rx: c.rx, tx: c.tx }]));
    TELE.prevT = now;

    if (TELE.lastTick)   // track the real cadence so the glide matches it
      TELE.period = TELE.period * 0.7 + (now - TELE.lastTick) * 0.3;
    TELE.lastTick = now;
    TELE.bw.push(down);
    TELE.rtt.push(s.best ? s.best.mrtt : (TELE.rtt.length ? TELE.rtt[TELE.rtt.length - 1] : 0));
    if (TELE.bw.length > TELE.max) { TELE.bw.shift(); TELE.rtt.shift(); }

    const stats = document.getElementById('tele-stats');
    if (stats) {
      clearNode(stats);
      stats.appendChild(row('Download / Upload', `${down.toFixed(1)} / ${up.toFixed(1)} Mbps`));
      if (s.best) {
        stats.appendChild(row('min RTT / cwnd', `${s.best.mrtt.toFixed(2)} ms / ${s.best.cwnd}`));
        stats.appendChild(row('bbr model bw (send est.)', `${s.best.bw.toFixed(1)} Mbps`));
        stats.appendChild(row('pacing gain / rate', `${s.best.pacingGain} / ${s.best.pacing.toFixed(1)} Mbps`));
        stats.appendChild(row('bbr conns / total retrans', `${s.bbrCount} / ${s.retrans}`));
        if (s.dbg) {
          const m = Object.entries(s.dbg.modes).map(([k, v]) => `${k}:${v}`).join(' ');
          stats.appendChild(row('debugfs sockets', `${s.dbg.count} (${m})`));
        }
      } else {
        stats.appendChild(note('Idle — start a download to see live throughput + the bbr model.'));
      }
    }
  } catch (e) { console.error('telemetry tick', e); }
  if (TELE.running) setTimeout(teleTick, 1000);
}

function teleStop() {
  TELE.running = false;
  const btn = document.getElementById('tele-run');
  if (btn) btn.textContent = 'Start';
}

function teleToggle(btn) {
  if (TELE.running) { teleStop(); return; }
  TELE.running = true;
  TELE.bw = []; TELE.rtt = [];
  TELE.prev = null; TELE.prevT = 0;
  TELE.lastTick = 0; TELE.period = 1000;
  btn.textContent = 'Stop';
  document.getElementById('tele-out').classList.remove('hidden');
  teleTick();
  requestAnimationFrame(teleAnim);
}

// Pause/resume the daemon's drift guard around probe runs that change cc/qdisc
// live on purpose (Auto-Optimize, CC duel) — otherwise the guard reverts the
// probe's settings mid-measurement and corrupts the numbers. The guard caps the
// pause at 10 min, so a crashed WebUI can never disable it permanently.
async function guardPause(on) {
  try {
    const md = router_state.moduleInformation.moduleDir;
    if (on) await exec(`date +%s > ${md}/.guard_pause && chmod 644 ${md}/.guard_pause`);
    else await exec(`rm -f ${md}/.guard_pause`);
  } catch (e) { console.error('guardPause', e); }
}

/* ---------- CC A/B duel ---------- */
// One single-stream timed download per algorithm over the same mirror. We flip
// the cc per leg by BOTH the global sysctl AND the active interface's per-route
// `congctl` — the latter is essential: the daemon pins congctl on the operative
// routes (`table wlan0`), and a pinned route overrides the global sysctl, so
// switching only the sysctl would run the pinned cc for both legs. Original
// global sysctl + route congctl are always restored, even if a leg fails.
const AB_URL = 'https://cachefly.cachefly.net/100mb.test';
const AB_SECS = 15;

function abScript(ccA, ccB) {
  return `
IF=$(ip route get 192.0.2.1 2>/dev/null | grep -o 'dev [^ ]*' | awk '{print $2}')
ORIG=$(cat /proc/sys/net/ipv4/tcp_congestion_control)
ORIG_RC=$(ip route show table "$IF" 2>/dev/null | grep -m1 -o 'congctl [^ ]*' | awk '{print $2}')
[ -z "$ORIG_RC" ] && ORIG_RC="$ORIG"
apply_cc() {
  echo "$1" > /proc/sys/net/ipv4/tcp_congestion_control 2>/dev/null
  [ -z "$IF" ] && return
  ip route show table "$IF" 2>/dev/null | while IFS= read -r r; do
    [ -z "$r" ] && continue
    case "$r" in unreachable*|throw*|blackhole*|prohibit*) continue ;; esac
    base=$(echo "$r" | sed 's/ congctl [^ ]*//')
    ip route change $base table "$IF" congctl "$1" 2>/dev/null
  done
}
apply_cc "${ccA}"
A=$(curl -s -o /dev/null -w '%{speed_download} %{http_code}' --max-time ${AB_SECS} "${AB_URL}")
sleep 1
apply_cc "${ccB}"
B=$(curl -s -o /dev/null -w '%{speed_download} %{http_code}' --max-time ${AB_SECS} "${AB_URL}")
apply_cc "$ORIG_RC"
echo "$ORIG" > /proc/sys/net/ipv4/tcp_congestion_control 2>/dev/null
echo "ABRES a=$A b=$B orig=$ORIG"
`;
}

async function runAb(btn) {
  const out = document.getElementById('ab-out');
  const ccA = document.getElementById('ab-cc-a').value;
  const ccB = document.getElementById('ab-cc-b').value;
  if (ccA === ccB) { toast('Pick two different algorithms.'); return; }

  const btnLabel = btn.textContent;
  btn.classList.add('busy');
  clearNode(btn);
  btn.appendChild(spinner());
  btn.appendChild(el('span', null, 'Running…'));
  out.classList.remove('hidden');
  clearNode(out);
  const status = el('div', 'run-status');
  status.appendChild(spinner());
  status.appendChild(el('span', null, `Running ${ccA} vs ${ccB}… (~${2 * AB_SECS + 3} s)`));
  out.appendChild(status);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise(r => setTimeout(r, 30));

  try {
    await guardPause(true);
    const { stdout } = await exec(abScript(ccA, ccB));
    const m = stdout.match(/ABRES a=([\d.]+) (\d+) b=([\d.]+) (\d+)/);
    clearNode(out);
    if (!m) { out.appendChild(row('Test error.', '')); return; }
    const aM = parseFloat(m[1]) * 8 / 1e6, aCode = m[2];
    const bM = parseFloat(m[3]) * 8 / 1e6, bCode = m[4];
    const okA = aCode === '200' || aCode === '206';
    const okB = bCode === '200' || bCode === '206';
    out.appendChild(row(ccA, okA ? aM.toFixed(1) + ' Mbps' : 'failed (HTTP ' + aCode + ')'));
    out.appendChild(row(ccB, okB ? bM.toFixed(1) + ' Mbps' : 'failed (HTTP ' + bCode + ')'));
    if (okA && okB && aM > 0 && bM > 0) {
      const winner = aM >= bM ? ccA : ccB;
      const delta = (Math.max(aM, bM) / Math.min(aM, bM) - 1) * 100;
      out.appendChild(row('Winner', `${winner} (+${delta.toFixed(0)}%)`));
      out.appendChild(note('Single stream, same mirror, back-to-back. Network variance matters — run 2-3 times before concluding.'));
      addLog(`CC duel: ${ccA}=${aM.toFixed(1)}Mbps ${ccB}=${bM.toFixed(1)}Mbps winner=${winner}`);
    }
  } catch (e) {
    console.error(e);
    clearNode(out);
    out.appendChild(row('Test error.', ''));
  } finally {
    await guardPause(false);
    btn.classList.remove('busy');
    clearNode(btn);
    btn.textContent = btnLabel;
  }
}

async function abPopulate() {
  try {
    const { stdout } = await exec('cat /proc/sys/net/ipv4/tcp_available_congestion_control');
    const algos = stdout.trim().split(/\s+/);
    const selA = document.getElementById('ab-cc-a');
    const selB = document.getElementById('ab-cc-b');
    if (!selA || !selB) return;
    for (const sel of [selA, selB]) {
      clearNode(sel);
      for (const a of algos) {
        const o = document.createElement('option');
        o.value = a; o.textContent = a;
        sel.appendChild(o);
      }
    }
    selA.value = algos.includes('bbr3') ? 'bbr3' : algos[0];
    selB.value = algos.includes('cubic') ? 'cubic' : algos[algos.length - 1];
  } catch (e) { console.error('ab populate', e); }
}

/* ---------- auto-optimize ---------- */
// A few (cc, qdisc) combos are probed on the CURRENT connection; the one with the
// best throughput-vs-bufferbloat wins and is applied + persisted. cc is resolved
// against the kernel's available algorithms.
// The meaningful search space: every registered congestion control crossed with
// each fair/AQM qdisc. FIFO qdiscs (pfifo/bfifo/pfifo_fast) and the classful
// wrappers are skipped — no AQM, so they can only worsen bufferbloat — and reno
// is excluded (strictly weaker than cubic/bbr; a probe it cannot win). No fixed
// whitelist: a custom / out-of-tree algorithm registered in the kernel is probed
// like any other, instead of being silently dropped from the search.
const AUTO_QDISCS = ['cake', 'fq_codel', 'fq'];
async function autoCcSet() {
  try {
    const { stdout } = await exec('cat /proc/sys/net/ipv4/tcp_available_congestion_control');
    const have = stdout.trim().split(/\s+/);
    const set = have.filter(a => a && a !== 'reno');
    return set.length ? set : [have[0] || 'cubic'];
  } catch { return ['cubic']; }
}
// qdisc args mirror set_qdisc() so the probe reflects what will actually apply.
function autoQdiscArgs(q) {
  if (q === 'cake')     return 'cake besteffort triple-isolate wash ack-filter';
  if (q === 'fq_codel') return 'fq_codel limit 1024 target 5ms interval 100ms ecn';
  if (q === 'fq')       return 'fq pacing limit 2000 flow_limit 40 buckets 1024 initial_quantum 15000';
  return q;
}
// Apply a cc (global + per-route congctl, like the duel) and a root qdisc, live.
function autoApplyScript(cc, qdiscArgs, tcBin) {
  return `
IF=$(ip route get 192.0.2.1 2>/dev/null | grep -o 'dev [^ ]*' | awk '{print $2}')
echo "${cc}" > /proc/sys/net/ipv4/tcp_congestion_control 2>/dev/null
if [ -n "$IF" ]; then
  ip route show table "$IF" 2>/dev/null | while IFS= read -r r; do
    [ -z "$r" ] && continue
    case "$r" in unreachable*|throw*|blackhole*|prohibit*) continue ;; esac
    base=$(echo "$r" | sed 's/ congctl [^ ]*//')
    ip route change $base table "$IF" congctl "${cc}" 2>/dev/null
  done
  ${tcBin} qdisc replace dev "$IF" root ${qdiscArgs} 2>/dev/null
fi
echo "APPLIED cc=${cc} if=$IF"
`;
}
// throughput weighted down by bufferbloat (ms): inc=0 -> mbps, inc=100 -> mbps/2.
function autoScore(mbps, inc) { return mbps * 100 / (100 + inc); }

async function runAuto(btn) {
  const out = document.getElementById('auto-out');
  const md = router_state.moduleInformation.moduleDir;
  const tcBin = `${md}/bin/tc`;

  const btnLabel = btn.textContent;
  btn.classList.add('busy');
  clearNode(btn); btn.appendChild(spinner()); btn.appendChild(el('span', null, 'Optimizing…'));
  out.classList.remove('hidden'); clearNode(out);
  const status = el('div', 'run-status');
  status.appendChild(spinner());
  const statusTxt = el('span', null, 'Preparing…');
  status.appendChild(statusTxt);
  out.appendChild(status);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise(r => setTimeout(r, 30));

  let iftype = 'none', origCc = '';
  try {
    const { stdout: ifRaw } = await exec(`ip route get 192.0.2.1 2>/dev/null | awk '/dev/ {for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}'`);
    const ifn = ifRaw.trim();
    iftype = /^wlan|^tun/.test(ifn) ? 'wifi' : (/rmnet|ccmni/.test(ifn) ? 'cell' : 'none');
    const { stdout: cc0 } = await exec('cat /proc/sys/net/ipv4/tcp_congestion_control');
    origCc = cc0.trim();
  } catch {}
  if (iftype === 'none') {
    clearNode(out); out.appendChild(row('No active Wi-Fi / Cellular connection.', ''));
    btn.classList.remove('busy'); clearNode(btn); btn.textContent = btnLabel; return;
  }
  const netLabel = iftype === 'wifi' ? 'Wi-Fi' : 'Cellular';
  const pfx = iftype === 'wifi' ? 'wlan' : 'rmnet';

  const ccSet = await autoCcSet();
  const combos = [];
  for (const cc of ccSet) for (const q of AUTO_QDISCS) combos.push({ cc, q });

  const results = [];
  const list = el('div', 'auto-list');
  out.appendChild(list);
  try {
    await guardPause(true);
    let n = 0;
    for (const combo of combos) {
      n++;
      const cc = combo.cc, q = combo.q;
      statusTxt.textContent = `Testing ${cc} / ${q}…  (${n}/${combos.length}, ~10 s each)`;
      // Add this combo's row up-front (before the blocking test) so the user sees
      // which combo is running; it's filled in once the measurement returns.
      const liveRow = row(`${cc}/${q}`, '⏳ running…');
      list.appendChild(liveRow);
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      await new Promise(r => setTimeout(r, 30));

      await exec(autoApplyScript(cc, autoQdiscArgs(q), tcBin));
      await new Promise(r => setTimeout(r, 2000));                     // settle
      const { stdout } = await exec(bloatScript(2, 8, 6, 8));          // lighter probe (data/time)
      const m = stdout.match(/RESULT idle=(\S*) loaded=(\S*) sumbps=(\S*) okstreams=(\S*)/);
      let rec;
      if (!m) {
        rec = { cc, qdisc: q, ok: false };
      } else {
        const idle = parseFloat(m[1]), loaded = parseFloat(m[2]), sumbps = parseFloat(m[3]);
        const okn = parseInt(m[4], 10) || 0;
        const mbps = isNaN(sumbps) ? 0 : (sumbps * 8 / 1e6);
        const inc = Math.max(0, loaded - idle);
        const loadWorked = okn >= 1 && mbps >= SAT_FLOOR_MBPS && !isNaN(idle) && !isNaN(loaded);
        rec = { cc, qdisc: q, ok: loadWorked, mbps, idle, inc, score: loadWorked ? autoScore(mbps, inc) : -1 };
      }
      results.push(rec);
      const v = liveRow.querySelector('.v');
      if (v) v.textContent = rec.ok ? `${rec.mbps.toFixed(0)} Mbps, +${rec.inc.toFixed(0)} ms` : 'inconclusive';
      liveRow._rec = rec;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      await new Promise(r => setTimeout(r, 30));
    }

    const valid = results.filter(r => r.ok).sort((a, b) => b.score - a.score);
    status.remove();

    if (valid.length === 0) {
      if (origCc) await exec(`echo ${origCc} > /proc/sys/net/ipv4/tcp_congestion_control 2>/dev/null`);
      await exec(`touch ${md}/force_apply && chmod 644 ${md}/force_apply`);
      out.insertBefore(row('Inconclusive — link never saturated.', ''), list);
      out.appendChild(note('Check signal / data and retry. Your previous setting was restored.'));
      return;
    }

    const win = valid[0];
    const bwHint = Math.max(2, Math.round(win.mbps));
    const rttHint = Math.max(5, Math.round(win.idle));

    if (iftype === 'wifi') await exec(`rm -f ${md}/wlan_*`);
    else                   await exec(`rm -f ${md}/rmnet_data_*`);
    const marker = iftype === 'wifi' ? `wlan_${win.cc}_${win.qdisc}` : `rmnet_data_${win.cc}_${win.qdisc}`;
    await exec(`touch ${md}/${marker} && chmod 644 ${md}/${marker}`);
    let winQArgs = autoQdiscArgs(win.qdisc);
    if (win.qdisc === 'cake') {
      await exec(`echo "${bwHint} ${rttHint}" > ${md}/cake_hint_${pfx} && chmod 644 ${md}/cake_hint_${pfx}`);
      winQArgs = `cake bandwidth ${bwHint}mbit rtt ${rttHint}ms besteffort triple-isolate wash ack-filter`;
    }
    await exec(autoApplyScript(win.cc, winQArgs, tcBin));               // live now
    await exec(`echo "Auto" > ${md}/active_profile && chmod 644 ${md}/active_profile`);
    await exec(`touch ${md}/force_apply && chmod 644 ${md}/force_apply`); // daemon re-asserts + watchdog
    if (iftype === 'wifi') { router_state.settingsPageParams.wlanAlgo = win.cc; router_state.settingsPageParams.wlanQdisc = win.qdisc; }
    else                   { router_state.settingsPageParams.rmnetAlgo = win.cc; router_state.settingsPageParams.rmnetQdisc = win.qdisc; }
    router_state.activeProfile = { name: 'Auto', cc: win.cc, qdisc: win.qdisc };

    // winner header above the live ranking; star the winning row in place
    const head = el('div', 'grade-wrap');
    head.appendChild(el('div', 'grade grade-' + grade(win.inc), grade(win.inc)));
    out.insertBefore(head, list);
    out.insertBefore(row('Best for ' + netLabel, `${win.cc} / ${win.qdisc}`), list);
    Array.from(list.children).forEach(rowEl => {
      if (rowEl._rec === win) {
        const k = rowEl.querySelector('.k');
        if (k) { k.textContent = '★ ' + k.textContent; k.style.color = 'var(--primary)'; k.style.fontWeight = '700'; }
      }
    });
    out.appendChild(note(`Applied to ${netLabel} only. cake was also fed the measured rate. Re-run on each network — the best combo differs per link.`));
    toast(`Auto: ${win.cc}/${win.qdisc} applied to ${netLabel}`);
    addLog(`Auto-optimize ${netLabel}: winner ${win.cc}/${win.qdisc} (${win.mbps.toFixed(1)}Mbps +${win.inc.toFixed(1)}ms)`);
  } catch (e) {
    console.error(e);
    clearNode(out); out.appendChild(row('Auto-optimize error.', ''));
    if (origCc) await exec(`echo ${origCc} > /proc/sys/net/ipv4/tcp_congestion_control 2>/dev/null`);
    await stopLoad();
  } finally {
    await guardPause(false);
    btn.classList.remove('busy'); clearNode(btn); btn.textContent = btnLabel;
  }
}

export function initTools() {
  document.querySelectorAll('.profile-btn').forEach(btn => {
    btn.addEventListener('click', () => applyProfile(btn.dataset.profile, btn));
  });
  const au = document.getElementById('auto-run');
  if (au) au.addEventListener('click', () => runAuto(au));
  const b = document.getElementById('bloat-run');
  if (b) b.addEventListener('click', () => runBloat(b));
  const t = document.getElementById('tele-run');
  if (t) t.addEventListener('click', () => teleToggle(t));
  const ab = document.getElementById('ab-run');
  if (ab) ab.addEventListener('click', () => runAb(ab));
  abPopulate();
}
