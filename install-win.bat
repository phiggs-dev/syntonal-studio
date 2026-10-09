@echo off
rem Windows installation runs the same Linux installer in WSL2.
setlocal
title Syntonal Studio Installation
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-windows.ps1" %*
set "install_exit_code=%errorlevel%"
if not "%install_exit_code%"=="0" (
    echo.
    echo Installation did not finish. Review the instructions above, then rerun.
)
pause
exit /b %install_exit_code%
