# dsh-win-notify

让 DeepSeek Harness 在该叫你的时候叫你：**任务完成**、**模型要你选一个**、**模型申请操作权限**时，
弹一条 Windows 通知。

```
┌────────────────────────────────────────────┐
│ DeepSeek Harness                    [icon] │
│ 任务完成                                   │
└────────────────────────────────────────────┘
```

通知内容刻意极简：

| | |
|---|---|
| **标题** | 永远只有应用名 `DeepSeek Harness`（可用 `title` 改） |
| **正文** | 只有一句固定文案：`任务完成`（一轮跑完）或 `任务操作待确认`（模型提问 / 申请权限） |

上下文（会话名、用时、token 数、回答预览、问题原文、工具与原因）**不放进弹窗**，
只写进 `$DSH_HOME/win-notify/log.ndjson`，这样弹窗永远干净。

署名与图标由插件自己负责：启动时把 `DeepSeek.Harness.Notify` 这个 AppUserModelID 注册到
`HKCU\Software\Classes\AppUserModelId\`（带 DisplayName 与 Harness 图标），Windows 就会把通知
显示成「DeepSeek Harness」而不是宿主可执行文件的「Windows PowerShell」。
不想要这个改动：`registerAppId: false`，或把 `appId` 换成 `POWERSHELL_APP_ID`（见配置表）。

**点横幅 = 把 DSH 窗口拉到前台。** 通知带 `activationType="protocol"` 与
`launch="dsh-win-notify://focus"`；插件启动时把该协议注册到
`HKCU\Software\Classes\dsh-win-notify`（含 `URL Protocol` 标记、友好名、图标），
命令指向一个无窗口的 `wscript` 启动器，启动器再跑 `focus-window.ps1` ——
它会定位标题以 `DeepSeek Harness` 结尾的主窗口、必要时从最小化恢复，并在
`SetForegroundWindow` 被前台锁拒绝时依次尝试 `AttachThreadInput` 与「按住 ALT 再抢」。
实测（Windows 11）：点横幅后 DSH 窗口确实跳到前台。
不想要：`focusOnClick: false`（通知退化为普通不可点样式）。

## 它监听什么

| 触发点 | 标题 | 正文 |
|---|---|---|
| 会话日志里的 `turn/end`（`reason.kind === 'completed'`） | `DeepSeek Harness` | `任务完成` |
| `user-questions/request` 瀑布（模型提问） | `DeepSeek Harness` | `任务操作待确认` |
| `approval/request` 瀑布（模型申请权限） | `DeepSeek Harness` | `任务操作待确认` |

**决策规则：一轮一条，按性质选文案。**

| 这一轮的性质 | 弹 | 文案 |
|---|---|---|
| 问过用户 / 申请过权限 | 在提问那一刻弹 | `任务操作待确认` |
| 没问过、直接答完 | 轮末弹 | `任务完成` |
| 问过、之后又答完（同一轮） | **只弹一次**（那一条「待确认」） | — |

这条规则由 `suppressTurnEndAfterAsk` 实现；设成 `false` 就会为同一轮弹两条。
早先「该弹却没弹」的坑不在规则本身，而在 `quietWhenActiveMs` 静默阈值 ——
它默认已改为 `0`（关闭），所以完成通知现在一定会弹。

三条都是**纯旁观**：本插件对 waterfall 永远 `next()`、绝不返回决定，所以它不可能让一次审批或一次提问失败。
子会话（`header.origin === 'subagent'`、或有 `parentSession`）**不通知** —— 你要的是 Harness 本体叫你。

## 三条必须记住的实现约束

都是实测踩出来的，改动时不要退回去：

1. **监听器必须注册在 `ctx.root` 上，并且带 `{ global: true }`。**
   插件 `apply()` 拿到的 context **不是**服务根（激活日志里的 `sameRoot` 为 `false`）。在插件自己的
   context 上 `ctx.on(...)` 注册出来的监听器收不到 Host 事件总线上的任何事件 —— 实测同一份代码
   在插件 context 上注册 6 次、事件线为 0；改到 `ctx.root` 后 `agent/created`、`agent/status`、
   `tools/result`、`internal/dispatch` 全部到达。
   另外 `user-questions/request` 与 `approval/request` 走的是 `scopeTarget(agent, agent)`
   这个**带过滤的 carrier**：只放行「没有 scope 标签」或「标签在该 agent 作用域链上」的监听器。
   `{ global: true }` 会跳过 context 过滤（`cordis/src/events.ts` 的 `dispatch()`）。

2. **`debug` 级日志在宿主里看不到。**
   宿主的日志导出器只放行 info 及以上，`log('debug', ...)` 写不进 `log.ndjson`。
   早期正是这条让我误判「探针没响 / 监听器没装」。诊断行因此一律用 `info`。

3. **toast 的 XML 必须由插件拼好、交由 `LoadXml` 加载，不能用 `GetTemplateContent` + `CreateElement`。**
   `$xml.CreateElement('text')` 不带命名空间，建出来的是**空命名空间**节点；把它 append 到模板里
   带命名空间的 `<text id="1">` 上会生成嵌套的坏标记：

   ```
   <text id="1"><text>标题<text>正文</text></text></text><text id="2"></text>
   ```

   Windows 于是只渲染它自己的通用头部「新通知」，标题和正文全丢。实测对比确认：
   同样内容用 `LoadXml` 加载就完全正常。现在 `lib/index.js` 负责拼标记（含 XML 转义）并写到 spool，
   `lib/notify.ps1` 只做 `LoadXml` + `Show`。

   附带一条：`CreateToastNotifier()` **无参重载在 PowerShell 5.1 下抛 0x80070490**
   （"找不到元素"），必须显式传 AUMID。

## 安装

### 从 GitHub 克隆

```powershell
git clone https://github.com/S1m0n1314/dsh-TaskCompletedNotification-plugin.git D:\plugins\dsh-win-notify
```

然后在 DSH 里：

```
plugin_manager action=install_bundle target="D:\plugins\dsh-win-notify"
```

### 从发行包

解压 `dsh-win-notify-<version>.zip` 后，让 DSH 安装该目录（换成你的实际路径）：

```
plugin_manager action=install_bundle target="D:\plugins\dsh-win-notify-0.1.0"
```

### 手工装法（两者等价）

把目录加进 profile 的 `package.json` 依赖，并在 profile 的 `cordis.patch.yml` 里插入这行：

```yaml
- insert:
    - id: win-notify
      name: 'dsh-win-notify'
```

**装完都要完全退出并重启 DSH**（插件模块只在启动时载入一次）。

## 配置

改 profile 的 `cordis.patch.yml` 里 `win-notify` 那一行的 `config`（改完**完全重启** DSH 生效）。
未填字段用默认值。

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关。`false` 时不注册任何监听。 |
| `notifyOnTurnEnd` | `true` | 任务完成通知。 |
| `notifyOnQuestion` | `true` | 模型提问通知。 |
| `notifyOnApproval` | `true` | 模型申请权限通知。 |
| `minTurnMs` | `0` | 短于这个毫秒数的轮次不弹完成通知（`0` = 不限制）。 |
| `quietWhenActiveMs` | `0` | `0` = 完成通知一定弹。设成例如 `15000` 就是「最近 15 秒内你动过键鼠（= 你正看着屏幕）就不弹」。提问/授权通知不受它影响。 |
| `suppressTurnEndAfterAsk` | `true` | 一轮只弹一条：这一轮问过用户/申请过权限，轮末就不再重复弹「任务完成」。设 `false` 会为同一轮弹两条。 |
| `title` | `DeepSeek Harness` | 通知标题前缀，同时作为注册的 AppUserModelID 显示名。 |
| `appId` | `DeepSeek.Harness.Notify` | 通知署名的 AppUserModelID。换成 `POWERSHELL_APP_ID` 就退回「Windows PowerShell」署名。 |
| `registerAppId` | `true` | 启动时把 `appId` 注册到 HKCU（写入 DisplayName / IconUri），让 Windows 显示「DeepSeek Harness」+ 图标。 |
| `focusOnClick` | `true` | 点通知横幅把 DSH 窗口拉到前台：注册 `dsh-win-notify://` 协议 + 部署无窗口启动器。设 `false` 则通知不可点。 |
| `icon` | `''` | 注册用的图标路径；空 = 自动探测（环境变量 `DSH_WIN_NOTIFY_ICON`、`DSH_INSTALL_DIR`、argv 里的 `app.asar` 路径、常见安装目录）。 |
| `timeoutMs` | `15000` | 单条通知的 PowerShell 进程上限，超时杀掉。 |
| `maxConcurrent` | `3` | 同时在跑的 PowerShell 进程数；超出记一条 info 后丢弃。 |
| `log` | `true` | 写诊断日志 `$DSH_HOME/win-notify/log.ndjson`（超过 256 KB 自动清空）。 |
| `probe` | `false` | 诊断模式：额外注册 `internal/dispatch`、`agent/created` 等监听并打点，用于排查「事件到底有没有到」。 |

## 排障：通知没弹

按顺序看这三处，基本能定位：

1. `$DSH_HOME/win-notify/log.ndjson`
   - 有 `win-notify: activating` + `listeners registered` → 插件已加载；
   - 缺 → 插件没装/没启用（`plugin_manager list_plugins` 看 `include:win-notify` 的 `fiberPhase`）。
2. `$DSH_HOME/win-notify/spool/`（每条通知一组三个文件）
   - `*.json`：标题与正文（诊断用）；
   - `*.xml`：真正交给 Windows 的 toast 标记，**标题渲染不对时先看这里**；
   - `*.result.txt`：`shown` = Windows 已接收（没弹就是系统通知设置/专注助手挡了）；
     `skipped-user-active` = 被静默阈值拦下（仅在把 `quietWhenActiveMs` 设成非 0 时才会出现）；
     `show-failed: ...` / `winrt-unavailable: ...` = 通知层报错，按文案处理；
   - **目录为空** → 事件没到，开 `probe: true` 重启再看。
3. 事件到底有没有到：把 `probe: true` 写进配置重启，日志里会出现
   `probe: self-test round trip`（管道连通）、`probe: internal/listener`（注册清单）、
   `win-notify: turn/end observed` / `user question observed` / `approval observed`。

## 已知限制（实测）

- **署名靠 HKCU 注册表项。** 插件会在 `HKCU\Software\Classes\AppUserModelId\DeepSeek.Harness.Notify`
  写入 `DisplayName` / `IconUri`。删掉这个键、或把 `registerAppId` 设成 `false`，
  署名就会退回「Windows PowerShell」（通知本身照常弹）。这是用户级键，不需要管理员权限。
  早期版本曾观察到「自建 AUMID 会让标题变成『新通知』」，那是**坏 XML 的连带症状**，
  标记构造修好后不复现（见上面第 3 条约束）。
- **需要允许通知。** 请在 `设置 → 系统 → 通知` 里确认「DeepSeek Harness」（或 PowerShell）没被关掉
  （专注助手/勿扰也会压掉）。
- **点击激活依赖协议注册。** 插件写 `HKCU\Software\Classes\dsh-win-notify`；缺 `URL Protocol`
  标记时 Windows 会改弹「获取应用」对话框（这个坑已踩过并修好）。卸载插件时插件会自己删掉这个键
  （`ctx.effect` 的清理函数），但**手工删掉插件目录不会触发清理** —— 那时请手动删除
  `HKCU\Software\Classes\dsh-win-notify`，并忽略随之失效的 `DshWinNotifyLibDir` 值。
- **抢前台遵循 Windows 前台锁。** 常规情况一次 `SetForegroundWindow` 即可；被拒时依次尝试
  `AttachThreadInput` 与按住 ALT 再抢。极端情况（前台程序以更高权限运行）仍可能失败 —— 那时
  任务栏/Alt+Tab 依旧可用。
- **只在 Windows 上工作。** 非 Windows 平台请设 `enabled: false`；`notify.ps1` 缺失时插件仍能加载，
  只是通知失败并记一条 warn。
- **配置或代码改动需要完全重启 DSH。** Loader 的 `config` 是整行替换的；插件模块也只在启动时载入一次。

## 自测

```powershell
# 在插件目录里执行（把 <plugin-dir> 换成实际路径）
node tools/smoke.mjs                          # 34 项，离线，不需要 Windows
node tools/verify-turnend.mjs --dry-run       # 只打印「任务完成」的格式化结果，不弹窗
node tools/verify-turnend.mjs                 # 合成 turn/end，走真实链路真弹一条
node tools/verify-confirm.mjs                 # 校验提问/授权两条链的正文格式
node tools/send-test-toast.mjs "正文"          # 走插件自己的链路真弹一条
node tools/pack.mjs                           # 打一个可分享的发行包到 ../dist/
```

`verify-turnend.mjs` 的用处：不必等一次真实的轮次结束，直接用真实 `lib/index.js`
（只把 Cordis context 换成桩）把合成的 `turn/end completed` 打进完整的
折叠 → 拼正文 → 派发路径，用来回归「任务完成」这条链；`--dry-run` 只打印格式化结果。
`verify-confirm.mjs` 同理，覆盖提问与授权两条链。

## 文件

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 监听三个事件、折叠会话状态、拼 toast 标记、注册通知署名与点击协议、拉起通知进程。 |
| `lib/notify.ps1` | 只含 ASCII 的启动器：`LoadXml` + `CreateToastNotifier($AppId).Show()`，并把结果写进 `*.result.txt`。 |
| `lib/focus-window.ps1` | 点击后跑的抢前台脚本（定位主窗口、恢复、破前台锁）。 |
| `lib/focus-launcher.vbs` | 无窗口启动器：经 AppUserModelId 键解析上面的脚本路径并用隐藏窗口启动。 |
| `cordis.patch.yml` | bundle 插入 `win-notify` 行。 |
| `tools/smoke.mjs` | 用桩 context 驱动三类事件，断言标题/正文契约与标记转义。 |
| `tools/send-test-toast.mjs` | 走插件自己的链路真弹一条。 |
| `tools/verify-turnend.mjs` | 合成完成轮次，验证「任务完成」链并真弹。 |
| `tools/verify-confirm.mjs` | 校验提问/授权链的正文就是那两句固定文案。 |
| `tools/verify-click-focus.mjs` | 部署并注册点击处理器，可选发一条可点击通知做人工点击验证。 |
| `tools/pack.mjs` | 打包成可分享的发行包（`dist/dsh-win-notify-<version>/` + `.zip`）。 |

## 分享给别人

```powershell
node tools/pack.mjs
```

会在工作区的 `dist/` 下生成：

- `dsh-win-notify-0.1.0/` —— 解压即用的发行目录（`lib/`、`tools/`、`cordis.patch.yml`、`README.md`、
  `INSTALL.md`、`SHA256SUMS.txt`），`package.json` 里的 `private` 会被去掉；
- `dsh-win-notify-0.1.0.zip` —— 直接发给别人的文件。

包里不含任何本机路径：图标位置、PowerShell 路径都在运行时探测，对方装到任意目录都能跑。
对方拿到后按 `INSTALL.md` 走即可（核心是 `plugin_manager install_bundle` + 完全重启）。
