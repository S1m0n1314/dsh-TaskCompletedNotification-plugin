/**
 * Build a shareable release of this plugin.
 *
 *   node tools/pack.mjs
 *
 * Produces, under `<workspace>/dist/`:
 *   <package-name>-<version>/          the unpacked release directory
 *   <package-name>-<version>.zip       the file to hand to someone else
 *
 * The release directory is named after `package.json`'s `name`, so package
 * name, archive name and repository name stay in step.
 * The release directory mirrors the package (lib/ + tools/ + patch + README) and
 * adds INSTALL.md and SHA256SUMS.txt. Nothing machine-specific is written into
 * it: paths such as the icon location are discovered at runtime.
 */
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = resolve(packageRoot, '..');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const version = manifest.version;
const releaseName = `${manifest.name}-${version}`;
const distDir = join(workspace, 'dist');
const releaseDir = join(distDir, releaseName);

/** Everything a recipient needs, and nothing else. */
const INCLUDE = ['package.json', 'cordis.patch.yml', 'README.md', 'INSTALL.md', 'LICENSE', 'lib', 'tools'];

function listFiles(dir, base = dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listFiles(full, base));
		else if (entry.isFile()) out.push(relative(base, full).split('\\').join('/'));
	}
	return out.sort();
}

function sha256(file) {
	return createHash('sha256').update(readFileSync(file)).digest('hex');
}

console.log(`packing ${releaseName} from ${packageRoot}`);
rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(releaseDir, { recursive: true });

// Copy the shipped surface.
for (const entry of INCLUDE) {
	const from = join(packageRoot, entry);
	try {
		statSync(from);
	} catch {
		continue;
	}
	cpSync(from, join(releaseDir, entry), { recursive: true });
}

// A release is installable by anyone: drop the private marker.
const releaseManifestPath = join(releaseDir, 'package.json');
const releaseManifest = JSON.parse(readFileSync(releaseManifestPath, 'utf8'));
delete releaseManifest.private;
releaseManifest.keywords = [
	'deepseek',
	'deepseek-harness',
	'dsh',
	'dsh-plugin',
	'cordis',
	'windows',
	'notification',
	'toast'
];
writeFileSync(releaseManifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`, 'utf8');

// Install guide written for the recipient.
writeFileSync(join(releaseDir, 'INSTALL.md'), `# 安装 ${manifest.name} ${version}

## 前置条件

- Windows 10/11
- DeepSeek Harness（桌面版），Node.js >= 22.19
- 不需要管理员权限；插件只用 PowerShell 与用户级注册表项

## 步骤

1. 解开压缩包，得到 \`${releaseName}/\` 目录（放到一个以后不删的位置，例如
   \`D:\\plugins\\${releaseName}\`）。
2. 让 DSH 安装这个 bundle：

   \`\`\`
   plugin_manager action=install_bundle target="D:\\plugins\\${releaseName}"
   \`\`\`

   （等价的手工做法：把该目录加进 profile 的 \`package.json\` 依赖，
   并在 profile 的 \`cordis.patch.yml\` 里加一行
   \`- insert: - id: win-notify / name: '${manifest.name}'\`。）

3. **完全退出并重启 DSH**（托盘图标也退出）。插件模块只在启动时载入一次。
4. 验证：随便发一句话，等这一轮结束，应当看到一条标题「DeepSeek Harness」、
   正文「任务完成」的通知。也可以在插件目录里跑：

   \`\`\`
   node tools/send-test-toast.mjs "测试"
   \`\`\`

## 它会改动什么

- 在 \`%USERPROFILE%\\.dsh\\win-notify\\\` 下写诊断日志（\`log.ndjson\`）、通知暂存（\`spool\`）
  与点击处理器副本（\`lib\\\`，含 \`focus.log\`）。
- 在 \`HKCU\\Software\\Classes\\AppUserModelId\\DeepSeek.Harness.Notify\` 写 DisplayName / IconUri，
  并记一个 \`DshWinNotifyLibDir\` 指向处理器副本；这样通知署名显示为「DeepSeek Harness」
  而不是「Windows PowerShell」。
- 在 \`HKCU\\Software\\Classes\\dsh-win-notify\\\` 注册 \`dsh-win-notify://\` 协议，使**点击通知横幅
  能把 DSH 窗口拉到前台**（缺 \`URL Protocol\` 标记时 Windows 会改弹「获取应用」对话框）。
- 每次通知会起一个 \`powershell.exe\` 进程（约 1 秒），用完即退。

不要这些改动：\`registerAppId: false\` 关署名、\`focusOnClick: false\` 关点击激活。

## 配置

见 \`README.md\` 的配置表。改完 profile 的 \`cordis.patch.yml\` 后需要完全重启。

## 卸载

\`plugin_manager action=remove_bundle target="${manifest.name}"\`，或从 profile 的
\`package.json\` 依赖与 \`cordis.patch.yml\` 里移除后重启。

插件卸载时会自动删掉 \`HKCU\\Software\\Classes\\dsh-win-notify\`（点击协议；
协议名与包名无关，是稳定的 URL scheme）。
若插件目录被手工删除、清理函数没机会运行，请手工删这两个键并删目录：

- \`HKCU\\Software\\Classes\\dsh-win-notify\`
- \`HKCU\\Software\\Classes\\AppUserModelId\\DeepSeek.Harness.Notify\`
- \`%USERPROFILE%\\.dsh\\win-notify\\\`
`, 'utf8');

// Integrity manifest for the copies that matter.
const checksumLines = ['# sha256  file（用于校验解压后内容未被改动）'];
for (const file of ['lib/index.js', 'lib/notify.ps1', 'lib/focus-window.ps1', 'lib/focus-launcher.vbs', 'cordis.patch.yml', 'package.json']) {
	try {
		checksumLines.push(`${sha256(join(releaseDir, file))}  ${file}`);
	} catch {
		/* file absent from this release */
	}
}
writeFileSync(join(releaseDir, 'SHA256SUMS.txt'), `${checksumLines.join('\n')}\n`, 'utf8');

// Zip it. Compress-Archive keeps the directory at the archive root.
const zipPath = join(distDir, `${releaseName}.zip`);
rmSync(zipPath, { force: true });
execFileSync('powershell.exe', [
	'-NoProfile',
	'-NonInteractive',
	'-ExecutionPolicy',
	'Bypass',
	'-Command',
	`Compress-Archive -LiteralPath ${JSON.stringify(releaseDir)} -DestinationPath ${JSON.stringify(zipPath)} -Force`
], { stdio: 'inherit' });

console.log(`\nrelease dir : ${releaseDir}`);
console.log(`archive     : ${zipPath}  (${statSync(zipPath).size} bytes)`);
console.log('\ncontents:');
for (const file of listFiles(releaseDir)) console.log(`  ${file}  (${statSync(join(releaseDir, file)).size})`);
