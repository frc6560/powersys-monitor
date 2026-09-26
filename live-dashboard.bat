@echo off
REM ============================================================
REM  Charging Champions - Live Power Monitor  (Windows launcher)
REM  Double-click this. It serves this folder over http and opens
REM  the live dashboard so it can reach the robot over ws://.
REM ============================================================
title Charging Champions Power Monitor
cd /d "%~dp0"

REM Find Python (the "py" launcher or "python" on PATH)
set "PYCMD="
where py >nul 2>nul && set "PYCMD=py"
if not defined PYCMD where python >nul 2>nul && set "PYCMD=python"
if not defined PYCMD (
  echo.
  echo   Python was not found. Install it from https://www.python.org/downloads/
  echo   ^(tick "Add python.exe to PATH" during install^), then run this again.
  echo.
  pause
  exit /b 1
)

echo Starting local server on http://localhost:8100 ...
start "CC Power Server" /min %PYCMD% -m http.server 8100
timeout /t 1 /nobreak >nul
start "" http://localhost:8100/live.html

echo.
echo   Live dashboard opened in your browser.
echo   Enter your roboRIO address (e.g. 10.65.60.2) and click Connect.
echo   Leave this and the minimized "CC Power Server" window open while using it.
echo.
