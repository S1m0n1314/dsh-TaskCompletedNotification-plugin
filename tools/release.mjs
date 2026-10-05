/**
 * Publish a GitHub Release with the packaged zip attached.
 *
 *   node tools/release.mjs --dry-run     # show what would be published
 *   node tools/release.mjs               # create the release (tag v<version>)
 *
 * The token comes from Git's credential helper at run time, so no secret is
 * ever stored in this repository. Needs a token with the `repo` scope.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const version = manifest.version;
const tag = `v${version}`;
const repoUrl = String(manifest.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '');
const match = /github\.com\/([^/]+)\/([^/]+)$/.exec(repoUrl);
if (match === null) throw new Error(`cannot derive owner/repo from repository.url: ${repoUrl}`);
const [, owner, repo] = match;

const distDir = resolve(packageRoot, '..', 'dist');
const zipPath = join(distDir, `${manifest.name}-${version}.zip`);
const notesPath = join(packageRoot, 'RELEASE_NOTES.md');
const dryRun = process.argv.includes('--dry-run');

if (!existsSync(zipPath)) {
	throw new Error(`release asset missing: ${zipPath}\nrun: node tools/pack.mjs`);
}
const notes = existsSync(notesPath) ? readFileSync(notesPath, 'utf8').trim() : `# ${manifest.name} ${version}`;

/** Read the GitHub token from Git's credential helper (never from the repo). */
function githubToken() {
	const envToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	if (typeof envToken === 'string' && envToken.trim().length > 0) return envToken.trim();
	const filled = execFileSync('git', ['credential', 'fill'], {
		input: 'protocol=https\nhost=github.com\n\n',
		encoding: 'utf8'
	});
	const line = filled.split(/\r?\n/).find((l) => l.startsWith('password='));
	if (line === undefined) throw new Error('git credential fill returned no password for github.com');
	return line.slice('password='.length).trim();
}

async function api(path, init = {}) {
	const token = githubToken();
	const target = typeof init.url === 'string' ? init.url : `https://api.github.com${path}`;
	const response = await fetch(target, {
		method: init.method,
		headers: {
			Authorization: `token ${token}`,
			Accept: 'application/vnd.github+json',
			'User-Agent': 'dsh-taskcompletednotification-plugin-release',
			...(init.headers ?? {})
		},
		body: init.body
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${target} -> HTTP ${response.status}: ${text.slice(0, 400)}`);
	return text === '' ? null : JSON.parse(text);
}

console.log(`repo   : ${owner}/${repo}`);
console.log(`tag    : ${tag}`);
console.log(`asset  : ${zipPath} (${statSync(zipPath).size} bytes)`);
console.log(`notes  : ${existsSync(notesPath) ? 'RELEASE_NOTES.md' : '(generated default)'}`);
if (dryRun) {
	console.log('\n--- release body ---');
	console.log(notes);
	console.log('--- dry run: nothing published ---');
	process.exit(0);
}

const existing = await api(`/repos/${owner}/${repo}/releases/tags/${tag}`).catch(() => null);
const assetName = `${manifest.name}-${version}.zip`;

if (existing !== null && Array.isArray(existing.assets) && existing.assets.some((a) => a.name === assetName)) {
	console.log(`\nrelease ${tag} already has ${assetName}; nothing to do: ${existing.html_url}`);
	process.exit(0);
}

let release = existing;
if (release === null) {
	release = await api(`/repos/${owner}/${repo}/releases`, {
		method: 'POST',
		body: JSON.stringify({
			tag_name: tag,
			name: `${manifest.name} ${version}`,
			body: notes,
			draft: false,
			prerelease: false
		})
	});
	console.log(`\nrelease created: ${release.html_url}`);
} else {
	console.log(`\nrelease ${tag} exists without the asset; attaching: ${release.html_url}`);
}

// `upload_url` is already an absolute URL on the uploads host — do not rewrite
// its host, just append the asset name.
const uploadUrl = `${String(release.upload_url).replace(/\{.*$/, '')}?name=${encodeURIComponent(assetName)}`;
const uploaded = await api(null, {
	method: 'POST',
	url: uploadUrl,
	headers: { 'Content-Type': 'application/zip' },
	body: readFileSync(zipPath)
});
console.log(`asset uploaded: ${uploaded.name} (${uploaded.size} bytes)`);
console.log(`download link : ${uploaded.browser_download_url}`);
