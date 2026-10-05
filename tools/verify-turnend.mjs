/**
 * Exercise the "task finished" notification end to end.
 *
 *   node tools/verify-turnend.mjs            # dispatch a real popup
 *   node tools/verify-turnend.mjs --dry-run  # print the payload instead
 *
 * The plugin is the real `lib/index.js`; only the Cordis context is a stub, so
 * the synthetic `turn/end completed` event travels the same fold → format →
 * notify path a live turn uses, including the real PowerShell dispatch.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';

const dryRun = process.argv.includes('--dry-run');

/** Stub context that records listeners and can dispatch into them. */
function makeCtx() {
	const listeners = new Map();
	return {
		listeners,
		get() { return undefined; },
		on(event, listener) {
			const list = listeners.get(event) ?? [];
			list.push(listener);
			listeners.set(event, list);
			return () => {};
		},
		effect(cb) {
			const d = cb();
			return typeof d === 'function' ? d : () => {};
		},
		emit(event, ...rest) {
			let result;
			for (const l of listeners.get(event) ?? []) result = l(...rest);
			return result;
		}
	};
}

const session = {
	id: 'session-verify-turnend',
	header: { id: 'session-verify-turnend', cwd: 'D:\\dsh' },
	events: []
};
const ctx = makeCtx();
// quietWhenActiveMs: 0 keeps the presence gate out of the way for this check.
const runtime = apply(ctx, { log: true, probe: false, quietWhenActiveMs: 0 });

const shown = [];
runtime.notifier.notify = (input) => shown.push(input);

const base = Date.now() - 42000;
ctx.emit('session/event', session, { type: 'turn/start', seq: 1, time: base, data: { turn: 9 } });
ctx.emit('session/event', session, {
	type: 'assistant/message',
	seq: 2,
	time: base + 40000,
	data: {
		turn: 9,
		step: 1,
		message: {
			role: 'assistant',
			source: { kind: 'model' },
			content: [{ type: 'text', text: '第三次测试：这条是「任务完成」通知，由真实 turn/end 事件驱动。' }]
		},
		stream: [],
		usage: { totalTokens: 18342 }
	}
});
ctx.emit('session/event', session, { type: 'turn/end', seq: 3, time: base + 42000, data: { turn: 9, reason: { kind: 'completed' } } });

if (dryRun) {
	console.log(JSON.stringify(shown, null, 2));
	process.exit(shown.length === 1 ? 0 : 1);
}

console.log(`formatted: ${JSON.stringify(shown)}`);
// Now replay the same fold into a second mount whose notifier really dispatches.
const realCtx = makeCtx();
const real = apply(realCtx, { log: true, probe: false, quietWhenActiveMs: 0 });
const realSession = { id: 'session-verify-turnend-live', header: { id: 'session-verify-turnend-live', cwd: 'D:\\dsh' }, events: [] };
realCtx.emit('session/event', realSession, { type: 'turn/start', seq: 1, time: base, data: { turn: 9 } });
realCtx.emit('session/event', realSession, {
	type: 'assistant/message',
	seq: 2,
	time: base + 40000,
	data: {
		turn: 9,
		step: 1,
		message: {
			role: 'assistant',
			source: { kind: 'model' },
			content: [{ type: 'text', text: '第三次测试：这条是「任务完成」通知，由真实 turn/end 事件驱动。' }]
		},
		stream: [],
		usage: { totalTokens: 18342 }
	}
});
realCtx.emit('session/event', realSession, { type: 'turn/end', seq: 3, time: base + 42000, data: { turn: 9, reason: { kind: 'completed' } } });
console.log(`dispatched; inflight=${real.notifier.inflight.size}`);
const started = Date.now();
const tick = setInterval(() => {
	if (real.notifier.inflight.size === 0 || Date.now() - started > 20000) {
		clearInterval(tick);
		console.log('done');
	}
}, 200);
