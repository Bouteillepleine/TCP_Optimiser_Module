import { exec, toast } from './kernelsu.js';
import { get_active_iface, get_active_algorithm, getInitcwndInitrwndValue } from './common.js';
import router_state from './router.js';

export async function updateModuleStatus () {
	var active_iface = "None";
	var active_iface_type = "Unknown ⁉️"
	var active_algorithm = "Unknown";
	var active_algorithm = "Unknown";
	var active_InitcwndInitrwndValue = [];
	try
	{
		active_iface = await get_active_iface();
		active_iface = active_iface ? active_iface : "None";
		active_iface_type = active_iface.startsWith("rmnet") || active_iface.startsWith("ccmni") ? "Cellular 📶" : active_iface.startsWith("wlan") ? "Wi-Fi 🛜" : "Unknown ⁉️";
		active_algorithm = await get_active_algorithm();
		active_InitcwndInitrwndValue = await getInitcwndInitrwndValue();
	} catch (error) {
		console.error('Error updating status: ', error);
		addLog('Error updating status.');
		toast("Error updating status.");
	} finally {
		router_state.homePageParams.active_iface_type = active_iface_type;
		router_state.homePageParams.active_iface = active_iface;
		router_state.homePageParams.active_algorithm = active_algorithm;
		router_state.homePageParams.active_InitcwndInitrwndValue = active_InitcwndInitrwndValue;
	}
}

export function updateHomeUI () {
	if (router_state.isInitializing == false) {
		document.getElementById('active_iface_type_value').textContent = router_state.homePageParams.active_iface_type;
		document.getElementById('active_iface_value').textContent = router_state.homePageParams.active_iface;
		document.getElementById('tcp_cong_value').textContent = router_state.homePageParams.active_algorithm;
		
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
			// No data and not loading → hide the section
			if (initcwndDiv && !initcwndDiv.classList.contains('hidden'))
				initcwndDiv.classList.add('hidden');
			
			if (initrwndDiv && !initrwndDiv.classList.contains('hidden'))
				initrwndDiv.classList.add('hidden');
		}
	}
}

export async function initHome() {
	router_state.isInitializing = false;
	updateHomeUI();
}
