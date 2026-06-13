let callbackCounter = 0;

function getUniqueCallbackName(prefix) {
	return `${prefix}_callback_${Date.now()}_${callbackCounter++}`;
}

function hasKsuApi(method) {
	return typeof window !== 'undefined' &&
		typeof window.ksu !== 'undefined' &&
		typeof window.ksu[method] === 'function';
}

function safeJsonStringify(value, fallback = '{}') {
	try {
		return JSON.stringify(value);
	} catch (_) {
		return fallback;
	}
}

function normalizeResult(errno, stdout = '', stderr = '') {
	return {
		errno: Number(errno),
		stdout: String(stdout ?? ''),
		stderr: String(stderr ?? '')
	};
}

export function exec(command, options = {}) {
	return new Promise((resolve, reject) => {
		if (!hasKsuApi('exec')) {
			reject(new Error('KernelSU exec API is not available.'));
			return;
		}

		const callbackFuncName = getUniqueCallbackName('exec');

		function cleanup() {
			try {
				delete window[callbackFuncName];
			} catch (_) {
				window[callbackFuncName] = undefined;
			}
		}

		window[callbackFuncName] = (errno, stdout = '', stderr = '') => {
			cleanup();

			const result = normalizeResult(errno, stdout, stderr);

			if (result.errno !== 0) {
				const error = new Error(result.stderr || `Command failed with errno ${result.errno}`);
				error.result = result;
				reject(error);
				return;
			}

			resolve(result);
		};

		try {
			window.ksu.exec(
				String(command),
				safeJsonStringify(options),
				callbackFuncName
			);
		} catch (error) {
			cleanup();
			reject(error);
		}
	});
}

function Stdio() {
	this.listeners = {};
}

Stdio.prototype.on = function (event, listener) {
	if (!this.listeners[event]) {
		this.listeners[event] = [];
	}

	this.listeners[event].push(listener);
	return this;
};

Stdio.prototype.off = function (event, listener) {
	if (!this.listeners[event]) {
		return this;
	}

	this.listeners[event] = this.listeners[event].filter(item => item !== listener);
	return this;
};

Stdio.prototype.emit = function (event, ...args) {
	if (!this.listeners[event]) {
		return;
	}

	this.listeners[event].forEach((listener) => {
		try {
			listener(...args);
		} catch (error) {
			console.error(`Stdio listener error for "${event}":`, error);
		}
	});
};

function ChildProcess() {
	this.listeners = {};
	this.stdin = new Stdio();
	this.stdout = new Stdio();
	this.stderr = new Stdio();
	this.killed = false;
	this.exitCode = null;
}

ChildProcess.prototype.on = function (event, listener) {
	if (!this.listeners[event]) {
		this.listeners[event] = [];
	}

	this.listeners[event].push(listener);
	return this;
};

ChildProcess.prototype.off = function (event, listener) {
	if (!this.listeners[event]) {
		return this;
	}

	this.listeners[event] = this.listeners[event].filter(item => item !== listener);
	return this;
};

ChildProcess.prototype.emit = function (event, ...args) {
	if (!this.listeners[event]) {
		return;
	}

	this.listeners[event].forEach((listener) => {
		try {
			listener(...args);
		} catch (error) {
			console.error(`ChildProcess listener error for "${event}":`, error);
		}
	});
};

ChildProcess.prototype.kill = function () {
	this.killed = true;
	this.emit('exit', this.exitCode ?? 1);
	return true;
};

function dispatchSpawnEvent(child, event, payload) {
	switch (event) {
		case 'stdout':
		case 'data':
			child.stdout.emit('data', String(payload ?? ''));
			break;

		case 'stderr':
			child.stderr.emit('data', String(payload ?? ''));
			break;

		case 'error':
			child.emit('error', payload instanceof Error ? payload : new Error(String(payload || 'Spawn error')));
			break;

		case 'exit':
		case 'close': {
			const code = Number(payload ?? 0);
			child.exitCode = code;
			child.emit('exit', code);
			child.emit('close', code);
			break;
		}

		default:
			child.emit(event, payload);
			break;
	}
}

export function spawn(command, args = [], options = {}) {
	if (!Array.isArray(args)) {
		options = args || {};
		args = [];
	}

	const child = new ChildProcess();

	if (!hasKsuApi('spawn')) {
		setTimeout(() => {
			child.emit('error', new Error('KernelSU spawn API is not available.'));
			child.emit('exit', 1);
		}, 0);

		return child;
	}

	const childCallbackName = getUniqueCallbackName('spawn');

	function cleanup() {
		try {
			delete window[childCallbackName];
		} catch (_) {
			window[childCallbackName] = undefined;
		}
	}

	window[childCallbackName] = (...callbackArgs) => {
		/*
		 * Supports common callback formats:
		 * 1. callback("stdout", "text")
		 * 2. callback({ event: "stdout", data: "text" })
		 * 3. callback("exit", 0)
		 */
		let event = callbackArgs[0];
		let payload = callbackArgs[1];

		if (event && typeof event === 'object') {
			payload = event.data ?? event.payload ?? event.stdout ?? event.stderr ?? event.code;
			event = event.event ?? event.type;
		}

		dispatchSpawnEvent(child, event, payload);

		if (event === 'exit' || event === 'close') {
			cleanup();
		}
	};

	child.on('exit', () => {
		cleanup();
	});

	try {
		window.ksu.spawn(
			String(command),
			safeJsonStringify(args, '[]'),
			safeJsonStringify(options),
			childCallbackName
		);
	} catch (error) {
		child.emit('error', error);
		child.emit('exit', 1);
		cleanup();
	}

	return child;
}

export function fullScreen(isFullScreen) {
	if (!hasKsuApi('fullScreen')) {
		console.warn('KernelSU fullScreen API is not available.');
		return;
	}

	window.ksu.fullScreen(Boolean(isFullScreen));
}

export function toast(message) {
	if (!hasKsuApi('toast')) {
		console.warn('KernelSU toast API is not available:', message);
		return;
	}

	window.ksu.toast(String(message));
}

export function moduleInfo() {
	if (!hasKsuApi('moduleInfo')) {
		console.warn('KernelSU moduleInfo API is not available.');
		return '{}';
	}

	try {
		return window.ksu.moduleInfo();
	} catch (error) {
		console.error('KernelSU moduleInfo error:', error);
		return '{}';
	}
}
