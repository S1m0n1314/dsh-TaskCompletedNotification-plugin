// Verify click-to-focus on this machine.
//
//   node tools/verify-click-focus.mjs            raise the window via the shipped handler
//   node tools/verify-click-focus.mjs --stage    stage + register exactly like `apply()` does
//   node tools/verify-click-focus.mjs --toast    send a real clickable toast
//
// The plugin's own handler files are used, so a pass here means the click path
// works as shipped.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureClickToFocus, ensureBrand, harnessIconPath, packageRoot } from '../lib/index.js';

const args = new Set(process.argv.slice(2));
const PROTOCOL = 'dsh-taskcompletednotification-plugin';
const APP_ID = 'DeepSeek.Harness.Notify';
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const dataDir = join(process.env.DSH_HOME ?? '.', 'dsh-taskcompletednotification-plugin');
const spool = join(dataDir, 'spool');
const stagedLib = join(dataDir, 'lib');
mkdirSync(spool, { recursive: true });

const log = (level, message, extra) => console.log(`[${level}] ${message}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`);

if (args.has('--stage')) {
	console.log('package root:', packageRoot());
	const click = ensureClickToFocus(join(packageRoot(), 'lib'), stagedLib, PROTOCOL, log);
	console.log('ensureClickToFocus:', JSON.stringify(click));
	const brand = ensureBrand(APP_ID, harnessIconPath(), 'DeepSeek Harness', click.libDir, log);
	console.log('ensureBrand:', JSON.stringify(brand));
}

const launcher = join(stagedLib, 'focus-launcher.vbs');
console.log(`\nlauncher: ${launcher}`);
const run = spawnSync('cscript.exe', ['//nologo', launcher], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
console.log(`launcher exit=${run.status} out=${JSON.stringify((run.stdout ?? '').trim())} err=${JSON.stringify((run.stderr ?? '').trim().slice(0, 200))}`);

const probe = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', `
Add-Type -Namespace T -Name F -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
'@
$h = [T.F]::GetForegroundWindow(); $p = 0
$null = [T.F]::GetWindowThreadProcessId($h, [ref]$p)
$proc = Get-Process -Id $p -ErrorAction SilentlyContinue
Write-Output ("foreground pid=" + $p + " name=" + $proc.ProcessName + " title=" + $proc.MainWindowTitle)
`], { encoding: 'utf8', windowsHide: true });
console.log((probe.stdout ?? '').trim());

if (args.has('--toast')) {
	const xml = join(spool, 'click-toast.xml');
	writeFileSync(xml, `<toast activationType="protocol" launch="${PROTOCOL}://focus"><visual><binding template="ToastText02">`
		+ '<text id="1">DeepSeek Harness</text><text id="2">任务完成</text>'
		+ '</binding></visual></toast>', 'utf8');
	const res = join(spool, 'click-toast.result.txt');
	const show = spawnSync(PS, [
		'-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
		'-File', join(packageRoot(), 'lib', 'notify.ps1'),
		'-Markup', xml, '-AppId', APP_ID, '-Result', res
	], { encoding: 'utf8', windowsHide: true });
	console.log(`toast dispatched, result=${(spawnSync('cmd.exe', ['/c', 'type', res], { encoding: 'utf8' }).stdout ?? '').trim()}`);
	console.log('>>> 现在点击那条横幅通知；窗口应当被拉到前台。');
}
