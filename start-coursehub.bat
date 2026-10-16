@echo off
cd /d "%~dp0"
set "PATH=D:\Program Files\nodejs;C:\Program Files\nodejs;%PATH%"

echo ========================================
echo   Starting CourseHub v0.3.4 (Dev Mode)
echo ========================================
echo.

call npm run dev

if errorlevel 1 (
    echo.
    echo [ERROR] CourseHub exited with an error.
    pause
)
