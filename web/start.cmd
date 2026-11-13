@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js 18+ is required to run the NMEA viewer.
  echo Install it from https://nodejs.org/ and try again.
  echo.
  pause
  exit /b 1
)

node server.mjs --open
if errorlevel 1 pause
