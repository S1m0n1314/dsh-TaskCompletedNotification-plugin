/**
 * Print the exact notification the plugin formats for the two "needs the user"
 * paths, so the fixed-body-line contract can be checked without a live ask.
 *
 *   node tools/verify-confirm.mjs
 *
 * Expected shape: title is always the plain app name, and the first body line
 * is the fixed headline for that situation.
 */
import { apply } from '../lib/index.js';

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

const ctx = makeCtx();
const runtime = apply(ctx, { log: false, probe: false });
const shown = [];
runtime.notifier.notify = (input) => shown.push(input);

const agent = {
	id: 'session-verify-confirm',
	session: { id: 'session-verify-confirm', header: { id: 'session-verify-confirm', cwd: 'D:\\dsh' }, events: [] }
};

// Question path.
ctx.emit('user-questions/request', {
	agent,
	questions: [{ id: 'q1', question: '要用 TODO 板拆成步骤吗？' }]
}, () => Promise.resolve(null));

// Approval path.
ctx.emit('approval/request', {
	agent,
	toolName: 'pwsh',
	reason: '需要写工作区之外的目录'
}, () => Promise.resolve('unavailable'));

console.log(JSON.stringify(shown, null, 2));

const EXPECTED_TITLE = 'DeepSeek Harness';
let failures = 0;
if (shown.length !== 2) {
	console.error(`expected 2 notifications, got ${shown.length}`);
	failures += 1;
}
for (const [index, item] of shown.entries()) {
	if (item.title !== EXPECTED_TITLE) {
		console.error(`#${index + 1} title should be exactly ${JSON.stringify(EXPECTED_TITLE)}, got ${JSON.stringify(item.title)}`);
		failures += 1;
	}
	if (item.body !== '任务操作待确认') {
		console.error(`#${index + 1} body should be exactly 任务操作待确认, got ${JSON.stringify(item.body)}`);
		failures += 1;
	}
}
console.log(failures === 0 ? 'confirm format OK' : `${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
