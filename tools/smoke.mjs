/**
 * Smoke test for dsh-TaskCompletedNotification-plugin, driven without Windows.
 *
 *   node tools/smoke.mjs
 *
 * Imports `lib/index.js` against a stub Cordis context, fires the three event
 * families the plugin listens to, and asserts on the notification payloads
 * captured through the notifier seam instead of showing real toasts.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	apply,
	DEFAULT_CONFIG,
	POWERSHELL_APP_ID,
	createNotifier,
	ensureBrand,
	harnessIconPath,
	humanDuration,
	isSubagentSession,
	name,
	normalizeConfig,
	preview,
	workspaceLabel
} from '../lib/index.js';

// Keep the diagnostic log out of the real profile.
const scratch = mkdtempSync(join(tmpdir(), 'dsh-TaskCompletedNotification-plugin-smoke-'));
process.env.DSH_HOME = scratch;

let passed = 0;
async function test(name, fn) {
	try {
		await fn();
		passed += 1;
		console.log(`ok   ${name}`);
	} catch (error) {
		console.error(`FAIL ${name}`);
		throw error;
	}
}

/** A stub context that records what the plugin registers. */
function makeCtx(services = {}) {
	const listeners = new Map();
	const options = new Map();
	return {
		listeners,
		options,
		get(key) {
			return services[key];
		},
		on(event, listener, opts) {
			const list = listeners.get(event) ?? [];
			list.push(listener);
			listeners.set(event, list);
			options.set(event, opts);
			return () => {};
		},
		effect(callback) {
			const disposer = callback();
			return typeof disposer === 'function' ? disposer : () => {};
		},
		emit(event, ...args) {
			let result;
			for (const listener of listeners.get(event) ?? []) result = listener(...args);
			return result;
		}
	};
}

/** A live root agent stand-in with the fields the plugin reads. */
function makeAgent(id, cwd) {
	const session = { id, header: { id, cwd }, events: [] };
	return { id, status: 'running', session };
}

const BASE = Date.parse('2026-10-02T18:00:00Z');

function turnStartEvent(turn, time) {
	return { type: 'turn/start', seq: turn * 10, time, data: { turn } };
}

function assistantEvent(turn, text, time, usage) {
	return {
		type: 'assistant/message',
		seq: turn * 10 + 1,
		time,
		data: {
			turn,
			step: 1,
			message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }] },
			stream: [],
			...(usage === undefined ? {} : { usage })
		}
	};
}

function turnEndEvent(turn, time, kind = 'completed') {
	return { type: 'turn/end', seq: turn * 10 + 2, time, data: { turn, reason: { kind } } };
}

/**
 * Mount the plugin against the stub context and replace the notifier sink with
 * a recorder, so assertions read exactly what `notify()` was called with.
 */
function mount(config, services) {
	const ctx = makeCtx(services);
	// Seams: the smoke test must not touch the real machine (registry keys,
	// staged handler files), so both registration steps are stubbed out.
	const calls = { click: [], brand: [] };
	const runtime = apply(ctx, config, {
		ensureClickToFocus: (libDir, targetDir, protocol) => {
			calls.click.push({ libDir, targetDir, protocol });
			return { registered: true, libDir: targetDir, launcher: `${targetDir}\\focus-launcher.vbs` };
		},
		ensureBrand: (appId, icon, displayName, libDir) => {
			calls.brand.push({ appId, displayName, libDir });
			return { appId, icon, written: true, skipped: false };
		}
	});
	const shown = [];
	if (runtime !== undefined && runtime.notifier !== undefined) {
		runtime.notifier.notify = (input) => shown.push(input);
	}
	return { ctx, runtime, shown, calls };
}

await test('mounting never writes to the real machine', () => {
	const { calls } = mount({ enabled: true });
	assert.equal(calls.click.length, 1, 'click registration goes through the injected seam');
	assert.equal(calls.brand.length, 1, 'brand registration goes through the injected seam');
	assert.equal(calls.click[0].protocol, 'dsh-TaskCompletedNotification-plugin');
	assert.equal(calls.brand[0].appId, 'DeepSeek.Harness.Notify');
	assert.equal(calls.brand[0].displayName, 'DeepSeek Harness');
});

/** Capture the toast markup the plugin wrote, without spawning anything. */
function makeSpawnRecorder() {
	const calls = [];
	const spawnImpl = (command, args, options) => {
		const markupIndex = args.indexOf('-Markup');
		const markupPath = markupIndex >= 0 ? args[markupIndex + 1] : undefined;
		const resultIndex = args.indexOf('-Result');
		const skipIndex = args.indexOf('-SkipIfIdleBelowMs');
		const markup = markupPath === undefined ? undefined : readFileSync(markupPath, 'utf8');
		// Mirror what notify.ps1/Windows would read back out of the markup.
		const textOf = (id) => {
			if (markup === undefined) return undefined;
			const match = new RegExp(`<text id="${id}">([\\s\\S]*?)</text>`).exec(markup);
			if (match === null) return undefined;
			return match[1]
				.replace(/&lt;/g, '<')
				.replace(/&gt;/g, '>')
				.replace(/&quot;/g, '"')
				.replace(/&apos;/g, "'")
				.replace(/&amp;/g, '&');
		};
		calls.push({
			command,
			args,
			options,
			markup,
			markupPath,
			resultPath: resultIndex >= 0 ? args[resultIndex + 1] : undefined,
			payload: markup === undefined ? undefined : { title: textOf('1'), body: textOf('2') },
			skipIfIdleBelowMs: skipIndex >= 0 ? Number(args[skipIndex + 1]) : 0
		});
		const child = {
			on(event, handler) {
				if (event === 'exit') queueMicrotask(() => handler(0, null));
				return child;
			},
			kill() {}
		};
		return child;
	};
	return { calls, spawnImpl };
}

// ---------------------------------------------------------------- pure helpers

await test('normalizeConfig falls back to the declared defaults', () => {
	const resolved = normalizeConfig(undefined);
	assert.equal(resolved.enabled, DEFAULT_CONFIG.enabled);
	assert.equal(resolved.appId, DEFAULT_CONFIG.appId);
	assert.equal(resolved.quietWhenActiveMs, DEFAULT_CONFIG.quietWhenActiveMs);
});

await test('normalizeConfig clamps numbers and rejects junk', () => {
	const resolved = normalizeConfig({
		enabled: 'yes',
		timeoutMs: -5,
		maxConcurrent: 999,
		quietWhenActiveMs: 'soon',
		title: '   '
	});
	assert.equal(resolved.enabled, true, 'non-boolean falls back');
	assert.equal(resolved.timeoutMs, 1000, 'negative timeout clamps to the minimum');
	assert.equal(resolved.maxConcurrent, 16, 'oversized concurrency clamps');
	assert.equal(resolved.quietWhenActiveMs, DEFAULT_CONFIG.quietWhenActiveMs);
	assert.equal(resolved.title, DEFAULT_CONFIG.title, 'blank title falls back');
});

await test('preview collapses whitespace and cuts on whole characters', () => {
	assert.equal(preview('  a\n\n b  '), 'a b');
	const cut = preview('😀😀😀😀😀', 4);
	assert.equal(Array.from(cut).length, 4);
	assert.equal(Array.from(cut)[3], '…');
});

await test('workspaceLabel names the directory, tolerating trailing separators', () => {
	assert.equal(workspaceLabel('D:\\work\\project'), 'project');
	assert.equal(workspaceLabel('D:\\work\\project\\'), 'project');
	assert.equal(workspaceLabel('/home/me/repo/'), 'repo');
	assert.equal(workspaceLabel(undefined), '');
});

await test('humanDuration renders seconds, minutes and hours', () => {
	assert.equal(humanDuration(4200), '4 秒');
	assert.equal(humanDuration(65000), '1 分 5 秒');
	assert.equal(humanDuration(120000), '2 分钟');
	assert.equal(humanDuration(3600000 * 2 + 60000 * 5), '2 小时 5 分');
	assert.equal(humanDuration(Number.NaN), '');
});

await test('isSubagentSession recognizes spawned children', () => {
	assert.equal(isSubagentSession({ header: { origin: 'subagent' } }), true);
	assert.equal(isSubagentSession({ header: { parentSession: 'session-parent' } }), true);
	assert.equal(isSubagentSession({ header: { id: 'session-root' } }), false);
	assert.equal(isSubagentSession(undefined), false);
});

// ------------------------------------------------------------- notifier seam

await test('createNotifier writes correct toast markup and passes the idle gate', async () => {
	const recorder = makeSpawnRecorder();
	const spool = mkdtempSync(join(tmpdir(), 'dsh-TaskCompletedNotification-plugin-spool-'));
	const notifier = createNotifier({ ...normalizeConfig(undefined), quietWhenActiveMs: 15000 }, {
		spawn: recorder.spawnImpl,
		logger: () => {},
		scriptPath: 'D:\\plugin\\lib\\notify.ps1',
		powershell: 'powershell.exe',
		payloadDir: spool
	});
	notifier.notify({ title: '标题 <&>', body: '正文', skipIfIdleBelowMs: 15000 });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(recorder.calls.length, 1);
	const call = recorder.calls[0];
	assert.equal(call.command, 'powershell.exe');
	assert.ok(call.args.includes('-NoProfile'));
	assert.equal(call.args[call.args.indexOf('-File') + 1], 'D:\\plugin\\lib\\notify.ps1');
	assert.deepEqual(call.payload.body, '正文', 'the markup file round-trips UTF-8');
	assert.deepEqual(call.payload.title, '标题 <&>', 'markup survives XML escaping');
	assert.equal(call.skipIfIdleBelowMs, 15000);
	assert.equal(call.options.stdio, 'ignore');
	assert.match(call.markupPath, /dsh-TaskCompletedNotification-plugin-spool/, 'markup lives in the plugin spool');
	assert.match(call.markup, /template="ToastText02"/);
	assert.match(call.markup, /<text id="1">标题 &lt;&amp;&gt;<\/text>/, 'special characters are escaped');
	assert.match(call.markup, /activationType="protocol"/, 'the toast is clickable by default');
	assert.match(call.markup, /launch="dsh-TaskCompletedNotification-plugin:\/\/focus"/, 'and launches the focus handler');
	assert.ok(!/CreateElement/.test(call.markup));
	assert.match(call.resultPath, /\.result\.txt$/, 'a result file is requested for diagnosis');
	rmSync(spool, { recursive: true, force: true });
});

await test('focusOnClick=false ships a plain, non-activating toast', async () => {
	const recorder = makeSpawnRecorder();
	const spool = mkdtempSync(join(tmpdir(), 'dsh-TaskCompletedNotification-plugin-spool-'));
	const notifier = createNotifier(normalizeConfig({ focusOnClick: false }), {
		spawn: recorder.spawnImpl,
		logger: () => {},
		payloadDir: spool
	});
	notifier.notify({ title: 'DeepSeek Harness', body: '任务完成' });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(recorder.calls.length, 1);
	assert.ok(!/activationType/.test(recorder.calls[0].markup), 'no protocol activation');
	assert.ok(!/launch=/.test(recorder.calls[0].markup));
	rmSync(spool, { recursive: true, force: true });
});

await test('createNotifier drops notifications past maxConcurrent', async () => {
	const recorder = makeSpawnRecorder();
	const notifier = createNotifier({ ...normalizeConfig(undefined), maxConcurrent: 1 }, {
		spawn: recorder.spawnImpl,
		logger: () => {}
	});
	// The first child stays pending: its exit is delivered on a microtask, so a
	// second synchronous call sees the slot occupied.
	notifier.notify({ title: 'one', body: 'a' });
	notifier.notify({ title: 'two', body: 'b' });
	assert.equal(recorder.calls.length, 1);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(notifier.inflight.size, 0);
});

await test('createNotifier ignores a disabled config', async () => {
	const recorder = makeSpawnRecorder();
	const notifier = createNotifier({ ...normalizeConfig(undefined), enabled: false }, {
		spawn: recorder.spawnImpl,
		logger: () => {}
	});
	notifier.notify({ title: 'x', body: 'y' });
	assert.equal(recorder.calls.length, 0);
});

// -------------------------------------------------------------- event wiring

await test('turn completion notifies with the fixed minimal body', () => {
	const { ctx, runtime, shown } = mount({ enabled: true });
	const agent = makeAgent('session-one', 'D:\\work\\demo');
	ctx.emit('session/event', agent.session, turnStartEvent(1, BASE));
	ctx.emit('session/event', agent.session, assistantEvent(1, '已经改好了 fs-observation-policy 的报错分支。', BASE + 41000, { totalTokens: 12345 }));
	ctx.emit('session/event', agent.session, turnEndEvent(1, BASE + 42500));

	assert.equal(shown.length, 1, 'exactly one toast');
	assert.equal(shown[0].title, 'DeepSeek Harness', 'the title is always the plain app name');
	assert.equal(shown[0].body, '任务完成', 'the body carries only the fixed headline');
	assert.equal(shown[0].skipIfIdleBelowMs, runtime.normalizeConfig.quietWhenActiveMs);
});

await test('non-completed turn ends stay silent', () => {
	const { ctx, shown } = mount({ enabled: true });
	const agent = makeAgent('session-abort', 'D:\\work\\demo');
	ctx.emit('session/event', agent.session, turnStartEvent(1, BASE));
	ctx.emit('session/event', agent.session, turnEndEvent(1, BASE + 1000, 'aborted'));
	assert.equal(shown.length, 0);
});

await test('subagent sessions never notify', () => {
	const { ctx, shown } = mount({ enabled: true });
	const child = { id: 'session-child', header: { id: 'session-child', cwd: 'D:\\work\\demo', origin: 'subagent' }, events: [] };
	ctx.emit('session/event', child, turnStartEvent(1, BASE));
	ctx.emit('session/event', child, turnEndEvent(1, BASE + 5000));
	assert.equal(shown.length, 0);
});

await test('a subagent question or approval never notifies', async () => {
	const { ctx, shown } = mount({ enabled: true });
	const child = {
		id: 'session-child2',
		session: { id: 'session-child2', header: { id: 'session-child2', parentSession: 'session-root' } }
	};
	await ctx.emit('user-questions/request', { agent: child, questions: [{ id: 'q1', question: '子代理的问题？' }] }, () => Promise.resolve(null));
	await ctx.emit('approval/request', { agent: child, toolName: 'bash' }, () => Promise.resolve('unavailable'));
	assert.equal(shown.length, 0);
});

await test('minTurnMs suppresses a very short turn', () => {
	const { ctx, runtime, shown } = mount({ enabled: true, minTurnMs: 30000 });
	const agent = makeAgent('session-short', 'D:\\work\\demo');
	ctx.emit('session/event', agent.session, turnStartEvent(1, BASE));
	ctx.emit('session/event', agent.session, assistantEvent(1, '好的。', BASE + 900));
	ctx.emit('session/event', agent.session, turnEndEvent(1, BASE + 1000));
	assert.equal(shown.length, 0);
	assert.equal(runtime.states.get('session-short').lastAssistantText, '好的。');
});

await test('notifyOnTurnEnd=false keeps questions but drops completions', async () => {
	const { ctx, shown } = mount({ enabled: true, notifyOnTurnEnd: false });
	const agent = makeAgent('session-off', 'D:\\work\\demo');
	ctx.emit('session/event', agent.session, turnStartEvent(1, BASE));
	ctx.emit('session/event', agent.session, turnEndEvent(1, BASE + 5000));
	assert.equal(shown.length, 0, 'completion suppressed');
	await ctx.emit('user-questions/request', { agent, questions: [{ id: 'q1', question: '选哪个？' }] }, () => Promise.resolve(null));
	assert.equal(shown.length, 1, 'question still notifies');
});

await test('a question notifies once and suppresses the turn-end duplicate', async () => {
	const { ctx, shown } = mount({ enabled: true });
	const agent = makeAgent('session-ask', 'D:\\work\\demo');
	ctx.emit('session/event', agent.session, turnStartEvent(1, BASE));
	ctx.emit('session/event', agent.session, assistantEvent(1, '想确认一下。', BASE + 2000));
	await ctx.emit('user-questions/request', {
		agent,
		questions: [{ id: 'q1', question: '要用 TODO 板拆步骤吗？' }, { id: 'q2', question: '范围包含 UI 吗？' }]
	}, () => Promise.resolve(null));
	ctx.emit('session/event', agent.session, turnEndEvent(1, BASE + 3000));

	assert.equal(shown.length, 1, 'the ask toast is the only one');
	assert.equal(shown[0].title, 'DeepSeek Harness');
	assert.equal(shown[0].body, '任务操作待确认', 'a pending decision carries only the confirm headline');
});

await test('suppressTurnEndAfterAsk=false keeps both toasts', async () => {
	const { ctx, shown } = mount({ enabled: true, suppressTurnEndAfterAsk: false });
	const agent = makeAgent('session-both', 'D:\\work\\demo');
	ctx.emit('session/event', agent.session, turnStartEvent(1, BASE));
	await ctx.emit('user-questions/request', { agent, questions: [{ id: 'q1', question: '继续吗？' }] }, () => Promise.resolve(null));
	ctx.emit('session/event', agent.session, turnEndEvent(1, BASE + 1000));
	assert.equal(shown.length, 2);
	assert.equal(shown[1].body, '任务完成', 'the second toast is the completion one');
});

await test('a later turn is not suppressed by an earlier ask', async () => {
	const { ctx, shown } = mount({ enabled: true });
	const agent = makeAgent('session-later', 'D:\\work\\demo');
	ctx.emit('session/event', agent.session, turnStartEvent(1, BASE));
	await ctx.emit('user-questions/request', { agent, questions: [{ id: 'q1', question: '继续吗？' }] }, () => Promise.resolve(null));
	ctx.emit('session/event', agent.session, turnEndEvent(1, BASE + 1000));
	ctx.emit('session/event', agent.session, turnStartEvent(2, BASE + 2000));
	ctx.emit('session/event', agent.session, assistantEvent(2, '第二步也做完了。', BASE + 6000));
	ctx.emit('session/event', agent.session, turnEndEvent(2, BASE + 7000));
	assert.equal(shown.length, 2, 'ask + second turn completion');
	assert.equal(shown[1].body, '任务完成');
});

await test('an approval notifies with the fixed minimal body', async () => {
	const { ctx, shown } = mount({ enabled: true });
	const agent = makeAgent('session-approve', 'D:\\work\\demo');
	await ctx.emit('approval/request', {
		agent,
		toolName: 'pwsh',
		reason: '需要写工作区之外的目录'
	}, () => Promise.resolve('allowed-once'));
	assert.equal(shown.length, 1);
	assert.equal(shown[0].title, 'DeepSeek Harness');
	assert.equal(shown[0].body, '任务操作待确认');
});

await test('an approval falls back to displayReason when reason is absent', async () => {
	const { ctx, shown } = mount({ enabled: true });
	const agent = makeAgent('session-approve2', 'D:\\work\\demo');
	// `displayReason` is no longer rendered (the body is fixed), but it must not
	// break the request path.
	await ctx.emit('approval/request', { agent, toolName: 'bash', displayReason: '想执行 rm -rf' }, () => Promise.resolve('unavailable'));
	assert.equal(shown.length, 1);
	assert.equal(shown[0].body, '任务操作待确认');
});

await test('approval listeners keep the waterfall moving', async () => {
	const { ctx } = mount({ enabled: true });
	let called = 0;
	const outcome = await ctx.emit('approval/request', { toolName: 'bash' }, () => {
		called += 1;
		return Promise.resolve('unavailable');
	});
	assert.equal(called, 1, 'next() is always called');
	assert.equal(outcome, 'unavailable', 'the decision is passed through untouched');
});

await test('question listeners keep the waterfall moving', async () => {
	const { ctx } = mount({ enabled: true });
	let called = 0;
	await ctx.emit('user-questions/request', { questions: [] }, () => {
		called += 1;
		return Promise.resolve({ pending: true });
	});
	assert.equal(called, 1);
});

await test('the decision rule is: one notification per turn, chosen by nature', async () => {
	// A turn that asked the user something -> only the confirm toast.
	const asked = mount({ enabled: true });
	const askedAgent = makeAgent('session-rule-ask', 'D:\\work\\demo');
	asked.ctx.emit('session/event', askedAgent.session, turnStartEvent(1, BASE));
	await asked.ctx.emit('user-questions/request', { agent: askedAgent, questions: [{ id: 'q1', question: '选哪个？' }] }, () => Promise.resolve(null));
	asked.ctx.emit('session/event', askedAgent.session, turnEndEvent(1, BASE + 8000));
	assert.equal(asked.shown.length, 1, 'an asking turn produces exactly one popup');
	assert.equal(asked.shown[0].body, '任务操作待确认');

	// A plain completed turn -> only the completion toast, with the shipped
	// defaults (no quiet gate, no short-turn filter).
	const plain = mount({ enabled: true });
	const plainAgent = makeAgent('session-rule-plain', 'D:\\work\\demo');
	plain.ctx.emit('session/event', plainAgent.session, turnStartEvent(1, BASE));
	plain.ctx.emit('session/event', plainAgent.session, assistantEvent(1, '直接答完了。', BASE + 900));
	plain.ctx.emit('session/event', plainAgent.session, turnEndEvent(1, BASE + 1000));
	assert.equal(plain.shown.length, 1, 'a plain turn produces exactly one popup');
	assert.equal(plain.shown[0].body, '任务完成');
	assert.equal(plain.shown[0].skipIfIdleBelowMs, 0, 'the quiet gate is off by default');
});

await test('shipped defaults always report a completed turn', () => {
	assert.equal(normalizeConfig(undefined).quietWhenActiveMs, 0);
	assert.equal(normalizeConfig(undefined).minTurnMs, 0);
	assert.equal(normalizeConfig(undefined).suppressTurnEndAfterAsk, true);
});

await test('a throwing optional service never breaks a notification', () => {
	const { ctx, shown } = mount({ enabled: true }, {
		sessionTitle: { titleOf() { throw new Error('boom'); } }
	});
	const agent = makeAgent('session-throw', 'D:\\work\\demo');
	ctx.emit('session/event', agent.session, turnStartEvent(1, BASE));
	ctx.emit('session/event', agent.session, assistantEvent(1, '完成。', BASE + 1000));
	ctx.emit('session/event', agent.session, turnEndEvent(1, BASE + 2000));
	assert.equal(shown.length, 1);
	assert.equal(shown[0].body, '任务完成');
});

await test('the body stays minimal even when a session title exists', () => {
	const { ctx, shown } = mount({ enabled: true }, {
		sessionTitle: { titleOf: () => '修复 fs-observation-policy' }
	});
	const agent = makeAgent('session-titled', 'D:\\work\\demo');
	ctx.emit('session/event', agent.session, turnStartEvent(1, BASE));
	ctx.emit('session/event', agent.session, assistantEvent(1, '完成。', BASE + 1000));
	ctx.emit('session/event', agent.session, turnEndEvent(1, BASE + 2000));
	assert.equal(shown[0].title, 'DeepSeek Harness');
	assert.equal(shown[0].body, '任务完成', 'the session title is not folded into the popup');
});

await test('enabled=false registers no listeners', () => {
	const { ctx } = mount({ enabled: false });
	assert.equal(ctx.listeners.size, 0, 'no listeners when disabled');
});

await test('session/disposed forgets folded state', () => {
	const { ctx, runtime } = mount({ enabled: true });
	const agent = makeAgent('session-gone', 'D:\\work\\demo');
	ctx.emit('session/event', agent.session, turnStartEvent(1, BASE));
	assert.ok(runtime.states.has('session-gone'));
	ctx.emit('session/disposed', agent.session);
	assert.equal(runtime.states.has('session-gone'), false);
});

await test('a broken config object still activates with defaults', () => {
	const { ctx } = mount('nonsense');
	assert.ok(ctx.listeners.has('approval/request'));
	assert.ok(ctx.listeners.has('user-questions/request'));
	assert.ok(ctx.listeners.has('session/event'));
});

await test('every listener is registered global to escape agent-scope filtering', () => {
	const { ctx } = mount({ enabled: true });
	// `user-questions/request` and `approval/request` are dispatched through the
	// filtered `scopeTarget(agent, agent)` carrier; a listener without `global`
	// is silently filtered out at the profile level. Regression guard.
	for (const event of ['user-questions/request', 'approval/request', 'session/event', 'session/disposed']) {
		assert.deepEqual(ctx.options.get(event), { global: true }, `${event} must be global`);
	}
});

// ------------------------------------------------------------ shipped assets

await test('the default app id is branded and registered', () => {
	assert.equal(DEFAULT_CONFIG.appId, 'DeepSeek.Harness.Notify');
	assert.equal(DEFAULT_CONFIG.registerAppId, true);
	assert.notEqual(DEFAULT_CONFIG.appId, POWERSHELL_APP_ID);
	const resolved = normalizeConfig(undefined);
	assert.equal(resolved.appId, 'DeepSeek.Harness.Notify');
	assert.equal(resolved.registerAppId, true);
});

await test('registerAppId/icon config values are honoured', () => {
	const resolved = normalizeConfig({ appId: 'Vendor.App', registerAppId: false, icon: 'D:\\x\\icon.png' });
	assert.equal(resolved.appId, 'Vendor.App');
	assert.equal(resolved.registerAppId, false);
	assert.equal(resolved.icon, 'D:\\x\\icon.png');
	// A blank icon means autodetect, not the literal blank string.
	assert.equal(normalizeConfig({ icon: '   ' }).icon, '');
	assert.equal(normalizeConfig({ registerAppId: 'yes' }).registerAppId, true, 'non-boolean falls back');
});

await test('ensureBrand refuses nothing to register and never throws off Windows', () => {
	const calls = [];
	const log = (level, message) => calls.push({ level, message });
	const noId = ensureBrand('', '', 'DeepSeek Harness', log);
	assert.equal(noId.skipped, true);
	assert.equal(noId.reason, 'no-app-id');
	assert.equal(noId.written, false);
	// The name defaults to the plugin title when omitted.
	const defaulted = ensureBrand('', '', undefined, log);
	assert.equal(defaulted.reason, 'no-app-id');
});

await test('harnessIconPath returns an existing path or an empty string', () => {
	const found = harnessIconPath();
	if (found !== '') assert.match(found, /icon\.png$/i);
	assert.equal(typeof found, 'string');
});

await test('the click handler assets exist for staging', () => {
	for (const file of ['focus-window.ps1', 'focus-launcher.vbs']) {
		const path = new URL(`../lib/${file}`, import.meta.url);
		const text = readFileSync(path, 'utf8');
		assert.ok(text.length > 0, `${file} must ship`);
	}
	const launcher = readFileSync(new URL('../lib/focus-launcher.vbs', import.meta.url), 'utf8');
	assert.match(launcher, /DshWinNotifyLibDir/, 'the launcher resolves the staged handler through the app id key');
	assert.match(launcher, /-WindowStyle Hidden/, 'and runs it without a console window');
	const focus = readFileSync(new URL('../lib/focus-window.ps1', import.meta.url), 'utf8');
	assert.match(focus, /AttachThreadInput/, 'the focus script works around the Windows foreground lock');
	assert.match(focus, /SetForegroundWindow/);
});

await test('the shipped notify.ps1 is ASCII-only and reads a UTF-8 payload', () => {
	const script = readFileSync(new URL('../lib/notify.ps1', import.meta.url), 'utf8');
	assert.equal(/[^\x00-\x7F]/.test(script), false, 'a BOM-less .ps1 must stay ASCII');
	assert.match(script, /-Encoding UTF8/);
	assert.match(script, /GetLastInputInfo/);
	assert.match(script, /ToastNotificationManager/);
	assert.match(script, /exit 0/);
});

await test('the bundle patch inserts exactly one row for this package', () => {
	const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
	assert.match(patch, /insert:/);
	assert.match(patch, /id: dsh-TaskCompletedNotification-plugin/);
	// The row's plugin name must match the package name, or the loader cannot
	// resolve the module after a rename.
	const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
	assert.match(patch, new RegExp(`name: '${manifest.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
	assert.equal(manifest.name, name, 'package.json and the exported loader identity agree');
});

await test('the URL protocol is independent of the package name', () => {
	// The scheme is a stable contract with the registry entry written at
	// activation; renaming the package must not silently change it.
	const launcher = readFileSync(new URL('../lib/focus-launcher.vbs', import.meta.url), 'utf8');
	assert.match(launcher, /dsh-TaskCompletedNotification-plugin/);
	const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
	assert.match(source, /ACTIVATION_PROTOCOL = 'dsh-TaskCompletedNotification-plugin'/);
});

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
