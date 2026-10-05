/**
 * dsh-TaskCompletedNotification-plugin - Host half.
 *
 * Pops one Windows notification when DeepSeek Harness needs the user back:
 *
 *   - a turn finished  (`turn/end` with reason `completed`, root sessions only)
 *   - the model asked the user to choose (`user-questions/request`)
 *   - the model requested approval (`approval/request`)
 *
 * Design notes that matter for stability:
 *
 *   - Every extension point is a plain `ctx.on` listener. The two `request`
 *     events are waterfalls, so this plugin is a pure observer: it *always*
 *     calls `next()` and never returns an outcome, so it cannot make an
 *     approval or a question fail.
 *   - Listeners are registered on the *service root* (`ctx.root`) when that is
 *     a different context, and with `{ global: true }`. Both are load-bearing:
 *     `user-questions/request` and `approval/request` are dispatched through
 *     `scopeTarget(agent, agent)`, a filtered carrier that admits only
 *     listeners on the dispatching agent's scope chain, and a plugin context
 *     that is not on that chain is silently filtered out. `global` skips the
 *     context filter (`cordis/src/events.ts`, `dispatch()`).
 *   - Turn completion is read from the session log (`turn/end`), not from
 *     polling `agent/status`, because the log is the only source of truth.
 *   - Subagent sessions (`header.origin === 'subagent'`) are ignored: the user
 *     asked about the Harness itself, not about a background child.
 *   - The Windows toast itself lives in `notify.ps1` and is invoked through
 *     `node:child_process` with `stdio: 'ignore'`, so nothing here depends on
 *     the Host's subprocess service.
 *   - Nothing is required for the plugin to load: no injected services, no
 *     imports from `@deepseek-ai/*` (a profile-installed plugin cannot resolve
 *     them). Optional services are read through `ctx.get`.
 */

import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Loader identity for this plugin row; mirrors `package.json`'s `name`. */
export const name = 'dsh-TaskCompletedNotification-plugin';

/** No hard service dependency: a headless profile must still activate. */
export const inject = [];

/** Which events raise a toast, and how noisy each one is. */
const DEFAULT_CONFIG = {
	enabled: true,
	notifyOnTurnEnd: true,
	notifyOnQuestion: true,
	notifyOnApproval: true,
	/** `0` = no short-turn filter; every completed turn is reported. */
	minTurnMs: 0,
	/**
	 * `0` = always report a completed turn, even while the user is typing.
	 *
	 * A non-zero value is "don't disturb me, I am looking at the screen": when
	 * the keyboard or mouse moved this recently, the completion toast is
	 * skipped. That gate is what made ordinary Q&A turns look like "no popup",
	 * so the shipped default keeps it off; set e.g. `15000` to re-enable it.
	 */
	quietWhenActiveMs: 0,
	/**
	 * One notification per turn, chosen by nature:
	 *   - the turn asked the user something or requested approval
	 *     -> only `任务操作待确认` (the ask itself already toasted)
	 *   - the turn finished without asking anything
	 *     -> `任务完成`
	 * Set to `false` to also get the completion toast after an ask (two popups
	 * for the same turn).
	 */
	suppressTurnEndAfterAsk: true,
	title: 'DeepSeek Harness',
	/**
	 * AppUserModelID the toast is shown under.
	 *
	 * `CreateToastNotifier()` takes no-argument form throws under Windows
	 * PowerShell 5.1 (0x80070490), so an id is always passed. An *unregistered*
	 * id makes Windows fall back to showing the host executable's identity
	 * ("Windows PowerShell"); registering the id (see `registerAppId`) is what
	 * makes the toast read "DeepSeek Harness". The PowerShell id stays
	 * available as an escape hatch.
	 */
	appId: 'DeepSeek.Harness.Notify',
	/** Register `appId` under HKCU so Windows shows our name and icon. */
	registerAppId: true,
	/** Clicking the notification banner raises the DeepSeek Harness window. */
	focusOnClick: true,
	/** Icon for the registered id; `''` auto-detects the Harness icon. */
	icon: '',
	timeoutMs: 15000,
	maxConcurrent: 3,
	log: true,
	probe: false
};

/** The escape hatch `appId` when branding is unwanted. */
const POWERSHELL_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

const LOG_LIMIT_BYTES = 256 * 1024;
/** Character budget for the answer preview kept in the diagnostic log. */
const PREVIEW_CHARS = 160;
const ELLIPSIS = '\u2026';

/**
 * Fixed body headlines.
 *
 * The toast title is always the plain application name (`config.title`), and
 * the first body line says what kind of attention is wanted:
 *   - a turn finished                      -> BODY_TURN_END
 *   - the model needs a decision/approval  -> BODY_CONFIRM
 * The rest of the body stays contextual (workspace, elapsed time, token count,
 * answer preview, question text, tool, reason).
 */
const BODY_TURN_END = '\u4efb\u52a1\u5b8c\u6210';
const BODY_CONFIRM = '\u4efb\u52a1\u64cd\u4f5c\u5f85\u786e\u8ba4';

/**
 * URL scheme a clicked toast launches, registered under HKCU:
 * `HKCU\Software\Classes\<ACTIVATION_PROTOCOL>\shell\open\command`.
 */
const ACTIVATION_PROTOCOL = 'dsh-TaskCompletedNotification-plugin';
const PROTOCOL_LAUNCH = `${ACTIVATION_PROTOCOL}://focus`;

/** Override for debugging: names the PowerShell executable to use. */
const PS_ENV = 'DSH_TASK_COMPLETED_NOTIFICATION_PS';

/** Read a boolean-ish config value without throwing on a hand-edited patch. */
function boolAt(config, key) {
	if (config === null || typeof config !== 'object') return DEFAULT_CONFIG[key];
	return typeof config[key] === 'boolean' ? config[key] : DEFAULT_CONFIG[key];
}

/** Read a finite number config value, clamped to `[min, max]`. */
function numberAt(config, key, min, max) {
	if (config === null || typeof config !== 'object') return DEFAULT_CONFIG[key];
	const raw = config[key];
	if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_CONFIG[key];
	return Math.min(max, Math.max(min, raw));
}

/** Read a non-empty string config value. */
function stringAt(config, key) {
	if (config === null || typeof config !== 'object') return DEFAULT_CONFIG[key];
	const raw = config[key];
	return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : DEFAULT_CONFIG[key];
}

/** Normalize the row's `config` into the exact values the runtime uses. */
export function normalizeConfig(config) {
	return {
		enabled: boolAt(config, 'enabled'),
		notifyOnTurnEnd: boolAt(config, 'notifyOnTurnEnd'),
		notifyOnQuestion: boolAt(config, 'notifyOnQuestion'),
		notifyOnApproval: boolAt(config, 'notifyOnApproval'),
		suppressTurnEndAfterAsk: boolAt(config, 'suppressTurnEndAfterAsk'),
		minTurnMs: numberAt(config, 'minTurnMs', 0, 3600000),
		quietWhenActiveMs: numberAt(config, 'quietWhenActiveMs', 0, 3600000),
		title: stringAt(config, 'title'),
		appId: stringAt(config, 'appId'),
		registerAppId: boolAt(config, 'registerAppId'),
		focusOnClick: boolAt(config, 'focusOnClick'),
		icon: typeof config === 'object' && config !== null && typeof config.icon === 'string' ? config.icon.trim() : DEFAULT_CONFIG.icon,
		timeoutMs: numberAt(config, 'timeoutMs', 1000, 120000),
		maxConcurrent: numberAt(config, 'maxConcurrent', 1, 16),
		log: boolAt(config, 'log'),
		probe: boolAt(config, 'probe')
	};
}

/** Collapse whitespace and cut a text block to a notification-sized preview. */
export function preview(text, limit = PREVIEW_CHARS) {
	const flat = String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim();
	if (flat.length <= limit) return flat;
	return Array.from(flat).slice(0, limit - 1).join('') + ELLIPSIS;
}

/** Join the text blocks of a message, ignoring tool calls and reasoning. */
function textOfMessage(message) {
	if (message === null || typeof message !== 'object') return '';
	if (!Array.isArray(message.content)) return '';
	const parts = [];
	for (const block of message.content) {
		if (block === null || typeof block !== 'object') continue;
		if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
	}
	return parts.join('\n').trim();
}

/** `C:\\work\\project` -> `project`; an unset cwd is reported as an empty string. */
export function workspaceLabel(cwd) {
	if (typeof cwd !== 'string' || cwd.length === 0) return '';
	const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]+/);
	return parts[parts.length - 1] || cwd;
}

/** Human-readable elapsed time for a finished turn. */
export function humanDuration(ms) {
	if (!Number.isFinite(ms) || ms < 0) return '';
	const seconds = Math.round(ms / 1000);
	const secondsUnit = '\u79d2';
	const minutesUnit = '\u5206\u949f';
	const minutesShort = '\u5206';
	const hoursUnit = '\u5c0f\u65f6';
	if (seconds < 60) return `${seconds} ${secondsUnit}`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (minutes < 60) return rest === 0 ? `${minutes} ${minutesUnit}` : `${minutes} ${minutesShort} ${rest} ${secondsUnit}`;
	const hours = Math.floor(minutes / 60);
	return `${hours} ${hoursUnit} ${minutes % 60} ${minutesShort}`;
}

/** The `$DSH_HOME/dsh-TaskCompletedNotification-plugin` directory, or `undefined` when logging is off. */
function dataDir() {
	const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim().length > 0
		? process.env.DSH_HOME.trim()
		: join(homedir(), '.dsh');
	return join(home, 'dsh-TaskCompletedNotification-plugin');
}

/** Append one NDJSON diagnostic line, rotating the file once it grows. */
function makeLogger(enabled) {
	if (!enabled) return () => {};
	let path;
	try {
		const dir = dataDir();
		mkdirSync(dir, { recursive: true });
		path = join(dir, 'log.ndjson');
	} catch {
		return () => {};
	}
	return (level, message, extra) => {
		try {
			const info = statSync(path, { throwIfNoEntry: false });
			if (info !== undefined && info !== null && info.size > LOG_LIMIT_BYTES) writeFileSync(path, '', 'utf8');
			appendFileSync(path, `${JSON.stringify({ ts: Date.now(), level, message, ...(extra === undefined ? {} : { extra }) })}\n`, 'utf8');
		} catch {
			/* diagnostics must never break a notification */
		}
	};
}

/** The plugin's own directory, used to locate `notify.ps1`. */
export function packageRoot() {
	return dirname(dirname(fileURLToPath(import.meta.url)));
}

/** Absolute path of the PowerShell helper shipped beside this module. */
export function scriptPath() {
	return join(packageRoot(), 'lib', 'notify.ps1');
}

/** PowerShell executable: env override first, then the system one. */
export function powershellPath(configured) {
	const override = typeof configured === 'string' && configured.trim().length > 0
		? configured.trim()
		: (typeof process.env[PS_ENV] === 'string' && process.env[PS_ENV].trim().length > 0 ? process.env[PS_ENV].trim() : '');
	if (override.length > 0) return override;
	const root = typeof process.env.SystemRoot === 'string' && process.env.SystemRoot.length > 0
		? process.env.SystemRoot
		: 'C:\\Windows';
	return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** True for a session that is a live child of another agent. */
export function isSubagentSession(session) {
	const header = session === null || session === undefined ? undefined : session.header;
	if (header === null || header === undefined) return false;
	if (header.origin === 'subagent') return true;
	return typeof header.parentSession === 'string' && header.parentSession.length > 0;
}

/**
 * Autodetect the Harness application icon.
 *
 * The hard case is a profile-installed plugin whose `node_modules` entry is a
 * symlink or junction into a workspace (this deployment): the real path then
 * has no relation to the install root at all, so walking up cannot find it.
 * The Host process still knows where it lives, so every self-describing
 * argument/environment value is mined for an `app.asar` or resource path, and
 * a few conventional install locations are probed as a fallback.
 *
 * Returns `''` when nothing is found; the caller can pass `icon` explicitly.
 */
export function harnessIconPath() {
	const candidates = [];
	const push = (value) => {
		if (typeof value === 'string' && value.trim().length > 0) candidates.push(value.trim());
	};
	push(process.env.DSH_TASK_COMPLETED_NOTIFICATION_ICON);
	if (typeof process.env.DSH_INSTALL_DIR === 'string' && process.env.DSH_INSTALL_DIR.trim().length > 0) {
		push(join(process.env.DSH_INSTALL_DIR.trim(), 'resources', 'icon.png'));
	}
	// `dsh-desktop-host` is launched as `<exe> <app.asar>/dsh <profileDir> ...`,
	// so argv carries the installation root.
	for (const arg of process.argv) {
		if (typeof arg !== 'string') continue;
		const at = arg.toLowerCase().indexOf('app.asar');
		if (at < 0) continue;
		const root = arg.slice(0, at);
		push(join(root, 'resources', 'icon.png'));
		push(join(root, 'app.asar.unpacked', 'resources', 'icon.png'));
	}
	// Conventional Windows package locations.
	for (const drive of ['C:', 'D:', 'E:', 'F:']) {
		push(join(`${drive}\\`, 'Program Files', 'DeepSeek Harness', 'resources', 'icon.png'));
		push(join(`${drive}\\`, 'software', 'dsh', 'resources', 'icon.png'));
		push(join(`${drive}\\`, 'Program Files', 'dsh', 'resources', 'icon.png'));
	}
	// Walk up from the plugin, which covers a non-symlinked profile install.
	const bases = [packageRoot(), dirname(fileURLToPath(import.meta.url))];
	for (const base of bases) {
		let dir = base;
		for (let depth = 0; depth < 6; depth++) {
			candidates.push(join(dir, 'resources', 'icon.png'));
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	for (const candidate of candidates) {
		try {
			if (existsSync(candidate)) return candidate;
		} catch {
			/* keep looking */
		}
	}
	return '';
}

/**
 * Make Windows attribute the toast to this application: write the
 * `AppUserModelId` registration Windows needs to resolve an id to a display
 * name and icon, so the notification header reads "DeepSeek Harness" with the
 * Harness icon instead of falling back to the host executable's identity.
 *
 * Without this key the id still works, but Windows shows "Windows PowerShell".
 * The key doubles as the plugin's own storage for the click handler path.
 *
 * @param appId - the AppUserModelID to register.
 * @param icon - explicit icon path, or `''` to autodetect.
 * @param displayName - name Windows shows as the notification sender.
 * @param libDir - directory holding the click handler; registered as `DshWinNotifyLibDir`.
 * @param log - diagnostic sink.
 * @returns `{ appId, icon, written, skipped, reason }`.
 */
export function ensureBrand(appId, icon, displayName, libDir, log = () => {}) {
	const result = { appId, icon: '', written: false, skipped: false, reason: undefined };
	const name = typeof displayName === 'string' && displayName.trim().length > 0 ? displayName.trim() : DEFAULT_CONFIG.title;
	if (process.platform !== 'win32') {
		result.skipped = true;
		result.reason = 'not-windows';
		return result;
	}
	if (typeof appId !== 'string' || appId.trim().length === 0) {
		result.skipped = true;
		result.reason = 'no-app-id';
		return result;
	}
	const resolvedIcon = typeof icon === 'string' && icon.trim().length > 0 ? icon.trim() : harnessIconPath();
	result.icon = resolvedIcon;
	const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
	const script = [
		`$key = 'HKCU:\\Software\\Classes\\AppUserModelId\\' + ${psQuote(appId)}`,
		'if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }',
		`New-ItemProperty -Path $key -Name 'DisplayName' -Value ${psQuote(name)} -PropertyType String -Force | Out-Null`,
		resolvedIcon.length > 0
			? `New-ItemProperty -Path $key -Name 'IconUri' -Value ${psQuote(resolvedIcon)} -PropertyType String -Force | Out-Null`
			: '$null',
		typeof libDir === 'string' && libDir.trim().length > 0
			? `New-ItemProperty -Path $key -Name 'DshWinNotifyLibDir' -Value ${psQuote(libDir.trim())} -PropertyType String -Force | Out-Null`
			: '$null',
		"Write-Output 'ok'"
	].join('; ');
	try {
		execFileSync(powershellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
			stdio: 'ignore',
			windowsHide: true,
			timeout: 15000
		});
		result.written = true;
		log('info', 'dsh-TaskCompletedNotification-plugin: registered the app id for notifications', { appId, icon: resolvedIcon });
	} catch (error) {
		result.reason = String((error && error.message) || error);
		log('warn', 'dsh-TaskCompletedNotification-plugin: could not register the app id; Windows may show its own sender name', {
			appId,
			error: result.reason
		});
	}
	return result;
}

/**
 * Register the protocol a clicked toast launches, and stage the handler.
 *
 * A toast can only run something when it is clicked, so the markup carries
 * `activationType="protocol"` + `launch="<ACTIVATION_PROTOCOL>://focus"`. The
 * registered command starts `focus-launcher.vbs`, which resolves
 * `focus-window.ps1` through the AppUserModelId key and runs it hidden (a
 * console would flash otherwise), and that script restores + raises the
 * DeepSeek Harness window.
 *
 * The handler files are copied into the plugin's own data directory so the
 * registration never points at a package directory that an upgrade replaces.
 *
 * @param libDir - the plugin's `lib/` directory (source of the handler files).
 * @param targetDir - stable directory to stage them into.
 * @param protocol - URL scheme to register, without `://`.
 * @param log - diagnostic sink.
 * @returns `{ registered, libDir, launcher, reason }`.
 */
export function ensureClickToFocus(libDir, targetDir, protocol, log = () => {}) {
	const result = { registered: false, libDir: targetDir, launcher: '', reason: undefined };
	if (process.platform !== 'win32') {
		result.reason = 'not-windows';
		return result;
	}
	try {
		mkdirSync(targetDir, { recursive: true });
		for (const file of ['focus-window.ps1', 'focus-launcher.vbs']) {
			const from = join(libDir, file);
			if (existsSync(from)) cpSync(from, join(targetDir, file));
		}
	} catch (error) {
		result.reason = `stage-failed: ${String((error && error.message) || error)}`;
		log('warn', 'dsh-TaskCompletedNotification-plugin: could not stage the click handler; clicking a toast will do nothing', { error: result.reason });
		return result;
	}
	const launcher = join(targetDir, 'focus-launcher.vbs');
	result.launcher = launcher;
	if (!existsSync(launcher)) {
		result.reason = 'launcher-missing';
		return result;
	}
	const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
	const icon = harnessIconPath();
	// A scheme only resolves when the key is marked as a URL protocol; without
	// `URL Protocol` and a friendly default Windows answers a click with its
	// "how do you want to open this?" dialog instead of running the command.
	const script = [
		`$key = 'HKCU:\\Software\\Classes\\${protocol}'`,
		'if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }',
		`Set-ItemProperty -Path $key -Name '(default)' -Value ${psQuote('URL:DeepSeek Harness Focus Protocol')}`,
		"New-ItemProperty -Path $key -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null",
		icon.length > 0
			? `$iconKey = Join-Path $key 'DefaultIcon'; if (-not (Test-Path $iconKey)) { New-Item -Path $iconKey -Force | Out-Null }; Set-ItemProperty -Path $iconKey -Name '(default)' -Value ${psQuote(icon)}`
			: '$null',
		`$cmdKey = Join-Path $key 'shell\\open\\command'`,
		'if (-not (Test-Path $cmdKey)) { New-Item -Path $cmdKey -Force | Out-Null }',
		`Set-ItemProperty -Path $cmdKey -Name '(default)' -Value ${psQuote(`wscript.exe //nologo "${launcher}"`)}`,
		"Write-Output 'ok'"
	].join('; ');
	try {
		execFileSync(powershellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
			stdio: 'ignore',
			windowsHide: true,
			timeout: 15000
		});
		result.registered = true;
		log('info', 'dsh-TaskCompletedNotification-plugin: click-to-focus registered', { protocol, launcher });
	} catch (error) {
		result.reason = String((error && error.message) || error);
		log('warn', 'dsh-TaskCompletedNotification-plugin: could not register the click handler', { protocol, error: result.reason });
	}
	return result;
}

/**
 * Remove the protocol registration written by {@link ensureClickToFocus}.
 *
 * Called when the plugin unloads so an uninstalled plugin leaves no clickable
 * scheme behind (the AppUserModelId key is deliberately kept: it carries the
 * display name and is harmless).
 *
 * @param protocol - URL scheme to unregister.
 * @param log - diagnostic sink.
 */
export function removeClickToFocus(protocol, log = () => {}) {
	if (process.platform !== 'win32') return;
	const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
	const script = [
		`$key = 'HKCU:\\Software\\Classes\\' + ${psQuote(protocol)}`,
		'if (Test-Path $key) { Remove-Item -Path $key -Recurse -Force }',
		"Write-Output 'ok'"
	].join('; ');
	try {
		execFileSync(powershellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
			stdio: 'ignore',
			windowsHide: true,
			timeout: 15000
		});
		log('info', 'dsh-TaskCompletedNotification-plugin: click-to-focus registration removed', { protocol });
	} catch (error) {
		log('warn', 'dsh-TaskCompletedNotification-plugin: could not remove the click-to-focus registration', { protocol, error: String(error) });
	}
}

/**
 * Create the toast sink: one payload file plus one bounded PowerShell process
 * per notification. Exported so a test can drive it without Windows.
 */
export function createNotifier(config, deps = {}) {
	const spawnImpl = typeof deps.spawn === 'function' ? deps.spawn : spawn;
	const log = typeof deps.logger === 'function' ? deps.logger : () => {};
	const script = typeof deps.scriptPath === 'string' ? deps.scriptPath : scriptPath();
	const shell = typeof deps.powershell === 'string' ? deps.powershell : powershellPath(deps.powershellOverride);
	// Payload files live UNDER the plugin's own data directory, not in the OS
	// temp directory: `%TEMP%` is not reliably writable from the Host process
	// (a sandbox or a per-process temp dir yields an unusable or invisible
	// path), and a path we own stays observable for diagnosis.
	const payloadDir = typeof deps.payloadDir === 'string' ? deps.payloadDir : join(dataDir(), 'spool');
	let spoolReady = false;
	try {
		mkdirSync(payloadDir, { recursive: true });
		spoolReady = true;
	} catch (error) {
		log('error', 'notify: cannot create the payload spool directory', String(error));
	}
	let seq = 0;
	const inflight = new Set();

	/** Escape text for an XML text node. */
	function xmlText(value) {
		return String(value === undefined || value === null ? '' : value)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&apos;');
	}

	/**
	 * Toast markup for one notification.
	 *
	 * The plugin builds the markup and `notify.ps1` only loads it. The obvious
	 * PowerShell recipe (`GetTemplateContent` + `$xml.CreateElement('text')`)
	 * is broken: `CreateElement` without a namespace creates a NULL-namespace
	 * node, so appending it to the template's namespaced `<text id="1">` nests
	 * the markup into `<text id="1"><text>…` and Windows renders only its
	 * generic "new notification" header. Verified on this machine.
	 *
	 * With click-to-focus on, the toast carries `activationType="protocol"` and
	 * a `launch` URL: clicking the banner (or its action button) makes the shell
	 * run the registered protocol command, which raises the Harness window.
	 */
	function toastMarkup(title, body) {
		const attributes = config.focusOnClick ? ` activationType="protocol" launch="${PROTOCOL_LAUNCH}"` : '';
		return `<toast${attributes}><visual><binding template="ToastText02">`
			+ `<text id="1">${xmlText(title)}</text>`
			+ `<text id="2">${xmlText(body)}</text>`
			+ '</binding></visual></toast>';
	}

	/** Show one toast; never throws and never rejects. */
	function notify(input) {
		if (!config.enabled) return;
		if (!spoolReady) {
			log('error', 'notify: payload directory unavailable', { payloadDir });
			return;
		}
		if (inflight.size >= config.maxConcurrent) {
			log('info', 'notify: too many concurrent toasts, dropped one', { inflight: inflight.size });
			return;
		}
		let markupPath;
		let resultPath;
		try {
			seq += 1;
			const stamp = `payload-${process.pid}-${Date.now()}-${seq}`;
			markupPath = join(payloadDir, `${stamp}.xml`);
			resultPath = join(payloadDir, `${stamp}.result.txt`);
			// UTF-8 without BOM; notify.ps1 reads it with -Encoding UTF8.
			writeFileSync(markupPath, toastMarkup(input.title, input.body), { encoding: 'utf8' });
			writeFileSync(join(payloadDir, `${stamp}.json`), JSON.stringify({ title: input.title, body: input.body }), { encoding: 'utf8' });
		} catch (error) {
			log('error', 'notify: failed to write the toast markup', String(error));
			return;
		}
		log('info', 'notify: dispatching toast', { title: input.title, markupPath });
		const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Markup', markupPath, '-AppId', config.appId, '-Result', resultPath];
		const skip = Number.isFinite(input.skipIfIdleBelowMs) && input.skipIfIdleBelowMs > 0 ? Math.round(input.skipIfIdleBelowMs) : 0;
		if (skip > 0) args.push('-SkipIfIdleBelowMs', String(skip));
		let child;
		try {
			child = spawnImpl(shell, args, { stdio: 'ignore', windowsHide: true });
		} catch (error) {
			log('error', 'notify: failed to start PowerShell', String(error));
			return;
		}
		inflight.add(child);
		let settled = false;
		const finish = (level, message) => {
			if (settled) return;
			settled = true;
			inflight.delete(child);
			if (level !== 'debug') log(level, message, input.title);
		};
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				/* already gone */
			}
			finish('warn', 'notify: PowerShell did not finish in time');
		}, config.timeoutMs);
		if (typeof timer.unref === 'function') timer.unref();
		child.on('error', (error) => {
			clearTimeout(timer);
			finish('error', `notify: PowerShell failed to start (${error && error.code ? error.code : String(error)})`);
		});
		child.on('exit', (code, signal) => {
			clearTimeout(timer);
			if (code === 0) {
				finish('debug', 'notify: toast dispatched');
				return;
			}
			// notify.ps1 records its own reason in the `.result.txt` file beside
			// the markup; with stdio ignored only the code is visible here.
			finish('warn', `notify: PowerShell exited with code ${String(code)}${signal === null || signal === undefined ? '' : ` (${String(signal)})`}`, { result: resultPath });
		});
	}

	return { notify, inflight, payloadDir };
}

/**
 * Mount the notification listeners.
 *
 * @param ctx - Host plugin context.
 * @param config - raw row config; declared defaults live in `DEFAULT_CONFIG`.
 * @param deps - test seams; production never passes this.
 */
export function apply(ctx, config, deps = {}) {
	const resolved = normalizeConfig(config);
	const log = makeLogger(resolved.log);
	// `deps` exists so a test can mount the plugin without touching the real
	// machine: the smoke test previously ran the live registry writes.
	const ensureClickToFocusImpl = typeof deps.ensureClickToFocus === 'function' ? deps.ensureClickToFocus : ensureClickToFocus;
	const ensureBrandImpl = typeof deps.ensureBrand === 'function' ? deps.ensureBrand : ensureBrand;
	log('info', 'dsh-TaskCompletedNotification-plugin: activating', {
		script: scriptPath(),
		powershell: powershellPath(),
		config: { ...resolved }
	});

	const notifier = createNotifier(resolved, { logger: log });
	if (!resolved.enabled) {
		log('info', 'dsh-TaskCompletedNotification-plugin: disabled by config');
		return;
	}

	// Click-to-focus: stage the handler into the plugin's own data directory and
	// register the protocol the toast launches. Done before branding so the
	// AppUserModelId key can carry the staged handler path in the same pass.
	const clickLibDir = join(dataDir(), 'lib');
	const click = resolved.focusOnClick
		? ensureClickToFocusImpl(join(packageRoot(), 'lib'), clickLibDir, ACTIVATION_PROTOCOL, log)
		: undefined;
	if (!resolved.focusOnClick) log('info', 'dsh-TaskCompletedNotification-plugin: click-to-focus disabled by config');
	if (click !== undefined && click.registered && typeof ctx.effect === 'function') {
		// Leave no scheme behind when the plugin unloads.
		ctx.effect(() => () => removeClickToFocus(ACTIVATION_PROTOCOL, log), 'dsh-TaskCompletedNotification-plugin: click-to-focus registration');
	}

	// Make Windows attribute the toast to this application ("DeepSeek Harness"
	// + icon) rather than falling back to the host executable's identity.
	if (resolved.registerAppId && resolved.appId !== POWERSHELL_APP_ID) {
		ensureBrandImpl(resolved.appId, resolved.icon, resolved.title, click === undefined ? '' : click.libDir, log);
	} else if (resolved.appId === POWERSHELL_APP_ID) {
		log('info', 'dsh-TaskCompletedNotification-plugin: using the PowerShell app id (no branding)');
	}

	// `ctx.root` is the service root that actually carries the Host's event
	// bus in some compositions; a child context can be cut off from it.
	const root = ctx.root === undefined || ctx.root === null ? ctx : ctx.root;

	/** `{ global: true }` skips the context filter applied by scoped dispatch. */
	const OBSERVE = { global: true };

	/** Session-scoped folded state: last answer text, turn start, ask suppression. */
	const states = new Map();

	function stateOf(sessionId) {
		let state = states.get(sessionId);
		if (state === undefined) {
			state = {
				lastAssistantText: '',
				lastUsage: undefined,
				turnStartMs: 0,
				activeTurn: -1,
				askedTurn: -1
			};
			states.set(sessionId, state);
		}
		return state;
	}

	/** Turn end: the model finished and handed control back to the user. */
	function onTurnEnd(session, event) {
		const state = stateOf(session.id);
		const turn = typeof event.data.turn === 'number' ? event.data.turn : -1;
		if (resolved.suppressTurnEndAfterAsk && turn >= 0 && state.askedTurn === turn) {
			log('info', 'dsh-TaskCompletedNotification-plugin: turn-end toast suppressed after an ask', { turn });
			return;
		}
		if (!resolved.notifyOnTurnEnd) return;
		const elapsed = state.turnStartMs > 0 ? Math.max(0, event.time - state.turnStartMs) : 0;
		if (state.turnStartMs > 0 && elapsed < resolved.minTurnMs) {
			log('info', 'dsh-TaskCompletedNotification-plugin: turn too short for a toast', { elapsed, minTurnMs: resolved.minTurnMs });
			return;
		}
		// Deliberately minimal: the title is the app name and the body is the
		// single fixed headline. Context (workspace, duration, tokens, answer
		// preview) stays in the diagnostic log instead of the popup.
		log('info', 'dsh-TaskCompletedNotification-plugin: turn finished', {
			session: session.id,
			elapsedMs: elapsed,
			tokens: state.lastUsage !== undefined && typeof state.lastUsage.totalTokens === 'number' ? state.lastUsage.totalTokens : undefined,
			preview: preview(state.lastAssistantText, 120)
		});
		notifier.notify({
			title: resolved.title,
			body: BODY_TURN_END,
			skipIfIdleBelowMs: resolved.quietWhenActiveMs
		});
	}

	/** The model asked the user to choose something. */
	function onQuestion(request) {
		const agent = request === null || request === undefined ? undefined : request.agent;
		if (agent !== undefined && agent !== null && isSubagentSession(agent.session)) return;
		const questions = Array.isArray(request.questions) ? request.questions : [];
		log('info', 'dsh-TaskCompletedNotification-plugin: user question observed', {
			session: agent === undefined || agent === null ? undefined : agent.id,
			questions: questions.length
		});
		if (!resolved.notifyOnQuestion) return;
		notifier.notify({ title: resolved.title, body: BODY_CONFIRM });
		if (agent !== undefined && agent !== null) {
			// Remember the turn this ask belongs to: its `turn/end` toast would
			// only repeat what this notification already said.
			stateOf(agent.id).askedTurn = stateOf(agent.id).activeTurn;
		}
	}

	/** The model requested approval for a sensitive operation. */
	function onApproval(request) {
		const agent = request === null || request === undefined ? undefined : request.agent;
		if (agent !== undefined && agent !== null && isSubagentSession(agent.session)) return;
		if (agent !== undefined && agent !== null) {
			const state = stateOf(agent.id);
			state.askedTurn = state.activeTurn;
		}
		log('info', 'dsh-TaskCompletedNotification-plugin: approval observed', {
			session: agent === undefined || agent === null ? undefined : agent.id,
			tool: request.toolName
		});
		if (!resolved.notifyOnApproval) return;
		// Minimal by design; the tool name and reason stay in the log below.
		notifier.notify({ title: resolved.title, body: BODY_CONFIRM });
	}

	// ---------------------------------------------------------------- listeners

	root.on('session/event', (session, event) => {
		try {
			if (session === null || session === undefined || event === null || event === undefined) return;
			if (resolved.probe) log('info', 'probe: my session/event listener hit', { type: event.type, session: session.id });
			if (isSubagentSession(session)) return;
			if (event.type === 'turn/start') {
				const state = stateOf(session.id);
				state.turnStartMs = event.time;
				state.activeTurn = typeof event.data.turn === 'number' ? event.data.turn : -1;
				state.lastAssistantText = '';
				state.lastUsage = undefined;
				return;
			}
			if (event.type === 'assistant/message') {
				const data = event.data;
				const text = textOfMessage(data === undefined ? undefined : data.message);
				const state = stateOf(session.id);
				if (data !== undefined && typeof data.turn === 'number') state.activeTurn = data.turn;
				if (text.length > 0) state.lastAssistantText = text;
				if (data !== undefined && data.usage !== undefined) state.lastUsage = data.usage;
				return;
			}
			if (event.type === 'turn/end') {
				const reason = event.data === undefined ? undefined : event.data.reason;
				const kind = reason === undefined || reason === null ? 'unknown' : String(reason.kind);
				log('info', 'dsh-TaskCompletedNotification-plugin: turn/end observed', { kind, turn: event.data === undefined ? undefined : event.data.turn });
				if (kind === 'completed') onTurnEnd(session, event);
			}
		} catch (error) {
			log('error', 'dsh-TaskCompletedNotification-plugin: session/event listener failed', String(error));
		}
	}, OBSERVE);

	root.on('user-questions/request', (request, next) => {
		try {
			onQuestion(request);
		} catch (error) {
			log('error', 'dsh-TaskCompletedNotification-plugin: question listener failed', String(error));
		}
		return next();
	}, OBSERVE);

	root.on('approval/request', (request, next) => {
		try {
			onApproval(request);
		} catch (error) {
			log('error', 'dsh-TaskCompletedNotification-plugin: approval listener failed', String(error));
		}
		return next();
	}, OBSERVE);

	root.on('session/disposed', (session) => {
		if (session !== null && session !== undefined) states.delete(session.id);
	}, OBSERVE);

	if (resolved.probe) {
		log('info', 'dsh-TaskCompletedNotification-plugin: probe enabled', { sameRoot: root === ctx });
		root.on('dsh-TaskCompletedNotification-plugin/self-test', (value) => log('info', 'probe: self-test round trip', { value }), OBSERVE);
		if (typeof root.emit === 'function') root.emit('dsh-TaskCompletedNotification-plugin/self-test', 'local');
		const probes = ['internal/dispatch', 'agent/created', 'agent/status', 'tools/result'];
		for (const event of probes) {
			root.on(event, (...args) => {
				try {
					const first = args[0];
					log('info', 'probe: ' + event, {
						argc: args.length,
						first: first === null || first === undefined
							? null
							: typeof first === 'object'
								? String(first.type ?? first.id ?? first.kind ?? 'object')
								: String(first).slice(0, 40)
					});
				} catch {
					/* a probe must never throw */
				}
			}, OBSERVE);
		}
		root.on('internal/listener', (eventName) => {
			try {
				log('info', 'probe: internal/listener', { name: String(eventName) });
			} catch {
				/* ignore */
			}
		}, OBSERVE);
		log('info', 'probe: installed', { events: probes.length, sameRoot: root === ctx });
	}

	log('info', 'dsh-TaskCompletedNotification-plugin: listeners registered', { sameRoot: root === ctx });

	// The pending toast processes are fire-and-forget; expose them on the
	// return value only for tests, where `apply` is driven by a stub.
	return { normalizeConfig: resolved, notifier, states };
}

export { DEFAULT_CONFIG, POWERSHELL_APP_ID };
