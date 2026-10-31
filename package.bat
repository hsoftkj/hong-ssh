@echo off
setlocal EnableExtensions
chcp 65001 >nul
title HongSSH 打包

cd /d "%~dp0"

echo ==========================================
echo   HongSSH Windows 打包
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 Node.js 20 或更高版本。
  goto :fail
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 npm，请检查 Node.js 安装。
  goto :fail
)

for /f "delims=" %%v in ('node -p "process.versions.node"') do set "NODE_VERSION=%%v"
for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]"') do set "NODE_MAJOR=%%v"
echo Node.js %NODE_VERSION%
if %NODE_MAJOR% LSS 20 (
  echo [错误] 需要 Node.js 20 或更高版本，当前为 %NODE_VERSION%。
  goto :fail
)
echo.

rem 如果 Electron 下载很慢，可以取消下一行注释使用国内镜像：
rem set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"

if not exist "node_modules\electron-builder\package.json" goto :install
if not exist "node_modules\electron\dist\electron.exe" goto :install

echo [1/3] 依赖已安装，跳过 npm install
goto :build

:install
echo [1/3] 安装依赖（首次可能需要几分钟）...
call npm install --no-audit --no-fund
if errorlevel 1 goto :fail

:build
echo.
echo [2/3] 构建前端...
call npm run build
if errorlevel 1 goto :fail

echo.
echo [3/3] 生成安装包和便携版...
call :clean_release
if errorlevel 1 goto :fail
call npm run dist
if errorlevel 1 goto :fail

for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set "VERSION=%%v"
if not exist "release\HongSSH-%VERSION%-setup.exe" (
  echo.
  echo [错误] 打包命令已结束，但没有找到安装包。
  goto :fail
)

echo.
echo ==========================================
echo   打包完成：HongSSH %VERSION%
echo ==========================================
for %%F in ("release\HongSSH-%VERSION%-setup.exe" "release\HongSSH-%VERSION%-portable.exe") do (
  echo   %%~nxF  %%~zF 字节
)
echo.
echo 输出目录：%~dp0release
echo.

if /i "%HONGSSH_NO_PAUSE%"=="1" goto :done
choice /c YN /n /m "是否打开输出目录？[Y/N] "
if errorlevel 2 goto :done
start "" explorer "%~dp0release"

:done
if /i not "%HONGSSH_NO_PAUSE%"=="1" pause
exit /b 0

:fail
echo.
echo 打包失败，请检查上面的错误信息。
echo 如果提示 Access is denied，请关闭正在运行的 HongSSH 或杀毒软件后重试。
if /i not "%HONGSSH_NO_PAUSE%"=="1" pause
exit /b 1

:clean_release
rem electron-builder 需要先清空 release\win-unpacked；文件被运行时占用时
rem 先重试，仍失败则询问是否关闭 HongSSH。
if not exist "release\win-unpacked" exit /b 0
set "CLEAN_TRIES=0"

:clean_retry
rmdir /s /q "release\win-unpacked" >nul 2>&1
if not exist "release\win-unpacked" exit /b 0
set /a CLEAN_TRIES+=1
if %CLEAN_TRIES% GEQ 3 goto :clean_locked
ping -n 3 127.0.0.1 >nul
goto :clean_retry

:clean_locked
echo.
echo [提示] release\win-unpacked 被占用，通常是 HongSSH 正在运行或杀毒软件正在扫描。
if /i "%HONGSSH_NO_PAUSE%"=="1" goto :clean_kill
choice /c YN /n /m "是否关闭正在运行的 HongSSH 后继续？[Y/N] "
if errorlevel 2 exit /b 1

:clean_kill
echo 正在关闭占用 release\win-unpacked 的 HongSSH 进程...
powershell -NoProfile -Command "$root=[IO.Path]::GetFullPath('%~dp0release\win-unpacked'); Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'HongSSH.exe' -and $_.CommandLine -and $_.CommandLine.Contains($root) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
ping -n 4 127.0.0.1 >nul
rmdir /s /q "release\win-unpacked" >nul 2>&1
if exist "release\win-unpacked" (
  echo [错误] 仍无法删除 release\win-unpacked，请手动关闭 HongSSH 或杀毒软件后重试。
  exit /b 1
)
exit /b 0
