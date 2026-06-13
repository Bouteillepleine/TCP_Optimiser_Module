import { exec, toast } from './kernelsu.js';
import { formatLocalDateTime } from './common.js';
import router_state from './router.js';

const logHeadingDefaultValue = 'Logs';
const MAX_LOG_LINES = 200;

let prev_logs_count = -1;
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

	return '';
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

export async function addLog(message) {
	if (isAddingInternalLog) {
		addLogToScreen('Error Adding to log file.');
		return;
	}

	isAddingInternalLog = true;

	try {
		const logFile = getLogFile();
		const logLine = `${formatLocalDateTime()} - ${message}`;

		await exec(ensureLogFileCommand());

		await exec(
			`printf '%s\\n' ${shellQuote(logLine)} | tee -a ${shellQuote(logFile)} >/dev/null`
		);

		const result = await exec(
			`wc -l < ${shellQuote(logFile)} 2>/dev/null || echo 0`
		);

		const lineCountOutput = normalizeExecOutput(result);
		const lineCount = parseInt((lineCountOutput || '').trim(), 10) || 0;

		if (lineCount > MAX_LOG_LINES) {
			await exec(
				`tail -n ${MAX_LOG_LINES} ${shellQuote(logFile)} | tee ${shellQuote(`${logFile}.tmp`)} >/dev/null && ` +
				`mv ${shellQuote(`${logFile}.tmp`)} ${shellQuote(logFile)} && ` +
				`chmod 644 ${shellQuote(logFile)}`
			);
		}

		await read_log_file();
		updateLogsUI();
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

		prev_logs_count = -1;
	} catch (error) {
		console.error('Error reading log file:', error);

		router_state.logsList = ['Error reading log file.'];
		prev_logs_count = -1;

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

				await exec(ensureLogFileCommand());

				await exec(
					`printf '' | tee ${shellQuote(logFile)} >/dev/null && ` +
					`chmod 644 ${shellQuote(logFile)} && ` +
					`touch "/dev/.tcp_module_log_cleared" 2>/dev/null || true`
				);

				clearLogContent();
				setLogsHeading(0);

				router_state.logsList = [];
				prev_logs_count = 0;
			} catch (error) {
				console.error('Error clearing log file:', error);
				addLogToScreen('Error clearing log file.');
				toast('Error clearing log file.');
			}
		});
	}

	await read_log_file();

	router_state.isInitializing = false;
	updateLogsUI();
}
