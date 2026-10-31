# Code signing policy

**Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).**

HongSSH 的所有 Windows 发布产物（`HongSSH-<version>-setup.exe`、`HongSSH-<version>-portable.exe`）
都在 GitHub Actions 中从公开源码构建，再提交 SignPath 签名；不接受手动上传的二进制文件。

## 团队与职责

| 角色 | 成员 | 说明 |
| --- | --- | --- |
| Committers / Reviewers | [hongchekj Owners](https://github.com/orgs/hongchekj/people?query=role%3Aowner) | 有权合并代码、审核外部贡献 |
| Approvers | [hongchekj Owners](https://github.com/orgs/hongchekj/people?query=role%3Aowner) | 每次签名请求都需要一名 Approver 在 SignPath 控制台手动批准 |

所有成员均已为 GitHub 与 SignPath 账号启用多因素认证（MFA）。

## 签名流程

1. 维护者在仓库打 tag（`v1.0.1` 形式）并推送；
2. [`.github/workflows/signpath-release.yml`](../.github/workflows/signpath-release.yml) 在
   GitHub 托管的 `windows-latest` runner 上执行 `npm ci && npm run build && npx electron-builder --win nsis portable`；
3. 未签名产物作为 GitHub Actions artifact 上传，随后向 SignPath 提交签名请求；
4. SignPath 校验产物确实由该仓库的 GitHub Actions 构建，并由 Approver 手动批准后签名；
5. 签名后的文件发布到 GitHub Release。

签名使用 SignPath 的 HSM，私钥不会出现在仓库、构建机或发布流程中。

## 验证签名

下载 release 中的 exe 后，在 Windows PowerShell 中执行：

```powershell
Get-AuthenticodeSignature .\HongSSH-1.0.1-setup.exe |
  Format-List Status, SignerCertificate, TimeStamperCertificate
```

`Status` 应为 `Valid`，`SignerCertificate.Subject` 中应包含 `SignPath Foundation`，
且 `TimeStamperCertificate` 不为空（表示时间戳有效）。

## 隐私

This program will not transfer any information to other networked systems unless
specifically requested by the user or the person installing or operating it.

HongSSH 只在用户主动配置并启用时连接 SSH 服务器或 WebRTC 中继；中继地址与凭据由用户自行填写，
程序不内置任何服务端地址，也不会上报使用数据。
