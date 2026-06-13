import { exec, toast } from './kernelsu.js';
import router_state from './router.js';
import { addLog } from './logs.js';
import { fetchIsConfigFile } from './common.js';

const MODULE_FALLBACK_DIR = '/data/adb/modules/tcp_optimiser';

function getModuleDir() {
	return router_state.moduleInformation?.moduleDir || MODULE_FALLBACK_DIR;
}

function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function isValidAlgorithmName(algo) {
	return /^[A-Za-z0-9_-]+$/.test(String(algo || ''));
}

function getDefaultAlgorithm(options) {
	if (options.includes('bbrv3')) {
		return 'bbrv3';
	}

	if (options.includes('bbr')) {
		return 'bbr';
	}

	if (options.includes('cubic')) {
		return 'cubic';
	}

	return options[0] || '';
}

function getSettingsAlgoKey(prefix) {
	switch (prefix) {
		case 'wlan':
			return 'wlanAlgo';

		case 'rmnet_data':
			return 'rmnetAlgo';

		default:
			return null;
	}
}

async function getSelectedAlgorithm(prefix) {
	const key = getSettingsAlgoKey(prefix);

	if (!key) {
		return null;
	}

	try {
		const moduleDir = getModuleDir();

		const { stdout } = await exec(
			`find ${shellQuote(moduleDir)} -maxdepth 1 -type f -name ${shellQuote(`${prefix}_*`)} ` +
			`| sed 's|.*/||' | head -n1 | sed 's/^${prefix}_//'`
		);

		const algo = stdout.trim();

		router_state.settingsPageParams[key] = algo || null;
		return router_state.settingsPageParams[key];
	} catch (error) {
		console.error('Error fetching selected algorithm:', error);
		addLog(`Error fetching selected algorithm for ${prefix}.`);
		toast('Error fetching congestion control algorithm.');
		return null;
	}
}

async function checkAndGetPrefixValueExists(prefix) {
	const key = getSettingsAlgoKey(prefix);

	if (!key) {
		return null;
	}

	if (router_state.settingsPageParams[key] === null) {
		return await getSelectedAlgorithm(prefix);
	}

	return router_state.settingsPageParams[key];
}

async function populateDropdown(dropdown, options, prefix) {
	if (!dropdown) {
		return;
	}

	dropdown.innerHTML = '';

	const safeOptions = Array.isArray(options)
		? options.filter(isValidAlgorithmName)
		: [];

	let selectedAlgorithm = await checkAndGetPrefixValueExists(prefix);

	if (!safeOptions.includes(selectedAlgorithm)) {
		selectedAlgorithm = getDefaultAlgorithm(safeOptions);
	}

	safeOptions.forEach(option => {
		const optionElement = document.createElement('option');

		optionElement.textContent = option;
		optionElement.value = option;

		dropdown.appendChild(optionElement);
	});

	dropdown.value = selectedAlgorithm;
}

const fetchAvailableAlgorithms = async (force = false) => {
	try {
		if (router_state.available_algorithms.length === 0 || force) {
			const { stdout } = await exec(
				'cat /proc/sys/net/ipv4/tcp_available_congestion_control 2>/dev/null'
			);

			const algorithms = stdout
				.trim()
				.split(/\s+/)
				.filter(isValidAlgorithmName);

			router_state.available_algorithms = algorithms;

			if (algorithms.length === 0) {
				addLog('No congestion control algorithms found.');
				toast('No congestion control algorithms found.');
			}
		}
	} catch (error) {
		console.error('Error fetching algorithms:', error);
		addLog('Error fetching congestion control algorithms.');
		toast('Error fetching congestion control algorithms.');
	}
};

async function ensureSettingsCache() {
	if (router_state.settingsPageParams.killConnections === null) {
		router_state.settingsPageParams.killConnections = await fetchIsConfigFile('kill_connections');
	}

	if (router_state.settingsPageParams.initcwndInitrwnd === null) {
		router_state.settingsPageParams.initcwndInitrwnd = await fetchIsConfigFile('initcwnd_initrwnd');
	}
}

async function applySettings(elements) {
	const {
		wifiAlgo,
		cellularAlgo,
		killConnections,
		initcwndInitrwnd,
		applyBtn,
		forceApplyBtn
	} = elements;

	const settings = {
		wlanAlgorithm: wifiAlgo?.value || '',
		rmnetAlgorithm: cellularAlgo?.value || '',
		killOnChange: Boolean(killConnections?.checked),
		setInitcwndInitrwndOnChange: Boolean(initcwndInitrwnd?.checked)
	};

	if (
		!isValidAlgorithmName(settings.wlanAlgorithm) ||
		!isValidAlgorithmName(settings.rmnetAlgorithm)
	) {
		toast('Invalid algorithm selected.');
		addLog('Invalid algorithm selected in settings.');
		return 1;
	}

	if (
		!router_state.available_algorithms.includes(settings.wlanAlgorithm) ||
		!router_state.available_algorithms.includes(settings.rmnetAlgorithm)
	) {
		toast('Selected algorithm is not available on this kernel.');
		addLog('Selected algorithm is not available on this kernel.');
		return 1;
	}

	try {
		const moduleDir = getModuleDir();

		if (applyBtn) {
			applyBtn.disabled = true;
		}

		if (forceApplyBtn) {
			forceApplyBtn.disabled = true;
		}

		await exec(`mkdir -p ${shellQuote(moduleDir)}`);

		await exec(`rm -f ${shellQuote(`${moduleDir}/wlan_*`)} ${shellQuote(`${moduleDir}/rmnet_data_*`)}`);
		await exec(`rm -f ${shellQuote(`${moduleDir}/kill_connections`)} ${shellQuote(`${moduleDir}/initcwnd_initrwnd`)}`);

		await exec(
			`touch ${shellQuote(`${moduleDir}/wlan_${settings.wlanAlgorithm}`)} && ` +
			`chmod 644 ${shellQuote(`${moduleDir}/wlan_${settings.wlanAlgorithm}`)}`
		);

		await exec(
			`touch ${shellQuote(`${moduleDir}/rmnet_data_${settings.rmnetAlgorithm}`)} && ` +
			`chmod 644 ${shellQuote(`${moduleDir}/rmnet_data_${settings.rmnetAlgorithm}`)}`
		);

		if (settings.killOnChange) {
			await exec(
				`touch ${shellQuote(`${moduleDir}/kill_connections`)} && ` +
				`chmod 644 ${shellQuote(`${moduleDir}/kill_connections`)}`
			);
		}

		if (settings.setInitcwndInitrwndOnChange) {
			await exec(
				`touch ${shellQuote(`${moduleDir}/initcwnd_initrwnd`)} && ` +
				`chmod 644 ${shellQuote(`${moduleDir}/initcwnd_initrwnd`)}`
			);
		}

		router_state.settingsPageParams.wlanAlgo = settings.wlanAlgorithm;
		router_state.settingsPageParams.rmnetAlgo = settings.rmnetAlgorithm;
		router_state.settingsPageParams.killConnections = settings.killOnChange;
		router_state.settingsPageParams.initcwndInitrwnd = settings.setInitcwndInitrwndOnChange;

		console.log('Applied settings:', settings);

		addLog(
			`Applying settings: WiFi=${settings.wlanAlgorithm}, ` +
			`Cellular=${settings.rmnetAlgorithm}, ` +
			`Kill=${settings.killOnChange}, ` +
			`initcwnd_initrwnd=${settings.setInitcwndInitrwndOnChange}`
		);

		toast('Settings Applied Successfully!');
		return 0;
	} catch (error) {
		console.error('Error applying settings:', error);
		addLog('Error applying settings.');
		toast('Error applying settings.');
		return 1;
	} finally {
		if (applyBtn) {
			applyBtn.disabled = false;
		}

		if (forceApplyBtn) {
			forceApplyBtn.disabled = false;
		}
	}
}

function bindCollapsibles() {
	document.querySelectorAll('.collapsible-header').forEach(header => {
		if (header.dataset.bound === 'true') {
			return;
		}

		header.dataset.bound = 'true';

		const content = header.nextElementSibling;
		const arrow = header.querySelector('.arrow');

		if (!content) {
			return;
		}

		content.classList.add('collapsed');
		content.style.maxHeight = '0';

		header.addEventListener('click', () => {
			const isCollapsed = content.classList.contains('collapsed');

			if (isCollapsed) {
				content.classList.remove('collapsed');
				content.style.maxHeight = `${content.scrollHeight}px`;
				header.classList.add('active');

				if (arrow) {
					arrow.classList.add('rotated');
				}
			} else {
				content.style.maxHeight = '0';
				content.classList.add('collapsed');
				header.classList.remove('active');

				if (arrow) {
					arrow.classList.remove('rotated');
				}
			}
		});
	});
}

export async function initSettings() {
	const elements = {
		wifiAlgo: document.getElementById('wifi-algo'),
		cellularAlgo: document.getElementById('cellular-algo'),
		killConnections: document.getElementById('kill-connections'),
		initcwndInitrwnd: document.getElementById('initcwnd-initrwnd'),
		applyBtn: document.getElementById('apply'),
		forceApplyBtn: document.getElementById('force-apply')
	};

	try {
		await fetchAvailableAlgorithms();
		await ensureSettingsCache();

		await populateDropdown(elements.wifiAlgo, router_state.available_algorithms, 'wlan');
		await populateDropdown(elements.cellularAlgo, router_state.available_algorithms, 'rmnet_data');

		if (elements.killConnections) {
			elements.killConnections.checked = Boolean(router_state.settingsPageParams.killConnections);
		}

		if (elements.initcwndInitrwnd) {
			elements.initcwndInitrwnd.checked = Boolean(router_state.settingsPageParams.initcwndInitrwnd);
		}

		if (elements.applyBtn && elements.applyBtn.dataset.bound !== 'true') {
			elements.applyBtn.dataset.bound = 'true';

			elements.applyBtn.addEventListener('click', async () => {
				const result = await applySettings(elements);

				if (result === 0) {
					toast('Turn off and on connection to apply settings.');
				}
			});
		}

		if (elements.forceApplyBtn && elements.forceApplyBtn.dataset.bound !== 'true') {
			elements.forceApplyBtn.dataset.bound = 'true';

			elements.forceApplyBtn.addEventListener('click', async () => {
				const result = await applySettings(elements);

				if (result === 0) {
					try {
						const moduleDir = getModuleDir();

						await exec(
							`touch ${shellQuote(`${moduleDir}/force_apply`)} && ` +
							`chmod 644 ${shellQuote(`${moduleDir}/force_apply`)}`
						);

						toast('Wait for 5s to reflect changes!');
						addLog('Force apply requested from WebUI.');
					} catch (error) {
						console.error('Error creating force_apply marker:', error);
						addLog('Error creating force_apply marker.');
						toast('Error requesting force apply.');
					}
				}
			});
		}

		bindCollapsibles();
	} catch (error) {
		console.error('Error initializing settings:', error);
		addLog('Error initializing settings page.');
		toast('Error initializing settings page.');
	} finally {
		router_state.isInitializing = false;
	}
}
