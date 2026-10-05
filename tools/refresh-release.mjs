/**
 * Replace a release's zip asset with the freshly packed one and refresh the body.
 *
 *   node tools/refresh-release.mjs
 *
 * `release.mjs` is idempotent by asset *name*, so a rebuild with the same name
 * would otherwise leave the old bytes attached. This forces the swap.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const version = manifest.version;
const tag = `v${version}`;
const repoUrl = String(manifest.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '');
const [, owner, repo] = /github\.com\/([^/]+)\/([^/]+)$/.exec(repoUrl);
const zipPath = resolve(packageRoot, '..', 'dist', `${manifest.name}-${version}.zip`);
const assetName = `${manifest.name}-${version}.zip`;
const notesPath = join(packageRoot, 'RELEASE_NOTES.md');
if (!existsSync(zipPath)) throw new Error(`missing asset: ${zipPath} (run node tools/pack.mjs)`);

function token() {
	const filled = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
	const line = filled.split(/\r?\n/).find((l) => l.startsWith('password='));
	if (line === undefined) throw new Error('no GitHub credential available');
	return line.slice('password='.length).trim();
}

async function api(url, init = {}) {
	const response = await fetch(url, {
		method: init.method,
		headers: {
			Authorization: `token ${token()}`,
			Accept: 'application/vnd.github+json',
			'User-Agent': 'dsh-TaskCompletedNotification-plugin-release',
			...(init.headers ?? {})
		},
		body: init.body
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${url} -> ${response.status}: ${text.slice(0, 300)}`);
	return text === '' ? null : JSON.parse(text);
}

const release = await api(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`);
for (const asset of release.assets ?? []) {
	if (asset.name !== assetName) continue;
	await api(`https://api.github.com/repos/${owner}/${repo}/releases/assets/${asset.id}`, { method: 'DELETE' });
	console.log(`removed stale asset: ${asset.name} (${asset.size} bytes)`);
}

const uploadUrl = `${String(release.upload_url).replace(/\{.*$/, '')}?name=${encodeURIComponent(assetName)}`;
const uploaded = await api(uploadUrl, {
	method: 'POST',
	headers: { 'Content-Type': 'application/zip' },
	body: readFileSync(zipPath)
});
console.log(`uploaded: ${uploaded.name} (${uploaded.size} bytes)`);

const body = readFileSync(notesPath, 'utf8').trim();
const updated = await api(`https://api.github.com/repos/${owner}/${repo}/releases/${release.id}`, {
	method: 'PATCH',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify({ body })
});
console.log(`release body refreshed: ${updated.html_url}`);
console.log(`download: ${uploaded.browser_download_url}`);
