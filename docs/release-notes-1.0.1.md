# HongSSH 1.0.1

Windows 上的 SSH 终端客户端：Electron + xterm.js，支持 SFTP、WebRTC 远程桌面、区域录屏与截图。

## 功能

- **SSH 终端**：xterm.js、256 色 / TrueColor、PTY，`top` / `vi` / `htop` / `less` 等全屏程序正常交互
- **SFTP**：上传、下载、递归传输、断点续传
- **远程桌面**：WebRTC P2P（对称 NAT 时可用 TURN 兜底），需自行部署中继并填写地址
- **区域录屏与截图**：多显示器框选，输出 WebM
- **配置导入导出**：兼容 Xshell 会话文件
- **凭据安全**：密码 / 私钥口令经 Windows DPAPI（Electron `safeStorage`）加密后保存在本地

## 安装

| 文件 | 说明 |
| --- | --- |
| `HongSSH-1.0.1-setup.exe` | NSIS 安装程序，按用户安装，无需管理员权限 |
| `HongSSH-1.0.1-portable.exe` | 免安装便携版，双击即用 |
| `HongSSH-1.0.1-win-x64.zip` | 解压即用的绿色版（`win-unpacked`） |

> **本版本尚未签名**：Windows SmartScreen 可能提示“未知发布者”，请核对下方 SHA256 后选择“仍要运行”。
> 后续版本将通过 [SignPath](https://signpath.org) 免费签名，签名政策见 [docs/code-signing.md](../docs/code-signing.md)。

## 远程桌面需要自建中继

本版本**不内置任何中继地址**。使用远程桌面前，请部署仓库根目录的 `relay-server.js`（或参考 `deploy-relay.sh`），
然后在「设置 → 远程控制（WebRTC 中继）」中填写 `wss://你的地址` 与 `HOST_TOKEN`。

## 校验

```powershell
Get-FileHash .\HongSSH-1.0.1-setup.exe -Algorithm SHA256
```

## 许可

MIT
