# 发布 HongSSH 1.0.1 到 GitHub Release
#
# 用法：
#   pwsh -File scripts/publish-release.ps1                 # 立即尝试发布
#   pwsh -File scripts/publish-release.ps1 -WaitMinutes 30 # 等待组织解除归档后再发布
#
# 凭据来自 Git Credential Manager（git credential fill），不需要手动输入 token。

param(
  [string]$Repo = 'hongchekj/hong-ssh',
  [string]$Tag = 'release1.0.1',
  [string[]]$Assets = @('release\HongSSH-1.0.1-setup.exe', 'release\HongSSH-1.0.1-portable.exe'),
  [string]$NotesFile = 'docs\release-notes-1.0.1.md',
  [int]$WaitMinutes = 0
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

function Get-GitHubToken {
  $cred = ("protocol=https`nhost=github.com`n`n" | git credential fill) 2>$null
  $t = (($cred | Select-String '^password=').Line) -replace '^password=', ''
  if (-not $t) { throw '无法从 Git Credential Manager 取到 GitHub 凭据' }
  return $t
}

$token = Get-GitHubToken
$headers = @{
  Authorization          = "Bearer $token"
  'User-Agent'           = 'hong-ssh-release-script'
  Accept                 = 'application/vnd.github+json'
}
$owner = $Repo.Split('/')[0]

function Write-Log([string]$msg) {
  Write-Output ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg)
}

# --- 1. 等待组织解除归档 ---------------------------------------------------
$deadline = (Get-Date).AddMinutes($WaitMinutes)
while ($true) {
  $org = Invoke-RestMethod "https://api.github.com/orgs/$owner" -Headers $headers
  if (-not $org.archived_at) { break }
  if ((Get-Date) -gt $deadline) {
    Write-Log "等待超时：组织 $owner 仍处于归档状态（archived_at=$($org.archived_at)）"
    exit 2
  }
  Write-Log "组织仍归档（archived_at=$($org.archived_at)），15 秒后重试…"
  Start-Sleep -Seconds 15
}
Write-Log "组织已解除归档"

# --- 2. 必要时解除仓库归档 -------------------------------------------------
$repoInfo = Invoke-RestMethod "https://api.github.com/repos/$Repo" -Headers $headers
if ($repoInfo.archived) {
  Write-Log '仓库仍为归档状态，尝试解除…'
  Invoke-RestMethod "https://api.github.com/repos/$Repo" -Method Patch -Headers $headers `
    -ContentType 'application/json' -Body '{"archived":false}' | Out-Null
  Start-Sleep -Seconds 3
  $repoInfo = Invoke-RestMethod "https://api.github.com/repos/$Repo" -Headers $headers
  if ($repoInfo.archived) { throw '仓库仍无法解除归档' }
}
Write-Log "仓库可写：$Repo"

# --- 3. 定位 release -------------------------------------------------------
$release = $null
try {
  $release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/tags/$Tag" -Headers $headers
} catch {
  Write-Log "tag $Tag 下没有 release，创建新的…"
  $body = @{ tag_name = $Tag; name = "HongSSH $Tag"; draft = $false } | ConvertTo-Json -Compress
  $release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases" -Method Post -Headers $headers `
    -ContentType 'application/json' -Body $body
}
Write-Log "release id=$($release.id)，现有资产 $($release.assets.Count) 个"

# --- 4. 写入发布说明 -------------------------------------------------------
if (Test-Path $NotesFile) {
  $notes = [IO.File]::ReadAllText((Resolve-Path $NotesFile), [Text.Encoding]::UTF8)
  $payload = @{ body = $notes } | ConvertTo-Json -Depth 3
  $tmp = Join-Path $env:TEMP 'release-body.json'
  [IO.File]::WriteAllText($tmp, $payload, (New-Object Text.UTF8Encoding($false)))
  $patchCode = curl.exe -s -o "$env:TEMP\release-patch.json" -w "%{http_code}" -X PATCH `
    -H "Authorization: Bearer $token" -H "Accept: application/vnd.github+json" `
    -H "User-Agent: hong-ssh-release-script" -H "Content-Type: application/json; charset=utf-8" `
    --data-binary "@$tmp" "https://api.github.com/repos/$Repo/releases/$($release.id)"
  if ($patchCode -ne '200') {
    Write-Log ("写入发布说明失败 HTTP {0}：{1}" -f $patchCode, (Get-Content "$env:TEMP\release-patch.json" -Raw))
    exit 1
  }
  Write-Log "发布说明已写入（$($notes.Length) 字符）"
}

# --- 5. 上传资产 -----------------------------------------------------------
foreach ($asset in $Assets) {
  if (-not (Test-Path $asset)) { Write-Log "跳过（文件不存在）：$asset"; continue }
  $name = Split-Path $asset -Leaf
  $size = (Get-Item $asset).Length
  $existing = $release.assets | Where-Object { $_.name -eq $name }
  if ($existing) {
    Write-Log "已存在同名资产，先删除：$name"
    Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/assets/$($existing.id)" -Method Delete -Headers $headers | Out-Null
  }
  Write-Log ("上传 {0}（{1:N1} MB）…" -f $name, ($size / 1MB))
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $url = "https://uploads.github.com/repos/$Repo/releases/$($release.id)/assets?name=$([uri]::EscapeDataString($name))"
  $resp = curl.exe -s -w "`n%{http_code}" -X POST `
    -H "Authorization: Bearer $token" -H "Accept: application/vnd.github+json" `
    -H "User-Agent: hong-ssh-release-script" -H "Content-Type: application/octet-stream" `
    --data-binary "@$asset" $url
  $sw.Stop()
  $code = ($resp -split "`n")[-1]
  if ($code -ne '200' -and $code -ne '201') {
    Write-Log ("上传失败 HTTP {0}：{1}" -f $code, (($resp -split "`n")[0..($resp.Length - 2)] -join ''))
    exit 1
  }
  Write-Log ("上传完成，用时 {0:N0}s" -f $sw.Elapsed.TotalSeconds)
}

# --- 6. 校验 ---------------------------------------------------------------
$final = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/$($release.id)" -Headers $headers
Write-Log "最终资产："
foreach ($a in $final.assets) {
  Write-Log ("  {0}  {1:N1} MB  {2}" -f $a.name, ($a.size / 1MB), $a.browser_download_url)
}
Write-Log "完成：$($final.html_url)"
