@echo off
rem Start the existing Linux server launcher through Windows Subsystem for Linux.
setlocal
title Syntonal Studio

where.exe wsl.exe >nul 2>&1
if errorlevel 1 (
    echo Windows Subsystem for Linux is required to run Syntonal Studio.
    pause
    exit /b 1
)

echo Starting Syntonal Studio at http://127.0.0.1:8675
echo Keep this window open. Press Ctrl+C to stop the server.
echo.

rem WSL accepts an absolute Windows path for --cd, including paths with spaces.
rem An optional first argument selects the distribution containing Studio's environment.
set "studio_distribution=%~1"
if not defined studio_distribution if exist "%~dp0.runtime\wsl-distribution.txt" set /p "studio_distribution="<"%~dp0.runtime\wsl-distribution.txt"
if not defined studio_distribution (
    wsl.exe --cd "%~dp0." --exec bash launch-linux.sh
) else (
    wsl.exe --distribution "%studio_distribution%" --cd "%~dp0." --exec bash launch-linux.sh
)
set "launch_exit_code=%errorlevel%"

if not "%launch_exit_code%"=="0" (
    echo.
    echo Syntonal Studio exited with code %launch_exit_code%.
    echo Check the messages above. Initial setup must be completed in Linux/WSL.
    pause
)
exit /b %launch_exit_code%
