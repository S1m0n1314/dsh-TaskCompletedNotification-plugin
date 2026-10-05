/**
 * Fire one real Windows toast through the plugin's own notifier, exactly as a
 * turn-end notification would. Use it to confirm this machine can show the
 * popup before installing the plugin.
 *
 *   node tools/send-test-toast.mjs ["正文"]
 */

import { createNotifier, normalizeConfig } from '../lib/index.js';

const custom = process.argv[2];
const config = normalizeConfig({ log: true });
const notifier = createNotifier(config, {
	logger: (level, message, extra) => console.log(`[${level}] ${message}${extra === undefined ? '' : ` ${extra}`}`)
});

notifier.notify({
	title: `${config.title} · 任务已完成`,
	body: `这是一条自测通知（正文里带中文和 emoji ✅）\n${custom === undefined ? '来自 dsh-taskcompletednotification-plugin 的 tools/send-test-toast.mjs' : custom}`
});
console.log(`markup spool: ${notifier.payloadDir}`);

// Keep the process alive until the toast process exits (the notifier's own
// timer is unref'd, so a bare exit would kill the child before it shows).
const started = Date.now();
const tick = setInterval(() => {
	if (notifier.inflight.size === 0 || Date.now() - started > config.timeoutMs) {
		clearInterval(tick);
		console.log(`done (inflight=${notifier.inflight.size})`);
	}
}, 100);
