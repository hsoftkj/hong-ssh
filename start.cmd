@echo off
setlocal
cd /d "%~dp0"

if exist "node_modules\electron\dist\electron.exe" (
  start "" "node_modules\electron\dist\electron.exe" .
  exit /b 0
)

echo HongSSH dependencies are not installed.
echo Run "npm install" first, then "npm start" or this script again.
pause
exit /b 1
