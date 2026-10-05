# dsh-TaskCompletedNotification-plugin

[![发行包下载](https://img.shields.io/badge/%E5%8F%91%E8%A1%8C%E5%8C%85-%E4%B8%8B%E8%BD%BD-2ea44f?logo=github&logoColor=white)](https://github.com/S1m0n1314/dsh-TaskCompletedNotification-plugin/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![平台](https://img.shields.io/badge/platform-Windows-0078d4?logo=windows)

DeepSeek Harness 的 Windows 桌面通知插件：**任务跑完**、**模型在等你选择**、**模型在申请操作权限**时，
弹一条 Windows 横幅通知；点一下横幅，DSH 窗口会被拉到前台。

它解决的问题很简单：DSH 在后台跑长任务时，你不可能一直盯着窗口。以前你只能反复切回来看进度；
装上它以后，该回来的时候它会主动叫你。

## 功能

| 场景 | 通知标题 | 通知正文 |
|---|---|---|
| 一轮任务跑完 | `DeepSeek Harness` | `任务完成` |
| 模型调用 `ask_user_question` 等你选择 | `DeepSeek Harness` | `任务操作待确认` |
| 模型申请沙箱/权限升级等你授权 | `DeepSeek Harness` | `任务操作待确认` |

- **点横幅拉起窗口**：点通知后 DSH 窗口自动到前台（最小化也会被恢复）。
- **署名与图标是它自己**：通知显示为「DeepSeek Harness」+ Harness 图标，而不是「Windows PowerShell」。
- **一轮只弹一条**：同一轮里已经弹过「待确认」，这一轮结束时就不再重复弹「完成」。
- **子会话不打扰**：subagent 产生的轮次不通知，只通知你本人所在的会话。
- **不干扰 Harness**：全程只旁听事件，不改任何决定（审批/提问的执行路径完全不受影响）。

## 安装

### 从社区市场 / npm 安装（推荐）

```text
dsh plugin --profile web add dsh-TaskCompletedNotification-plugin
```

> 包名与仓库名一致（`package.json` 的 `name` 就是它）。这条命令要求包已经发布到 npm 仓库 ——
> 本插件目前**尚未发布**，所以现在请先用下面两种方式安装；一旦发布，上面这条命令即可直接使用。

### 从发行包安装

1. 在 [Releases](https://github.com/S1m0n1314/dsh-TaskCompletedNotification-plugin/releases/latest)
   下载 `dsh-TaskCompletedNotification-plugin-<version>.zip` 并解压
   （例如 `D:\plugins\dsh-TaskCompletedNotification-plugin-0.1.0`）；
2. 让 DSH 安装这个目录：

```text
plugin_manager action=install_bundle target="D:\plugins\dsh-TaskCompletedNotification-plugin-0.1.0"
```

### 从源码克隆

```powershell
git clone https://github.com/S1m0n1314/dsh-TaskCompletedNotification-plugin.git D:\plugins\dsh-TaskCompletedNotification-plugin
```

然后同样用 `install_bundle` 指向该目录。

### 手工装法（与上面等价）

把目录加进 profile 的 `package.json` 依赖，并在 profile 的 `cordis.patch.yml` 里插入：

```yaml
- insert:
    - id: dsh-TaskCompletedNotification-plugin
      name: 'dsh-TaskCompletedNotification-plugin'
```

**以上任一方式装完，都要完全退出并重启 DSH** —— 插件模块只在启动时载入一次。

## 使用说明

1. 正常用 DSH 干活，什么都不用做。
2. 任务跑完或模型需要你介入时，右下角会弹出通知（右下角横幅，同时进入通知中心）。
3. 点横幅（或通知中心里的那条）→ DSH 窗口回到前台，接着操作即可。
4. 不想被打扰时：在 `设置 → 系统 → 通知` 里关掉「DeepSeek Harness」，或把插件配置里的
   `enabled` 设成 `false`。

### 配置

改 profile 的 `cordis.patch.yml` 里 `dsh-TaskCompletedNotification-plugin` 那一行的 `config`，改完完全重启 DSH。
未填字段用默认值。

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关，`false` 时不注册任何监听。 |
| `notifyOnTurnEnd` | `true` | 任务完成通知。 |
| `notifyOnQuestion` | `true` | 模型提问通知。 |
| `notifyOnApproval` | `true` | 模型申请权限通知。 |
| `minTurnMs` | `0` | 短于该毫秒数的轮次不弹完成通知（`0` = 不限制）。 |
| `quietWhenActiveMs` | `0` | `0` = 完成通知一定弹；设 `15000` 表示「15 秒内你动过键鼠就不弹」（你正看着屏幕，不打扰）。 |
| `suppressTurnEndAfterAsk` | `true` | 一轮只弹一条：本轮回过问过/申请过权限，轮末不再弹「任务完成」。 |
| `title` | `DeepSeek Harness` | 通知标题，同时作为注册的显示名。 |
| `focusOnClick` | `true` | 点击横幅把 DSH 窗口拉到前台。 |
| `registerAppId` | `true` | 注册通知署名与图标。 |
| `timeoutMs` / `maxConcurrent` / `log` / `probe` | `15000` / `3` / `true` / `false` | 通知进程上限、并发数、诊断日志、诊断模式。 |

配置示例（关闭点击激活 + 只在离开电脑时提醒完成）：

```yaml
- id: dsh-TaskCompletedNotification-plugin
  name: 'dsh-TaskCompletedNotification-plugin'
  config:
    focusOnClick: false
    quietWhenActiveMs: 15000
```

### 截图

> 截图待补：需要在 Windows 上真机弹一条通知后截取横幅与通知中心两个画面。
> 你可以自己用 `node tools/send-test-toast.mjs "测试"` 弹一条来截，我会在这一节放图。

## 权限说明

插件**不需要管理员权限**，只使用当前用户可写的资源。具体会动到：

| 类别 | 具体内容 | 用途 |
|---|---|---|
| 用户目录写入 | `%USERPROFILE%\.dsh\dsh-TaskCompletedNotification-plugin\`（`log.ndjson`、`spool\`、`lib\`） | 诊断日志、通知暂存、点击处理器副本 |
| 用户级注册表（HKCU） | `HKCU\Software\Classes\AppUserModelId\DeepSeek.Harness.Notify` | 让通知署名显示为「DeepSeek Harness」+ 图标 |
| 用户级注册表（HKCU） | `HKCU\Software\Classes\dsh-TaskCompletedNotification-plugin` | 注册 `dsh-TaskCompletedNotification-plugin://` 协议，实现「点击横幅拉起窗口」；**插件卸载时会自动删除** |
| 进程 | 每次通知启动一个 `powershell.exe`（约 1 秒，用完即退，最多 3 个并发） | 调用 Windows 通知 API |
| 网络 | 无 | 插件本身不联网 |

不想要某些改动：`registerAppId: false` 关闭署名注册、`focusOnClick: false` 关闭点击激活、
`enabled: false` 彻底停用。

## 工作原理

**1. 事件从哪来** —— 插件挂在 Harness 宿主进程上，只旁听三类信号，从不干预：
会话日志里的 `turn/end`（`reason.kind === 'completed'`）、`user-questions/request`、
`approval/request`。监听器注册在 `ctx.root`（服务根）上并带 `{ global: true }`：
插件自己拿到的 context 不是服务根，而两个 `request` 事件是按 agent 作用域过滤的 waterfall，
不加这两条会被静默过滤掉、一个事件都收不到。

**2. 怎么变成通知** —— `lib/index.js` 把标题正文拼成 toast XML（自带 XML 转义），写进
`$DSH_HOME/dsh-TaskCompletedNotification-plugin/spool/`，再起一个 `powershell.exe` 执行 `lib/notify.ps1`；后者只做
`LoadXml` + `CreateToastNotifier(<已注册 AUMID>).Show()`，并把结果写回同名 `.result.txt` 便于排查。

**3. 署名与图标** —— 启动时把 `DeepSeek.Harness.Notify` 注册到
`HKCU\Software\Classes\AppUserModelId\`，Windows 才会把通知显示成「DeepSeek Harness」。

**4. 点击拉起窗口** —— 通知带 `activationType="protocol"` 与 `launch="dsh-TaskCompletedNotification-plugin://focus"`，
点击时由系统按协议启动一个无窗口的 `wscript` 启动器，再跑 `lib/focus-window.ps1`：
定位标题以 `DeepSeek Harness` 结尾的主窗口、必要时从最小化恢复，并在 `SetForegroundWindow`
被前台锁拒绝时依次改用 `AttachThreadInput`、按住 ALT 再抢。

## 自测

```powershell
node tools/smoke.mjs                  # 39 项离线测试，不需要 Windows 也能跑
node tools/send-test-toast.mjs "正文"  # 走插件自己的链路真弹一条
node tools/verify-click-focus.mjs      # 验证「点击拉起窗口」这条链
node tools/pack.mjs                    # 重新打包发行版到 ../dist/
node tools/release.mjs --dry-run       # 预览 GitHub Release 内容
npm run release                        # 打包 + 发布 Release（需 repo 权限的 GitHub 凭据）
```

## 许可证

[MIT](./LICENSE) © 2026 S1m0n1314 —— 可自由使用、修改、分发，保留版权声明即可。

---

由 ai 生成，仅供参考
