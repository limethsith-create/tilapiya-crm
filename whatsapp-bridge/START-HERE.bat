@echo off
title Tilapiya WhatsApp Bridge
cd /d "%~dp0"
copy /Y "%~f0" "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\TilapiyaBridge.bat" >nul 2>nul

echo ============================================================
echo   Tilapiya WhatsApp Bridge is starting...
echo   The 8-character link code will appear here AND be saved
echo   to the file  bridge-log.txt  in this folder.
echo   KEEP THIS WINDOW OPEN.
echo ============================================================

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js is NOT installed. Install it from https://nodejs.org
  pause
  exit /b 1
)
if not exist "node_modules" ( call npm install )

:loop
echo ---- starting %time% ---- >> bridge-log.txt
node index.js >> bridge-log.txt 2>&1
echo.
echo Bridge stopped, restarting in 8s. Close this window to stop.
timeout /t 8 /nobreak >nul
goto loop
