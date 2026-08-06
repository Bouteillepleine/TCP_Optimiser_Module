import { exec } from './kernelsu.js';
import {
	get_active_iface, get_active_algorithm, get_active_qdisc,
	getWifiSignalDbm, getCellSignalDbm
} from './common.js';

// One benchmark record per line (JSON-lines). Persists in the module dir so it
// survives reboots. Appended on each bufferbloat run, read by the Results tab.
const STORE = '/data/adb/modules/tcp_optimiser/bench_results.jsonl';

// Primary cellular radio -> a friendly network label ("5G", "4G", ...).
// Uses the active-data SIM's primary CellSignalStrength class (NSA 5G that keeps
// an LTE primary will read as 4G — acceptable for a benchmark label).
export async function getCellRat () {
	const script = `
CELLD=$(dumpsys telephony.registry 2>/dev/null)
CSIG=$(echo "$CELLD" | awk '/mSignalStrength=SignalStrength/{s=$0} /mDataConnectionState=2/{print s; exit}')
[ -z "$CSIG" ] && CSIG=$(echo "$CELLD" | grep -m1 "mSignalStrength=SignalStrength")
echo "$CSIG" | grep -oE 'primary=CellSignalStrength[A-Za-z]+' | head -1 | sed 's/.*Strength//'
`;
	try {
		const { stdout } = await exec(script);
		const rat = stdout.trim();
		const map = { Nr: '5G', Lte: '4G', Wcdma: '3G', Tdscdma: '3G', Gsm: '2G', Cdma: '2G' };
		return map[rat] || (rat || 'Cellular');
	} catch (error) {
		console.error('Error reading cell RAT:', error);
		return 'Cellular';
	}
}

// Snapshot of what a test was run under: interface, connection label, the active
// congestion control + qdisc, and signal (dBm).
export async function getBenchContext () {
	const iface = await get_active_iface();
	const iftype = /^wlan|^tun/.test(iface) ? 'wifi'
		: (/rmnet|ccmni/.test(iface) ? 'cell' : 'none');

	const cc = await get_active_algorithm();
	const qdisc = await get_active_qdisc(iface);

	let conn = iface || 'Unknown';
	let signal = '';
	if (iftype === 'wifi') {
		conn = 'Wi-Fi';
		signal = await getWifiSignalDbm(iface);
	} else if (iftype === 'cell') {
		conn = await getCellRat();
		signal = await getCellSignalDbm();
	}

	return {
		iface: iface && iface !== 'error' ? iface : '',
		iftype, conn,
		cc: cc && cc !== 'error' ? cc : '',
		qdisc: qdisc && qdisc !== 'error' ? qdisc : '',
		signal
	};
}

// Stable per-record key. New records carry an `id`; legacy records (saved before
// the id field existed) fall back to their `ts`. Used to target a single card for
// deletion.
export function recordKey (r) {
	return String(r.id != null ? r.id : r.ts);
}

// Append one record, base64-encoded so no field value can break the shell redirect.
export async function saveBenchResult (record) {
	try {
		if (record.id == null) {
			record.id = (record.ts != null ? record.ts : Date.now()) + '-' +
				Math.random().toString(36).slice(2, 8);
		}
		const json = JSON.stringify(record);
		const b64 = btoa(unescape(encodeURIComponent(json + '\n')));
		await exec(`echo '${b64}' | base64 -d >> ${STORE}`);
		return true;
	} catch (error) {
		console.error('Error saving benchmark result:', error);
		return false;
	}
}

// Delete a single record by key (see recordKey), keeping the rest. The surviving
// records are rewritten to the store base64-encoded so no JSON character can break
// the shell redirect (the append path can assume clean tokens; a bulk rewrite can't).
export async function deleteBenchResult (key) {
	try {
		const kept = (await readBenchResults()).filter(r => recordKey(r) !== String(key));
		const body = kept.map(r => JSON.stringify(r)).join('\n');
		const payload = body ? body + '\n' : '';
		const b64 = btoa(unescape(encodeURIComponent(payload)));
		await exec(`echo '${b64}' | base64 -d > ${STORE}`);
		return true;
	} catch (error) {
		console.error('Error deleting benchmark result:', error);
		return false;
	}
}

export async function readBenchResults () {
	try {
		const { stdout } = await exec(`cat ${STORE} 2>/dev/null || true`);
		return stdout.split('\n')
			.map(l => l.trim())
			.filter(l => l)
			.map(l => { try { return JSON.parse(l); } catch { return null; } })
			.filter(Boolean);
	} catch (error) {
		console.error('Error reading benchmark results:', error);
		return [];
	}
}

export async function clearBenchResults () {
	try {
		await exec(`rm -f ${STORE}`);
		return true;
	} catch (error) {
		console.error('Error clearing benchmark results:', error);
		return false;
	}
}
