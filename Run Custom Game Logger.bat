@echo off
title LWG Custom Game Logger
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0custom-game-logger.ps1"
echo.
echo (Window will stay open so you can read any messages above. Close it whenever you're done.)
pause >nul
