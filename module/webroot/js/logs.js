import { exec, toast } from './kernelsu.js';
import { formatLocalDateTime } from './common.js';
import router_state from './router.js';

const logHeadingDefaultValue = 'Logs';
const MAX_LOG_LINES = 200;

let prev_logs_count = -1;
let prev_logs_content = '';
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

function normalizeExecOutput(result) {
	if (typeof result === 'string') {
		return result;
	}

	if (!result) {
		return '';
	}

	if (typeof result.stdout === 'string') {
		return result.stdout;
	}

	if (typeof result.out === 'string') {
		return result.out;
	}

	if (typeof result.output === 'string') {
		return result.output;
	}

	if (typeof result.result === 'string') {
		return result.result;
	}

	if (typeof result.stderr === 'string' && result.stderr.trim()) {
		return result.stderr;
	}

	try {
		return JSON.stringify(result, null, 2);
	} catch (_) {
		return String(result);
	}
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
		logContent.textContent = '';
	}
}

function ensureLogFileCommand() {
	const moduleDir = getModuleDir();
	const logFile = getLogFile();

	return [
		`mkdir -p ${shellQuote(moduleDir)}`,
		`touch ${shellQuote(logFile)}`,
		`chmod 644 ${shellQuote(logFile)}`
	].join(' && ');
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

export async function addLog(message) {
	if (!message) {
		return;
	}

	if (isAddingInternalLog) {
		addLogToScreen('Error Adding to log file.');
		return;
	}

	isAddingInternalLog = true;

	try {
		const logFile = getLogFile();
		const logLine = `${formatLocalDateTime()} - ${message}`;

		await exec(ensureLogFileCommand());

		/**
		 * Important:
		 * On this device/setup, direct shell append with >> caused:
		 * Permission denied
		 *
		 * tee -a is confirmed working from ADB:
		 * echo test_log_from_adb | su -c 'tee -a ...'
		 */
		await exec(
			`printf '%s\\n' ${shellQuote(logLine)} | tee -a ${shellQuote(logFile)} >/dev/null`
		);

		const countResult = await exec(
			`wc -l < ${shellQuote(logFile)} 2>/dev/null || echo 0`
		);

		const lineCountOutput = normalizeExecOutput(countResult);
		const lineCount = parseInt((lineCountOutput || '').trim(), 10) || 0;

		if (lineCount > MAX_LOG_LINES) {
			await exec(
				`tail -n ${MAX_LOG_LINES} ${shellQuote(logFile)} | tee ${shellQuote(`${logFile}.tmp`)} >/dev/null && ` +
				`mv ${shellQuote(`${logFile}.tmp`)} ${shellQuote(logFile)} && ` +
				`chmod 644 ${shellQuote(logFile)}`
			);
		}

		await read_log_file();

		if (router_state.current_active_page === 'logs') {
			updateLogsUI();
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

		await exec(ensureLogFileCommand());

		const result = await exec(
			`tail -n ${MAX_LOG_LINES} ${shellQuote(logFile)} 2>/dev/null || true`
		);

		const logs = normalizeExecOutput(result);

		router_state.logsList = logs
			.split('\n')
			.map(line => line.trimEnd())
			.filter(line => line.length > 0);

		/**
		 * Force UI refresh after each file read.
		 * This prevents stale display when the number of lines stays the same.
		 */
		prev_logs_count = -1;
		prev_logs_content = '';
	} catch (error) {
		console.error('Error reading log file:', error);

		router_state.logsList = ['Error reading log file.'];
		prev_logs_count = -1;
		prev_logs_content = '';

		toast('Error reading log file.');
	}
}

export function updateLogsUI() {
	if (router_state.isInitializing) {
		return;
	}

	const logs = Array.isArray(router_state.logsList)
		? router_state.logsList
		: [];

	const logsContent = logs.join('\n');

	if (
		logs.length === prev_logs_count &&
		logsContent === prev_logs_content
	) {
		return;
	}

	setLogsHeading(logs.length);
	clearLogContent();

	if (logs.length === 0) {
		addLogToScreen('No logs available yet.');
	} else {
		logs.forEach(log => {
			addLogToScreen(log);
		});
	}

	prev_logs_count = logs.length;
	prev_logs_content = logsContent;
}

export async function clearLogs() {
	try {
		const logFile = getLogFile();

		await exec(ensureLogFileCommand());

		/**
		 * Use tee instead of : > file because redirection can fail
		 * depending on the KernelSU/WebUI shell context.
		 */
		await exec(
			`printf '' | tee ${shellQuote(logFile)} >/dev/null && ` +
			`chmod 644 ${shellQuote(logFile)} && ` +
			`touch "/dev/.tcp_module_log_cleared" 2>/dev/null || true`
		);

		clearLogContent();
		setLogsHeading(0);

		router_state.logsList = [];
		prev_logs_count = -1;
		prev_logs_content = '';

		updateLogsUI();
	} catch (error) {
		console.error('Error clearing log file:', error);

		addLogToScreen('Error clearing log file.');
		toast('Error clearing log file.');
	}
}

function bindLogButtons() {
	const clearLogsBtn = getElement('clear-logs');
	const refreshLogsBtn = getElement('refresh-logs');

	if (clearLogsBtn && !clearLogsBtn.dataset.bound) {
		clearLogsBtn.dataset.bound = 'true';

		clearLogsBtn.addEventListener('click', async () => {
			clearLogsBtn.disabled = true;

			try {
				await clearLogs();
			} finally {
				clearLogsBtn.disabled = false;
			}
		});
	}

	if (refreshLogsBtn && !refreshLogsBtn.dataset.bound) {
		refreshLogsBtn.dataset.bound = 'true';

		refreshLogsBtn.addEventListener('click', async () => {
			refreshLogsBtn.disabled = true;

			try {
				await read_log_file();
				updateLogsUI();
			} finally {
				refreshLogsBtn.disabled = false;
			}
		});
	}
}

export async function initLogs() {
	bindLogButtons();

	await read_log_file();

	router_state.isInitializing = false;
	updateLogsUI();
}
