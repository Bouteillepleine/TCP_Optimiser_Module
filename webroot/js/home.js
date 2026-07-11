import { toast } from './kernelsu.js';
import {
	getModuleActiveState, get_active_iface, get_active_algorithm, get_active_qdisc,
	getInitcwndInitrwndValue, get_wifi_calling_state, getBbr3Available,
	getWifiLinkSpeed, getWifiSignalDbm, getCellSignalDbm, getQdiscGuard
} from './common.js';
import router_state from './router.js';
import { addLog } from './logs.js';

function _chip(el, cls) {
	if (!el) return;
	el.classList.remove('on', 'off', 'warn');
	if (cls) el.classList.add(cls);
}

export async function updateModuleStatus () {
	var module_status = "Loading Module Status...⌛";
	var active_iface = "None";
	var active_iface_type = "Unknown ⁉️";
	var active_algorithm = "Unknown ⁉️";
	var active_qdisc = "Unknown ⁉️";
	var wifi_calling_state = "Unknown ⁉️";
	var active_InitcwndInitrwndValue = [];
	var link_speed = "";
	var bbr3_avail = false;
	var signal = { text: '', level: -1 };
	var guard = { on: false, text: '' };
	try
	{
		module_status = (await getModuleActiveState()) ? "Enabled ✅" : "Disabled ❌";

		const iface = await get_active_iface();
		active_iface = (iface && iface !== 'error') ? iface : "None";
		const iftype = /^wlan|^tun/.test(iface) ? 'wifi'
			: (/rmnet|ccmni/.test(iface) ? 'cell' : 'none');
		active_iface_type = iftype === 'wifi' ? "Wi-Fi 🛜"
			: (iftype === 'cell' ? "Cellular 📶" : "Unknown ⁉️");

		const algo = await get_active_algorithm();
		if (algo && algo !== 'error') active_algorithm = algo;

		const qdisc = await get_active_qdisc(iface);
		if (qdisc && qdisc !== 'error') active_qdisc = qdisc;

		active_InitcwndInitrwndValue = await getInitcwndInitrwndValue();

		bbr3_avail = await getBbr3Available();

		// signal -> {text, level 0..4}: both Wi-Fi and cellular report dBm.
		// Wi-Fi uses RSSI thresholds; cellular uses typical LTE/NR RSRP thresholds.
		if (iftype === 'wifi') {
			wifi_calling_state = (await get_wifi_calling_state()) ? "Active " : "Inactive ";
			const ls = await getWifiLinkSpeed();
			link_speed = ls ? ls + ' Mbps' : '';

			const dbm = parseInt(await getWifiSignalDbm(iface), 10);
			if (!isNaN(dbm)) {
				let lvl = 0;
				if (dbm >= -55) lvl = 4; else if (dbm >= -65) lvl = 3; else if (dbm >= -73) lvl = 2; else if (dbm >= -82) lvl = 1; else lvl = 0;
				signal = { text: dbm + ' dBm', level: lvl };
			}
		} else if (iftype === 'cell') {
			const dbm = parseInt(await getCellSignalDbm(), 10);
			if (!isNaN(dbm)) {
				let lvl = 0;
				if (dbm >= -80) lvl = 4; else if (dbm >= -90) lvl = 3; else if (dbm >= -100) lvl = 2; else if (dbm >= -110) lvl = 1; else lvl = 0;
				signal = { text: dbm + ' dBm', level: lvl };
			}
		}

		// qdisc guard heartbeat: getQdiscGuard() already applied the 2-min
		// freshness check, so a non-empty value means it's actively guarding
		const guardRaw = await getQdiscGuard();
		if (guardRaw) {
			const parts = guardRaw.split(/\s+/);
			const gIface = parts[0] || '';
			const gQdisc = parts[1] || '';
			guard = (iface && gIface && gIface !== iface) ? { on: false, text: '' } : { on: true, text: gQdisc };
		}
	} catch (error) {
		console.error('Error updating status: ', error);
		addLog('Error updating status.');
		toast("Error updating status.");
	} finally {
		router_state.homePageParams.module_status = module_status;
		router_state.homePageParams.active_iface_type = active_iface_type;
		router_state.homePageParams.active_iface = active_iface;
		router_state.homePageParams.active_algorithm = active_algorithm;
		router_state.homePageParams.active_qdisc = active_qdisc;
		router_state.homePageParams.active_InitcwndInitrwndValue = active_InitcwndInitrwndValue;
		router_state.homePageParams.wifi_calling_state = wifi_calling_state;
		router_state.homePageParams.link_speed = link_speed;
		router_state.homePageParams.bbr3_avail = bbr3_avail;
		router_state.homePageParams.signal = signal;
		router_state.homePageParams.guard = guard;
	}
}

/* color the status chips + qdisc banner + link speed (called from updateHomeUI) */
function enhanceHomeUI () {
	const p = router_state.homePageParams;

	const ms = document.getElementById('module_status_value');
	_chip(ms, p.module_status && p.module_status.includes('Enabled') ? 'on'
		: (p.module_status && p.module_status.includes('Disabled') ? 'off' : null));

	const qd = document.getElementById('qdisc_value');
	if (qd) {
		const t = (p.active_qdisc || '').toLowerCase();
		_chip(qd, /fq|cake|codel|pie/.test(t) ? 'on'
			: (t && !t.includes('loading') && !t.includes('unknown') ? 'warn' : null));
	}
	const cc = document.getElementById('tcp_cong_value');
	if (cc) _chip(cc, /bbr/.test((p.active_algorithm || '').toLowerCase()) ? 'on' : null);

	const banner = document.getElementById('qdisc-banner');
	if (banner) {
		const q = (p.active_qdisc || '').toLowerCase();
		if (p.bbr3_avail && q && !/fq|cake|pie/.test(q) && !q.includes('loading') && !q.includes('unknown')) {
			banner.textContent = '💡 bbr3 detected - for best results use cake, fq or fq_pie. See Tools > Profiles.';
			banner.classList.remove('hidden');
		} else {
			banner.classList.add('hidden');
		}
	}

	const lsDiv = document.getElementById('linkspeed_div');
	const lsVal = document.getElementById('linkspeed_value');
	if (lsDiv && lsVal) {
		if (p.active_iface_type === 'Wi-Fi 🛜' && p.link_speed) {
			lsVal.textContent = p.link_speed;
			lsDiv.classList.remove('hidden');
		} else {
			lsDiv.classList.add('hidden');
		}
	}

	// signal strength: label + 4 bars filled to level
	const sigDiv = document.getElementById('signal_div');
	const sigTxt = document.getElementById('signal_text');
	const sigBars = document.getElementById('signal_bars');
	const sig = p.signal || { level: -1 };
	if (sigDiv && sigBars) {
		if (sig.level >= 0) {
			if (sigTxt) sigTxt.textContent = sig.text || '';
			const bars = sigBars.querySelectorAll('i');
			bars.forEach((b, i) => b.classList.toggle('on', i < sig.level));
			sigBars.classList.remove('lvl-low', 'lvl-mid', 'lvl-hi');
			sigBars.classList.add(sig.level <= 1 ? 'lvl-low' : (sig.level <= 2 ? 'lvl-mid' : 'lvl-hi'));
			sigDiv.classList.remove('hidden');
		} else {
			sigDiv.classList.add('hidden');
		}
	}

	// qdisc guard heartbeat
	const gDiv = document.getElementById('guard_div');
	const gVal = document.getElementById('guard_value');
	const g = p.guard || { on: false };
	if (gDiv && gVal) {
		if (g.on) {
			gVal.textContent = 'Guarding ✅' + (g.text ? ' (' + g.text + ')' : '');
			_chip(gVal, 'on');
			gDiv.classList.remove('hidden');
		} else {
			gDiv.classList.add('hidden');
		}
	}
}

export function updateHomeUI () {
	if (router_state.isInitializing == false) {
		document.getElementById('module_status_value').textContent = router_state.homePageParams.module_status;
		if(router_state.homePageParams.module_status == "Enabled ✅")
		{
			const ifaceTypeDiv = document.getElementById('active_iface_type_div');
			const ifaceValDiv = document.getElementById('active_iface_div');
			const tcpCongValDiv = document.getElementById('tcp_cong_div');
			const qdiscValDiv = document.getElementById('qdisc_div');

			document.getElementById('active_iface_type_value').textContent = router_state.homePageParams.active_iface_type;
			document.getElementById('active_iface_value').textContent = router_state.homePageParams.active_iface;
			document.getElementById('tcp_cong_value').textContent = router_state.homePageParams.active_algorithm;
			document.getElementById('qdisc_value').textContent = router_state.homePageParams.active_qdisc;

			if (ifaceTypeDiv?.classList.contains('hidden'))
					ifaceTypeDiv.classList.remove('hidden');

			if (ifaceValDiv?.classList.contains('hidden'))
					ifaceValDiv.classList.remove('hidden');

			if (tcpCongValDiv?.classList.contains('hidden'))
					tcpCongValDiv.classList.remove('hidden');

			if (qdiscValDiv?.classList.contains('hidden'))
					qdiscValDiv.classList.remove('hidden');

			const wifiCallingDiv = document.getElementById('wifi_calling_value_div');
			const wifiCallingSpan = document.getElementById('wifi_calling_value');

			if(router_state.homePageParams.active_iface_type == "Wi-Fi 🛜")
			{
				if (wifiCallingDiv?.classList.contains('hidden'))
					wifiCallingDiv.classList.remove('hidden');

				wifiCallingSpan.textContent = router_state.homePageParams.wifi_calling_state;
			}
			else
			{
				// Not on Wi-Fi: Wi-Fi Calling is meaningless on cellular, so hide the
				// row entirely instead of showing an "Unknown" placeholder.
				if (!wifiCallingDiv.classList.contains('hidden'))
					wifiCallingDiv.classList.add('hidden');
			}

			const initcwndDiv = document.getElementById('initcwnd_value_div');
			const initrwndDiv = document.getElementById('initrwnd_value_div');
			const initcwndSpan = document.getElementById('initcwnd_value');
			const initrwndSpan = document.getElementById('initrwnd_value');

			const values = router_state.homePageParams.active_InitcwndInitrwndValue;
			const isLoading = values.length < 2 && router_state.settingsPageParams.initcwndInitrwnd;

			if(values.length == 2 || isLoading)
			{
				if (initcwndDiv?.classList.contains('hidden'))
					initcwndDiv.classList.remove('hidden');

				if (initrwndDiv?.classList.contains('hidden'))
					initrwndDiv.classList.remove('hidden');

				initcwndSpan.textContent = values.length == 2 ? values[0] : "Loading initcwnd value...";
				initrwndSpan.textContent = values.length == 2 ? values[1] : "Loading initrwnd value...";
			}
			else
			{
				if (initcwndDiv && !initcwndDiv.classList.contains('hidden'))
					initcwndDiv.classList.add('hidden');

				if (initrwndDiv && !initrwndDiv.classList.contains('hidden'))
					initrwndDiv.classList.add('hidden');
			}
		}
		// color chips + qdisc banner + link speed
		enhanceHomeUI();
	}
}

export async function initHome() {
	router_state.isInitializing = false;
	updateHomeUI();
}
