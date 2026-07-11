import { exec, toast, moduleInfo } from './kernelsu.js';
import router_state from './router.js';
import { addLog } from './logs.js';

async function readModuleProp () {
	try {
		const { stdout: details } = await exec(`cat /data/adb/modules/tcp_optimiser/module.prop`);
		const lines = details.trim().split('\n').filter(line => line);
		
		// Convert lines to object
		let moduleInfo = lines.reduce((acc, line) => {
		  const [key, ...rest] = line.split('=');
		  const value = rest.join('=').trim(); // handle values with '=' in them
		  acc[key.trim()] = value;
		  return acc;
		}, {});
		
		moduleInfo["moduleDir"] = `/data/adb/modules/tcp_optimiser`;
		return moduleInfo;
	} catch (error) {
		
	}
}

export async function updateModuleInformation () {
	try {
		// ksu.moduleInfo() isn't available/consistent across every WebUI host
		// (WebUI X, KSUWebUI, …). Read module.prop via exec — which always works
		// where exec does — and treat ksu.moduleInfo() as a best-effort seed only,
		// so its absence can't block moduleDir/version from being set.
		let seed = {};
		try { seed = JSON.parse(moduleInfo()) || {}; } catch (e) { /* host lacks moduleInfo() */ }
		const prop = await readModuleProp();
		router_state.moduleInformation = prop || seed || {};
	}catch (error) {
		console.error('Error updating module info:', error);
	}
	const info = router_state.moduleInformation || {};
	var versionStr = info.version ? 'v' + info.version : '';
	var versionCodeStr = info.versionCode ? info.versionCode : '';
	var finalVersionStr = versionStr != '' && versionCodeStr != '' ? `${versionStr} (${versionCodeStr})` : "module.prop might be corrupted!"
	document.getElementById('version').textContent = finalVersionStr;
}

export async function getModuleActiveState () {
	try {
		const { stdout: file_exists } = await exec(`ls "/dev/.tcp_module_log_cleared"`);
		return file_exists != "" ? true: false;
	}catch (error) {
		console.error('Error updating module state:', error);
		toast("Error fetching module state.");
	}
}

export async function get_active_iface () {
	try {
		const { stdout: active_iface } = await exec(`ip route get 192.0.2.1 2>/dev/null | awk '/dev/ {for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}'`);
		return active_iface.trim()
	} catch (error) {
		console.error('Error fetching active interface: ', error);
		addLog('Error fetching active interface.');
		toast("Error fetching active interface.");
		return "error"
	}
};

export async function get_active_algorithm () {
	try {
		const { stdout: active_algo } = await exec(`cat /proc/sys/net/ipv4/tcp_congestion_control`);
		return active_algo.trim()
	} catch (error) {
		console.error('Error fetching active interface: ', error);
		addLog('Error fetching active interface.');
		toast("Error fetching active interface.");
		return "error"
	}
};

export async function get_active_qdisc(iface) {
	try {
		const moduleInfo = await readModuleProp();
		const dir = moduleInfo && moduleInfo.moduleDir ? moduleInfo.moduleDir : '/data/adb/modules/tcp_optimiser';
		// Report the CONFIGURED qdisc from the marker file "<prefix>_<cc>_<qdisc>"
		// (e.g. wlan_bbr3_fq_codel), NOT the live `tc` root. Android wraps the real
		// qdisc in a classful root (prio/mq/multiq) with the chosen qdisc on each
		// band, so the live root is ambiguous (shows "prio"/"multiq"/"fq"…). The
		// marker is exactly what the user picked in Settings / via a profile.
		const prefix = /^wlan|^tun/.test(iface) ? 'wlan'
			: (/rmnet|ccmni/.test(iface) ? 'rmnet_data' : 'wlan');
		const { stdout } = await exec(`ls ${dir}/${prefix}_* 2>/dev/null | xargs -n1 basename | head -1`);
		const marker = (stdout || '').trim();
		if (marker) {
			// strip "<prefix>_", then the cc token (up to the first underscore); the
			// remainder is the qdisc (which may itself contain underscores, e.g.
			// fq_codel / pfifo_fast).
			const rest = marker.replace(new RegExp('^' + prefix + '_'), '');
			const us = rest.indexOf('_');
			if (us >= 0) return rest.slice(us + 1);
		}

		return null;
	} catch (error) {
		console.error('Error fetching active qdisc: ', error);
		addLog('Error fetching active qdisc.');
		toast("Error fetching active qdisc.");
		return "error";
	}
}

export async function getInitcwndInitrwndValue () {
	try {
		const { stdout: initcwndInitrwndValueOutput } = await exec(`ip route show | grep -o 'initcwnd [0-9]* initrwnd [0-9]*'`);
		const initcwndInitrwndValues = initcwndInitrwndValueOutput.trim().split(/\s+/).filter((_, i) => i % 2 === 1);
		return initcwndInitrwndValues;
	} catch (error) {
		console.error('Error fetching active interface: ', error);
		addLog('Error fetching active interface.');
		toast("Error fetching active interface.");
		return [];
	}
};

export async function get_wifi_calling_state() {
  try {
    // Mirror the OxygenOS status-bar VoWiFi icon: it shows exactly when a call is
    // actively carried over Wi-Fi (icon holder visible=true / IMS vowifiState=true).
    // Reads Inactive on VoLTE, matching what the status bar displays. The AOSP
    // `slot='vowifi'` string is never printed on OxygenOS, hence the OPlus format.
    const { stdout } = await exec(
      `dumpsys activity service SystemUIService 2>/dev/null | grep -iE "\\(vowifi\\) holder=|vowifiState="`
    );
    return /\(vowifi\)[^\n]*visible=true/.test(stdout) || /vowifiState=true/.test(stdout);
  } catch (error) {
    console.error('Error checking VoWiFi state:', error);
	addLog('Error checking VoWiFi state.');
    return false;
  }
}

/* ---------- per-metric Home-status helpers ---------- */

// Is bbr3 in the kernel's available congestion-control list?
export async function getBbr3Available () {
	try {
		const { stdout } = await exec(`cat /proc/sys/net/ipv4/tcp_available_congestion_control`);
		return /(^|\s)bbr3(\s|$)/.test(stdout.trim());
	} catch (error) {
		console.error('Error checking bbr3 availability:', error);
		return false;
	}
}

// Wi-Fi link speed (Mbps, digits only).
export async function getWifiLinkSpeed () {
	try {
		const { stdout } = await exec(`dumpsys wifi 2>/dev/null | grep -oiE 'Link ?speed[:= ]+[0-9]+' | grep -oE '[0-9]+' | head -1`);
		return stdout.trim();
	} catch (error) {
		console.error('Error fetching link speed:', error);
		return '';
	}
}

// Wi-Fi signal in dBm (RSSI) via iw.
export async function getWifiSignalDbm (iface) {
	try {
		const { stdout } = await exec(`iw dev ${iface} link 2>/dev/null | grep -i signal | grep -oE '\\-?[0-9]+' | head -1`);
		return stdout.trim();
	} catch (error) {
		console.error('Error fetching Wi-Fi signal:', error);
		return '';
	}
}

// Cellular signal in dBm. The first rsrp/level in telephony.registry belongs to
// dead RATs (mCdma, always 0), so read the ACTIVE data SIM's block
// (mDataConnectionState=2), find which radio is primary (Lte/Nr/...), then its
// rsrp/ssRsrp. Keep only negative (real) values — ignore the 2147483647 sentinel.
// NB: shell vars use $VAR (never ${VAR}) so this JS template literal stays valid.
export async function getCellSignalDbm () {
	const script = `
CELLD=$(dumpsys telephony.registry 2>/dev/null)
CSIG=$(echo "$CELLD" | awk '/mSignalStrength=SignalStrength/{s=$0} /mDataConnectionState=2/{print s; exit}')
[ -z "$CSIG" ] && CSIG=$(echo "$CELLD" | grep -m1 "mSignalStrength=SignalStrength")
CRAT=$(echo "$CSIG" | grep -oE 'primary=CellSignalStrength[A-Za-z]+' | head -1 | sed 's/.*Strength//')
[ -z "$CRAT" ] && CRAT=Lte
CSUB=$(echo "$CSIG" | grep -oE "m$CRAT=CellSignalStrength$CRAT[^,]*")
CDBM=$(echo "$CSUB" | grep -oiE '(ss)?rsrp *= *-?[0-9]+' | grep -oE '\\-?[0-9]+' | head -1)
case "$CDBM" in -*) : ;; *) CDBM="" ;; esac
echo "$CDBM"
`;
	try {
		const { stdout } = await exec(script);
		return stdout.trim();
	} catch (error) {
		console.error('Error fetching cellular signal:', error);
		return '';
	}
}

// qdisc-guard heartbeat: only "guarding" if the marker was touched in the last 2 min.
export async function getQdiscGuard () {
	const G = `/data/adb/modules/tcp_optimiser/.qdisc_guard`;
	try {
		const { stdout } = await exec(`[ -n "$(find "${G}" -mmin -2 2>/dev/null)" ] && cat "${G}" 2>/dev/null || true`);
		return stdout.trim();
	} catch (error) {
		console.error('Error fetching qdisc guard:', error);
		return '';
	}
}

export async function fetchIsConfigFile (file_name) {
	// Module info may not be ready yet (or the host lacks moduleInfo); bail
	// quietly so we don't deref null and spam an error toast every poll.
	const dir = router_state.moduleInformation && router_state.moduleInformation.moduleDir;
	if (!dir) return false;
	try {
		const { stdout: output } = await exec(`[ -f "${dir}/${file_name}" ] && echo "exist" || echo ""`);
		return output == "exist";
	} catch (error) {
		console.error('Error fetching config file: ', error);
		return false;
	}
};

export function formatLocalDateTime(date = new Date()) {
  const pad = (n) => n.toString().padStart(2, '0');

  const yyyy = date.getFullYear();
  const mm   = pad(date.getMonth() + 1);
  const dd   = pad(date.getDate());

  const hh   = pad(date.getHours());
  const min  = pad(date.getMinutes());
  const ss   = pad(date.getSeconds());

  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

document.addEventListener('DOMContentLoaded', async () => {
	document.querySelectorAll('.link').forEach(async (link) => {
		link.addEventListener('click', async (event) => {
			event.preventDefault();
			const url = event.currentTarget.getAttribute('data-value');
			await exec(`am start -a android.intent.action.VIEW -d "${url}"`);
		});
	});
});
