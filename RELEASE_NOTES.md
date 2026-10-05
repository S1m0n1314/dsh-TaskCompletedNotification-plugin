## 名称统一（0.1.0）

所有可识别名称统一为 `dsh-taskcompletednotification-plugin`：

| 项 | 值 |
|---|---|
| npm 包名 / loader 身份 / 插件行 id | `dsh-taskcompletednotification-plugin` |
| 数据目录 | `%USERPROFILE%\.dsh\dsh-taskcompletednotification-plugin\` |
| 点击协议 | `dsh-taskcompletednotification-plugin://focus` |
| 注册表键 | `HKCU\Software\Classes\dsh-taskcompletednotification-plugin` |
| 通知署名 | `DeepSeek Harness`（AUMID `DeepSeek.Harness.Notify`） |

> 如果你装过更早的 `dsh-win-notify` 版本，旧注册表键与旧数据目录不会被自动清理，可手动删除：
> `HKCU\Software\Classes\dsh-win-notify`、`%USERPROFILE%\.dsh\win-notify\`。

## 功能

DeepSeek Harness 的 Windows 桌面通知插件。解决一个问题：DSH 在后台跑长任务时你不用一直盯着窗口，
该回来的时候它叫你。

- 一轮跑完 → 通知标题 `DeepSeek Harness`、正文 `任务完成`
- 模型提问（`ask_user_question`）或申请操作权限 → 正文 `任务操作待确认`
- 点通知横幅 → DSH 窗口回到前台（最小化也会恢复）
- 署名与图标显示为「DeepSeek Harness」+ Harness 图标，而不是「Windows PowerShell」
- 一轮只弹一条；subagent 子会话不打扰；全程只旁听事件，不干预任何决定

## 安装

解压后让 DSH 安装该目录，然后**完全退出并重启 DSH**：

```text
plugin_manager action=install_bundle target="<解压出来的目录>"
```

也可以从源码克隆：`git clone https://github.com/S1m0n1314/dsh-TaskCompletedNotification-plugin.git`

## 权限

不需要管理员权限。会写入 `%USERPROFILE%\.dsh\dsh-taskcompletednotification-plugin\`（日志/暂存/点击处理器副本）、
`HKCU\Software\Classes\AppUserModelId\DeepSeek.Harness.Notify`（署名与图标）、
`HKCU\Software\Classes\dsh-taskcompletednotification-plugin`（点击拉起窗口的协议，卸载时自动删除）。
每次通知启动一个约 1 秒的 `powershell.exe`；插件本身不联网。

## 校验

包内含 `SHA256SUMS.txt`，可核对关键文件：

```powershell
Get-FileHash lib\index.js -Algorithm SHA256
```

## 许可证

MIT —— 详见包内 `LICENSE`。
