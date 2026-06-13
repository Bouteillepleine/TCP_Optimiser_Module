import { toast } from './kernelsu.js';
import {
	get_active_iface,
	get_active_algorithm,
	getInitcwndInitrwndValue,
	get_wifi_calling_state,
	getModuleActiveState,
	get_available_algorithms,
	get_default_qdisc,
	get_active_qdisc,
	get_selected_qdisc,
	get_qdisc_prefix_for_iface
} from './common.js';
import router_state from './router.js';
import { addLog } from './logs.js';

function getInterfaceType(iface) {
	if (!iface || iface === 'None' || iface === 'unknown' || iface === 'error') {
		return 'Unknown ⁉️';
	}

	if (
		iface.startsWith('rmnet') ||
		iface.startsWith('ccmni') ||
		iface.startsWith('wwan') ||
		iface.startsWith('usb')
	) {
		return 'Cellular 📶';
	}

	if (
		iface.startsWith('wlan') ||
		iface.startsWith('wifi')
	) {
		return 'Wi-Fi 🛜';
	}

	if (
		iface.startsWith('tun') ||
		iface.startsWith('tap') ||
		iface.startsWith('wg') ||
		iface.startsWith('ppp')
	) {
		return 'Tunnel/VPN 🔐';
	}

	if (iface.startsWith('eth')) {
		return 'Ethernet 🌐';
	}

	return 'Unknown ⁉️';
}

function setText(id, value) {
	const el = document.getElementById(id);

	if (el) {
		el.textContent = value;
	}
}

function showElement(id) {
	const el = document.getElementById(id);

	if (el) {
		el.classList.remove('hidden');
	}
}

function hideElement(id) {
	const el = document.getElementById(id);

	if (el) {
		el.classList.add('hidden');
	}
}

export async function updateModuleStatus() {
	let module_status = 'Loading Module Status...⌛';
	let active_iface = 'None';
	let active_iface_type = 'Unknown ⁉️';
	let active_algorithm = 'Unknown ⁉️';
	let available_algorithms = [];
	let default_qdisc = 'Unknown ⁉️';
	let active_qdisc = 'Unknown ⁉️';
	let selected_qdisc = 'Unknown ⁉️';
	let wifi_calling_state = 'Unknown ⁉️';
	let active_InitcwndInitrwndValue = [];

	try {
		const isModuleActive = await getModuleActiveState();

		module_status = isModuleActive ? 'Enabled ✅' : 'Disabled ❌';

		if (isModuleActive) {
			active_iface = await get_active_iface();
			active_iface = active_iface || 'None';

			active_iface_type = getInterfaceType(active_iface);

			active_algorithm = await get_active_algorithm();
			available_algorithms = await get_available_algorithms();

			default_qdisc = await get_default_qdisc();
			active_qdisc = await get_active_qdisc(active_iface);

			const qdiscPrefix = get_qdisc_prefix_for_iface(active_iface);
			selected_qdisc = await get_selected_qdisc(qdiscPrefix);

			active_InitcwndInitrwndValue = await getInitcwndInitrwndValue();

			if (active_iface_type === 'Wi-Fi 🛜') {
				wifi_calling_state = await get_wifi_calling_state()
					? 'Active ✅'
					: 'Inactive ❌';
			}
		}
	} catch (error) {
		console.error('Error updating status:', error);
		addLog('Error updating status.');
		toast('Error updating status.');
	} finally {
		router_state.homePageParams.module_status = module_status;
		router_state.homePageParams.active_iface_type = active_iface_type;
		router_state.homePageParams.active_iface = active_iface;
		router_state.homePageParams.active_algorithm = active_algorithm;
		router_state.homePageParams.available_algorithms = available_algorithms;
		router_state.homePageParams.default_qdisc = default_qdisc;
		router_state.homePageParams.active_qdisc = active_qdisc;
		router_state.homePageParams.selected_qdisc = selected_qdisc;
		router_state.homePageParams.active_InitcwndInitrwndValue = active_InitcwndInitrwndValue;
		router_state.homePageParams.wifi_calling_state = wifi_calling_state;
	}
}

export function updateHomeUI() {
	if (router_state.isInitializing) {
		return;
	}

	const params = router_state.homePageParams;

	setText('module_status_value', params.module_status);

	if (params.module_status !== 'Enabled ✅') {
		hideElement('active_iface_type_div');
		hideElement('active_iface_div');
		hideElement('tcp_cong_div');
		hideElement('available_tcp_cong_div');
		hideElement('default_qdisc_div');
		hideElement('active_qdisc_div');
		hideElement('selected_qdisc_div');
		hideElement('wifi_calling_value_div');
		hideElement('initcwnd_value_div');
		hideElement('initrwnd_value_div');
		return;
	}

	showElement('active_iface_type_div');
	showElement('active_iface_div');
	showElement('tcp_cong_div');

	setText('active_iface_type_value', params.active_iface_type);
	setText('active_iface_value', params.active_iface);
	setText('tcp_cong_value', params.active_algorithm);

	if (Array.isArray(params.available_algorithms) && params.available_algorithms.length > 0) {
		showElement('available_tcp_cong_div');
		setText('available_tcp_cong_value', params.available_algorithms.join(' '));
	} else {
		hideElement('available_tcp_cong_div');
	}

	if (params.default_qdisc && params.default_qdisc !== 'Unknown ⁉️') {
		showElement('default_qdisc_div');
		setText('default_qdisc_value', params.default_qdisc);
	} else {
		hideElement('default_qdisc_div');
	}

	if (params.active_qdisc && params.active_qdisc !== 'Unknown ⁉️') {
		showElement('active_qdisc_div');
		setText('active_qdisc_value', params.active_qdisc);
	} else {
		hideElement('active_qdisc_div');
	}

	if (params.selected_qdisc && params.selected_qdisc !== 'Unknown ⁉️') {
		showElement('selected_qdisc_div');
		setText('selected_qdisc_value', params.selected_qdisc);
	} else {
		hideElement('selected_qdisc_div');
	}

	if (params.active_iface_type === 'Wi-Fi 🛜') {
		showElement('wifi_calling_value_div');
		setText('wifi_calling_value', params.wifi_calling_state);
	} else {
		hideElement('wifi_calling_value_div');
		setText('wifi_calling_value', 'Unknown ⁉️');
	}

	const values = Array.isArray(params.active_InitcwndInitrwndValue)
		? params.active_InitcwndInitrwndValue
		: [];

	const initcwndInitrwndEnabled = Boolean(
		router_state.settingsPageParams?.initcwndInitrwnd
	);

	const isLoading = values.length < 2 && initcwndInitrwndEnabled;

	if (values.length === 2 || isLoading) {
		showElement('initcwnd_value_div');
		showElement('initrwnd_value_div');

		setText(
			'initcwnd_value',
			values.length === 2 ? values[0] : 'Loading initcwnd value...'
		);

		setText(
			'initrwnd_value',
			values.length === 2 ? values[1] : 'Loading initrwnd value...'
		);
	} else {
		hideElement('initcwnd_value_div');
		hideElement('initrwnd_value_div');
	}
}

export async function initHome() {
	router_state.isInitializing = false;
	updateHomeUI();
}
