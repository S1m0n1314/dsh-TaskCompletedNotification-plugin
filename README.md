# dsh-TaskCompletedNotification-plugin

[![发行包下载](https://img.shields.io/badge/%E5%8F%91%E8%A1%8C%E5%8C%85-%E4%B8%8B%E8%BD%BD-2ea44f?logo=github&logoColor=white)](https://github.com/S1m0n1314/dsh-TaskCompletedNotification-plugin/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![平台](https://img.shields.io/badge/platform-Windows-0078d4?logo=windows)

DeepSeek Harness 的 Windows 通知插件。插件包名为 `dsh-win-notify`，仓库名为
`dsh-TaskCompletedNotification-plugin`，两者只是名字不同，装的是同一个东西。

| 场景 | 标题 | 正文 |
|---|---|---|
| 一轮任务跑完 | `DeepSeek Harness` | `任务完成` |
| 模型在等你选择，或申请操作权限 | `DeepSeek Harness` | `任务操作待确认` |

一点小细节：一轮里如果已经弹过「待确认」，这一轮结束就不再重复弹「完成」；
点一下通知横幅，DSH 窗口会被拉到前台；署名和图标也是它自己注册的，不显示成「Windows PowerShell」。

## 工作原理

**1. 事件从哪来** —— 插件挂在 Harness 的宿主进程上，只旁听三类信号，从不干预：

- 会话日志里的 `turn/end`（`reason.kind === 'completed'`）→ 一轮答完；
- `user-questions/request`（模型调 `ask_user_question`）→ 在等你选；
- `approval/request`（模型申请沙箱/权限升级）→ 在等你授权。

监听器注册在 `ctx.root`（服务根）上并带 `{ global: true }`：插件自己拿到的 context
不是服务根，而这两个 `request` 事件又是按 agent 作用域过滤的 waterfall，
不加这两条会被静默过滤掉、一个事件都收不到。

**2. 怎么变成通知** —— `lib/index.js` 把标题正文拼成一段 toast XML（自带 XML 转义），
写进 `$DSH_HOME/win-notify/spool/`，再起一个 `powershell.exe` 执行 `lib/notify.ps1`。
那个脚本只做两件事：`LoadXml` 加载 XML、`CreateToastNotifier(<已注册的 AUMID>).Show()`，
并把结果（`shown` / `skipped-user-active` / `show-failed: …`）写回同名 `.result.txt`，方便事后排查。

**3. 署名与图标** —— 启动时把 `DeepSeek.Harness.Notify` 这个 AppUserModelID 注册到
`HKCU\Software\Classes\AppUserModelId\`（带显示名与 Harness 图标），Windows 才会把通知
显示成「DeepSeek Harness」；不注册就只能显示宿主可执行文件的身份。

**4. 点击拉起窗口** —— 通知带 `activationType="protocol"` 与
`launch="dsh-win-notify://focus"`。点击时由系统按协议启动一个无窗口的 `wscript` 启动器
（不闪控制台），它再跑 `lib/focus-window.ps1`：找到标题以 `DeepSeek Harness` 结尾的主窗口，
必要时从最小化恢复，并在 `SetForegroundWindow` 被系统前台锁拒绝时依次改用
`AttachThreadInput`、按住 ALT 再抢。

**5. 不打扰的规则** —— 同一轮只弹一条；`quietWhenActiveMs` 默认 `0`（不静默，
完成通知一定弹），设成例如 `15000` 就是「你 15 秒内动过键鼠就不弹完成通知」。
子会话（subagent）不通知，要叫的是你本人。

## 安装

```powershell
plugin_manager action=install_bundle target="<解压或克隆出来的目录>"
```

装完**完全退出并重启 DSH**（插件模块只在启动时载入一次）。也可以直接在
[Releases](https://github.com/S1m0n1314/dsh-TaskCompletedNotification-plugin/releases/latest)
下载打包好的 zip，或克隆源码：

```powershell
git clone https://github.com/S1m0n1314/dsh-TaskCompletedNotification-plugin.git D:\plugins\dsh-win-notify
```

只用 PowerShell 与用户级注册表项，**不需要管理员权限**。它会写入：
`%USERPROFILE%\.dsh\win-notify\`（日志、通知暂存、点击处理器副本）、
`HKCU\Software\Classes\AppUserModelId\DeepSeek.Harness.Notify`、
`HKCU\Software\Classes\dsh-win-notify`（点击协议，卸载插件时自动删除）。

## 自测

```powershell
node tools/smoke.mjs                 # 38 项离线测试，不需要 Windows 也能跑
node tools/send-test-toast.mjs "正文" # 走插件自己的链路真弹一条
node tools/pack.mjs                  # 重新打包发行版到 ../dist/
```

---

由 ai 生成，仅供参考
