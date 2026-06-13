import { exec, toast } from './kernelsu.js';
import { formatLocalDateTime } from './common.js';
import router_state from './router.js';

const logHeadingDefaultValue = 'Logs';
const MAX_LOG_LINES = 200;

let prev_logs_count = 0;
let isAddingInternalLog = false;

function getModuleDir() {
	return router_state.moduleInformation?.moduleDir || '/data/adb/modules/tcp_optimiser';
}

function getLogFile() {
	return `${getModuleDir()}/service.log`;
}

function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function getElement(id) {
	return document.getElementById(id);
}

function setLogsHeading(count = 0) {
	const heading = getElement('logs-heading');

	if (!heading) {
		return;
	}

	heading.textContent = `${logHeadingDefaultValue}${count > 0 ? ` (${count})` : ''}`;
}

function clearLogContent() {
	const logContent = getElement('log-content');

	if (logContent) {
		logContent.innerHTML = '';
	}
}

export async function addLog(message) {
	if (isAddingInternalLog) {
		addLogToScreen('Error Adding to log file.');
		return;
	}

	isAddingInternalLog = true;

	try {
		const logFile = getLogFile();
		const logLine = `${formatLocalDateTime()} - ${message}`;

		await exec(`mkdir -p ${shellQuote(getModuleDir())}`);
		await exec(`printf '%s\\n' ${shellQuote(logLine)} >> ${shellQuote(logFile)}`);

		const { stdout: lineCountOutput } = await exec(`wc -l < ${shellQuote(logFile)} 2>/dev/null || echo 0`);
		const lineCount = parseInt(lineCountOutput.trim(), 10) || 0;

		if (lineCount > MAX_LOG_LINES) {
			const halfLines = Math.floor(MAX_LOG_LINES / 2);
			await exec(`tail -n ${halfLines} ${shellQuote(logFile)} > ${shellQuote(`${logFile}.tmp`)} && mv ${shellQuote(`${logFile}.tmp`)} ${shellQuote(logFile)}`);
		}
	} catch (error) {
		console.error('Error adding to log file:', error);
		addLogToScreen('Error Adding to log file.');
		toast('Error Adding to log file.');
	} finally {
		isAddingInternalLog = false;
	}
}

export async function read_log_file() {
	try {
		const logFile = getLogFile();

		const { stdout: logs } = await exec(`[ -f ${shellQuote(logFile)} ] && cat ${shellQuote(logFile)} || true`);

		router_state.logsList = logs
			.trim()
			.split('\n')
			.filter(line => line.length > 0);
	} catch (error) {
		console.error('Error reading log file:', error);

		addLogToScreen('Error reading log file.');

		try {
			await addLog('Error reading log file.');
		} catch (_) {}

		toast('Error reading log file.');
	}
}

function addLogToScreen(message, withTimestamp = false) {
	const logContent = getElement('log-content');

	if (!logContent) {
		return;
	}

	const logEntry = document.createElement('div');
	logEntry.textContent = withTimestamp
		? `${formatLocalDateTime()} - ${message}`
		: `${message}`;

	logContent.appendChild(logEntry);
	logContent.scrollTop = logContent.scrollHeight;
}

export function updateLogsUI() {
	if (router_state.isInitializing) {
		return;
	}

	const logs = Array.isArray(router_state.logsList)
		? router_state.logsList
		: [];

	if (logs.length === prev_logs_count) {
		return;
	}

	setLogsHeading(logs.length);
	clearLogContent();

	logs.forEach(log => {
		addLogToScreen(log);
	});

	prev_logs_count = logs.length;
}

export async function initLogs() {
	const clearLogsBtn = getElement('clear-logs');

	if (clearLogsBtn && !clearLogsBtn.dataset.bound) {
		clearLogsBtn.dataset.bound = 'true';

		clearLogsBtn.addEventListener('click', async () => {
			try {
				const logFile = getLogFile();

				await exec(`rm -f ${shellQuote(logFile)}`);

				clearLogContent();
				setLogsHeading(0);

				router_state.logsList = [];
				prev_logs_count = 0;

				await exec(`touch "/dev/.tcp_module_log_cleared" 2>/dev/null || true`);
			} catch (error) {
				console.error('Error clearing log file:', error);
				addLogToScreen('Error clearing log file.');
				toast('Error clearing log file.');
			}
		});
	}

	router_state.isInitializing = false;
	updateLogsUI();
}
