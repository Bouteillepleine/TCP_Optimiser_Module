import { updateModuleInformation, fetchIsConfigFile } from './common.js';
import { updateModuleStatus, updateHomeUI } from './home.js';
import { addLog, read_log_file, updateLogsUI } from './logs.js';

const router_state = {
	moduleInformation: null,
	isInitializing: true,

	homePageParams: {
		module_status: 'Loading Module Status...⌛',
		active_iface_type: 'Unknown ⁉️',
		active_iface: 'None',
		active_algorithm: 'Unknown ⁉️',
		available_algorithms: [],
		default_qdisc: 'Unknown ⁉️',
		active_qdisc: 'Unknown ⁉️',
		selected_qdisc: 'Unknown ⁉️',
		active_InitcwndInitrwndValue: [],
		wifi_calling_state: 'Unknown ⁉️'
	},

	settingsPageParams: {
		wlanAlgo: null,
		rmnetAlgo: null,
		wlanQdisc: null,
		rmnetQdisc: null,
		killConnections: null,
		initcwndInitrwnd: null
	},

	logsList: [],
	available_algorithms: [],
	current_active_page: null
};

let currentPageStyle = null;
let realtimeIntervalId = null;
let isLoadingPage = false;
let isRefreshingRuntimeState = false;
let lastRequestedPage = null;

function getElement(id) {
	return document.getElementById(id);
}

function setCSS(pageName) {
	const nextStyle = document.createElement('link');

	nextStyle.rel = 'stylesheet';
	nextStyle.href = `./css/${pageName}.css`;
	nextStyle.dataset.pageStyle = pageName;

	nextStyle.onload = () => {
		if (currentPageStyle && currentPageStyle !== nextStyle) {
			currentPageStyle.remove();
		}

		currentPageStyle = nextStyle;
	};

	nextStyle.onerror = () => {
		console.warn(`Failed to load CSS for page: ${pageName}`);

		if (currentPageStyle && currentPageStyle !== nextStyle) {
			currentPageStyle.remove();
			currentPageStyle = null;
		}
	};

	document.head.appendChild(nextStyle);
}

function setErrorPage(message = '⚠️⚠️⚠️ Error loading page. ⚠️⚠️⚠️') {
	const currentPage = getElement('current-page');

	if (!currentPage) {
		return;
	}

	currentPage.textContent = '';

	const wrapper = document.createElement('div');
	wrapper.style.display = 'flex';
	wrapper.style.justifyContent = 'center';
	wrapper.style.alignItems = 'center';
	wrapper.style.height = '100%';
	wrapper.style.flexDirection = 'column';
	wrapper.style.textAlign = 'center';
	wrapper.style.padding = '16px';

	const paragraph = document.createElement('p');
	paragraph.textContent = message;

	wrapper.appendChild(paragraph);
	currentPage.appendChild(wrapper);
}

async function detectSelectedQdisc(prefix) {
	const qdiscOptions = ['fq_codel', 'fq', 'pfifo_fast'];

	for (const qdisc of qdiscOptions) {
		if (await fetchIsConfigFile(`${prefix}_qdisc_${qdisc}`)) {
			return qdisc;
		}
	}

	return 'fq_codel';
}

async function updateSettingsCache() {
	try {
		if (router_state.settingsPageParams.killConnections === null) {
			router_state.settingsPageParams.killConnections = await fetchIsConfigFile('kill_connections');
		}

		if (router_state.settingsPageParams.initcwndInitrwnd === null) {
			router_state.settingsPageParams.initcwndInitrwnd = await fetchIsConfigFile('initcwnd_initrwnd');
		}

		if (router_state.settingsPageParams.wlanQdisc === null) {
			router_state.settingsPageParams.wlanQdisc = await detectSelectedQdisc('wlan');
		}

		if (router_state.settingsPageParams.rmnetQdisc === null) {
			router_state.settingsPageParams.rmnetQdisc = await detectSelectedQdisc('rmnet_data');
		}
	} catch (error) {
		console.error('Error updating settings cache:', error);
		addLog('Error updating settings cache.');
	}
}

function updateCurrentPageUI() {
	if (!router_state.current_active_page) {
		return;
	}

	switch (router_state.current_active_page) {
		case 'home':
			updateHomeUI();
			break;

		case 'logs':
			updateLogsUI();
			break;

		default:
			break;
	}
}

async function refreshRuntimeState() {
	if (isRefreshingRuntimeState) {
		return;
	}

	isRefreshingRuntimeState = true;

	try {
		await updateModuleStatus();
		await read_log_file();
		await updateSettingsCache();

		updateCurrentPageUI();
	} catch (error) {
		console.error('Error refreshing runtime state:', error);
		addLog('Error refreshing runtime state.');
	} finally {
		isRefreshingRuntimeState = false;
	}
}

function startRealtimeUpdater() {
	if (realtimeIntervalId !== null) {
		return;
	}

	refreshRuntimeState();

	realtimeIntervalId = setInterval(() => {
		refreshRuntimeState();
	}, 5000);
}

async function initPageModule(pageName) {
	const module = await import(`./${pageName}.js`);

	switch (pageName) {
		case 'home':
			if (typeof module.initHome === 'function') {
				await module.initHome();
			}
			break;

		case 'settings':
			if (typeof module.initSettings === 'function') {
				await module.initSettings();
			}
			break;

		case 'logs':
			if (typeof module.initLogs === 'function') {
				await module.initLogs();
			}
			break;

		default:
			break;
	}
}

async function loadPage(pageName) {
	if (!pageName) {
		return;
	}

	lastRequestedPage = pageName;

	if (isLoadingPage) {
		return;
	}

	isLoadingPage = true;

	const currentPage = getElement('current-page');

	if (!currentPage) {
		isLoadingPage = false;
		return;
	}

	try {
		currentPage.classList.remove('active');
		currentPage.style.transition = 'opacity 0.4s ease';

		await new Promise(resolve => setTimeout(resolve, 400));

		if (lastRequestedPage !== pageName) {
			isLoadingPage = false;
			await loadPage(lastRequestedPage);
			return;
		}

		const response = await fetch(`./pages/${pageName}.html`);

		if (!response.ok) {
			throw new Error(`Failed to fetch page "${pageName}": ${response.status}`);
		}

		const html = await response.text();

		router_state.isInitializing = true;
		router_state.current_active_page = pageName;

		currentPage.innerHTML = html;
		setCSS(pageName);

		if (!router_state.moduleInformation) {
			await updateModuleInformation();
		}

		await initPageModule(pageName);

		currentPage.classList.add('active');
		updateCurrentPageUI();
	} catch (error) {
		console.error(`Failed to load page "${pageName}":`, error);
		addLog(`Failed to load page "${pageName}".`);
		setErrorPage();
	} finally {
		isLoadingPage = false;
	}
}

function bindNavigation() {
	const navLinks = document.querySelectorAll('.footer-nav .nav-item');

	navLinks.forEach(link => {
		if (link.dataset.bound === 'true') {
			return;
		}

		link.dataset.bound = 'true';

		link.addEventListener('click', async (event) => {
			event.preventDefault();

			const page = event.currentTarget.dataset.page;

			if (!page || page === router_state.current_active_page) {
				return;
			}

			navLinks.forEach(item => item.classList.remove('active'));
			event.currentTarget.classList.add('active');

			await loadPage(page);
		});
	});
}

function bindExternalLinks() {
	document.querySelectorAll('.external-link[data-value]').forEach(link => {
		if (link.dataset.bound === 'true') {
			return;
		}

		link.dataset.bound = 'true';

		link.addEventListener('click', (event) => {
			event.preventDefault();

			const url = event.currentTarget.dataset.value;

			if (!url || !/^https?:\/\//.test(url)) {
				return;
			}

			window.open(url, '_blank', 'noopener,noreferrer');
		});
	});
}

document.addEventListener('DOMContentLoaded', async () => {
	try {
		bindExternalLinks();
		bindNavigation();

		await loadPage('home');

		startRealtimeUpdater();
	} catch (error) {
		console.error('Router initialization failed:', error);
		addLog('Router initialization failed.');
		setErrorPage();
	}
});

export default router_state;
