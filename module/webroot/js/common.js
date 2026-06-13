import { exec, toast, moduleInfo } from './kernelsu.js';
import router_state from './router.js';
import { addLog } from './logs.js';

const MODULE_ID = 'tcp_optimiser';
const MODULE_DIR = `/data/adb/modules/${MODULE_ID}`;
const MODULE_PROP = `${MODULE_DIR}/module.prop`;

function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function parseModuleProp(details) {
	const lines = String(details || '')
		.trim()
		.split('\n')
		.map(line => line.trim())
		.filter(line => line && !line.startsWith('#'));

	const info = lines.reduce((acc, line) => {
		const [key, ...rest] = line.split('=');
		const value = rest.join('=').trim();

		if (key && key.trim()) {
			acc[key.trim()] = value;
		}

		return acc;
	}, {});

	info.moduleDir = `/data/adb/modules/${info.id || MODULE_ID}`;
	return info;
}

async function readModuleProp() {
	try {
		const { stdout: details } = await exec(`cat ${shellQuote(MODULE_PROP)} 2>/dev/null`);
		return parseModuleProp(details || '');
	} catch (error) {
		console.error('Error reading module.prop:', error);
		addLog('Error reading module.prop.');
		return {
			id: MODULE_ID,
			moduleDir: MODULE_DIR
		};
	}
}

async function getModuleInfoFromApi() {
	try {
		const rawInfo = await moduleInfo();

		if (!rawInfo) {
			return null;
		}

		if (typeof rawInfo === 'string') {
			return JSON.parse(rawInfo);
		}

		if (typeof rawInfo === 'object') {
			return rawInfo;
		}

		return null;
	} catch (error) {
		console.warn('moduleInfo() unavailable or invalid, falling back to module.prop:', error);
		return null;
	}
}

export async function updateModuleInformation() {
	try {
		const infoFromApi = await getModuleInfoFromApi();
		const infoFromProp = await readModuleProp();

		router_state.moduleInformation = {
			...(infoFromApi || {}),
			...(infoFromProp || {})
		};

		const versionStr = router_state.moduleInformation.version
			? `v${router_state.moduleInformation.version}`
			: '';

		const versionCodeStr = router_state.moduleInformation.versionCode
			? router_state.moduleInformation.versionCode
			: '';

		const finalVersionStr = versionStr && versionCodeStr
			? `${versionStr} (${versionCodeStr})`
			: 'module.prop might be corrupted!';

		const versionEl = document.getElementById('version');

		if (versionEl) {
			versionEl.textContent = finalVersionStr;
		}
	} catch (error) {
		console.error('Error updating module info:', error);
		addLog('Error updating module info.');
		toast('Error fetching module info.');
	}
}

export async function getModuleActiveState() {
	try {
		const { stdout } = await exec(`[ -f "/dev/.tcp_module_log_cleared" ] && echo "active" || echo ""`);
		return stdout.trim() === 'active';
	} catch (error) {
		console.error('Error fetching module state:', error);
		addLog('Error fetching module state.');
		toast('Error fetching module state.');
		return false;
	}
}

export async function get_active_iface() {
	try {
		const { stdout: activeIface } = await exec(
			`ip route get 192.0.2.1 2>/dev/null | awk '/dev/ {for(i=1;i<=NF;i++) if($i=="dev") print $(i+1); exit}'`
		);

		return activeIface.trim() || 'unknown';
	} catch (error) {
		console.error('Error fetching active interface:', error);
		addLog('Error fetching active interface.');
		toast('Error fetching active interface.');
		return 'error';
	}
}

export async function get_active_algorithm() {
	try {
		const { stdout: activeAlgo } = await exec(`cat /proc/sys/net/ipv4/tcp_congestion_control 2>/dev/null`);
		return activeAlgo.trim() || 'unknown';
	} catch (error) {
		console.error('Error fetching active TCP algorithm:', error);
		addLog('Error fetching active TCP algorithm.');
		toast('Error fetching active TCP algorithm.');
		return 'error';
	}
}

export async function get_available_algorithms() {
	try {
		const { stdout: availableAlgos } = await exec(`cat /proc/sys/net/ipv4/tcp_available_congestion_control 2>/dev/null`);

		return availableAlgos
			.trim()
			.split(/\s+/)
			.filter(Boolean);
	} catch (error) {
		console.error('Error fetching available TCP algorithms:', error);
		addLog('Error fetching available TCP algorithms.');
		toast('Error fetching available TCP algorithms.');
		return [];
	}
}

export async function get_default_qdisc() {
	try {
		const { stdout: qdisc } = await exec(`cat /proc/sys/net/core/default_qdisc 2>/dev/null`);
		return qdisc.trim() || 'unknown';
	} catch (error) {
		console.error('Error fetching default qdisc:', error);
		addLog('Error fetching default qdisc.');
		return 'error';
	}
}

export async function get_active_qdisc(iface) {
	try {
		if (!iface || iface === 'unknown' || iface === 'error') {
			return 'unknown';
		}

		const { stdout } = await exec(
			`tc qdisc show dev ${shellQuote(iface)} 2>/dev/null | awk 'NR==1 {print $2}'`
		);

		return stdout.trim() || 'unknown';
	} catch (error) {
		console.error('Error fetching active qdisc:', error);
		addLog('Error fetching active qdisc.');
		return 'error';
	}
}

export async function get_selected_qdisc(prefix) {
	try {
		const moduleDir = router_state.moduleInformation?.moduleDir || MODULE_DIR;

		const safePrefix = prefix === 'rmnet_data' ? 'rmnet_data' : 'wlan';

		const { stdout } = await exec(
			`find ${shellQuote(moduleDir)} -maxdepth 1 -type f -name ${shellQuote(`${safePrefix}_qdisc_*`)} -print -quit 2>/dev/null`
		);

		const markerPath = stdout.trim();

		if (!markerPath) {
			return 'fq_codel';
		}

		const markerName = markerPath.split('/').pop();
		const qdisc = markerName.replace(`${safePrefix}_qdisc_`, '');

		return ['fq_codel', 'fq', 'pfifo_fast'].includes(qdisc)
			? qdisc
			: 'fq_codel';
	} catch (error) {
		console.error('Error fetching selected qdisc:', error);
		addLog('Error fetching selected qdisc.');
		return 'fq_codel';
	}
}

export function get_qdisc_prefix_for_iface(iface) {
	if (/^(wlan|swlan)/.test(iface || '')) {
		return 'wlan';
	}

	if (/^(rmnet|rmnet_data|ccmni)/.test(iface || '')) {
		return 'rmnet_data';
	}

	return 'wlan';
}

export async function getInitcwndInitrwndValue() {
	try {
		const { stdout } = await exec(`ip route show 2>/dev/null | grep -m1 -o 'initcwnd [0-9]* initrwnd [0-9]*' || true`);

		const values = stdout
			.trim()
			.split(/\s+/)
			.filter((_, i) => i % 2 === 1);

		return values;
	} catch (error) {
		console.error('Error fetching initcwnd/initrwnd values:', error);
		addLog('Error fetching initcwnd/initrwnd values.');
		toast('Error fetching initcwnd/initrwnd values.');
		return [];
	}
}

export async function get_wifi_calling_state() {
	const moduleDir = router_state.moduleInformation?.moduleDir || MODULE_DIR;
	const dumpsysTmpFile = `${moduleDir}/dumpsys.tmp`;

	try {
		const quotedTmp = shellQuote(dumpsysTmpFile);

		await exec(`dumpsys activity service SystemUIService > ${quotedTmp} 2>/dev/null`);

		const { stdout } = await exec(
			`grep -qE "slot='vowifi'.*visible user=.*" ${quotedTmp} && echo "active" || echo "inactive"`
		);

		await exec(`rm -f ${quotedTmp}`);

		return stdout.trim() === 'active';
	} catch (error) {
		console.error('Error checking VoWiFi state:', error);
		addLog('Error checking VoWiFi state.');

		try {
			await exec(`rm -f ${shellQuote(dumpsysTmpFile)}`);
		} catch (_) {}

		return false;
	}
}

export async function fetchIsConfigFile(fileName) {
	try {
		const moduleDir = router_state.moduleInformation?.moduleDir || MODULE_DIR;
		const filePath = `${moduleDir}/${fileName}`;

		const { stdout } = await exec(`[ -f ${shellQuote(filePath)} ] && echo "exist" || echo ""`);
		return stdout.trim() === 'exist';
	} catch (error) {
		console.error('Error fetching config file status:', error);
		addLog('Error fetching config file status.');
		toast('Error fetching config file status.');
		return false;
	}
}

export function formatLocalDateTime(date = new Date()) {
	const pad = (n) => n.toString().padStart(2, '0');

	const yyyy = date.getFullYear();
	const mm = pad(date.getMonth() + 1);
	const dd = pad(date.getDate());

	const hh = pad(date.getHours());
	const min = pad(date.getMinutes());
	const ss = pad(date.getSeconds());

	return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

document.addEventListener('DOMContentLoaded', () => {
	document.querySelectorAll('.link').forEach((link) => {
		link.addEventListener('click', async (event) => {
			event.preventDefault();

			const url = event.currentTarget.getAttribute('data-value');

			if (!url) {
				return;
			}

			try {
				await exec(`am start -a android.intent.action.VIEW -d ${shellQuote(url)}`);
			} catch (error) {
				console.error('Error opening link:', error);
				addLog('Error opening external link.');
				toast('Error opening link.');
			}
		});
	});
});
