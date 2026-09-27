@echo off
setlocal
title Charging Champions Power Monitor
cd /d "%~dp0"

set "PYCMD="
py -3 --version >nul 2>nul && set "PYCMD=py -3"
if not defined PYCMD (
  python --version >nul 2>nul && set "PYCMD=python"
)
if not defined PYCMD (
  echo.
  echo   Python was not found on this PC.
  echo   Install it from https://www.python.org/downloads/  ^(tick "Add python.exe to PATH"^)
  echo   then double-click this file again.
  echo.
  pause
  exit /b 1
)

echo Starting local server on http://localhost:8100 ...
start "CC Power Server" /min cmd /c "%PYCMD% -m http.server 8100"
timeout /t 1 /nobreak >nul
start "" "http://localhost:8100/live.html"

echo.
echo   Dashboard opened in your browser.
echo   Enter your roboRIO address (e.g. 10.65.60.2) and click Connect.
echo   Keep the minimized "CC Power Server" window open while using it.
echo.
pause
