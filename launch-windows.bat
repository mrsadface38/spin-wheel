@echo off
setlocal
cd /d "%~dp0"

title The Sad Wheel
echo.
echo  The Sad Wheel — updating and starting...
echo.

where git >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Git is not installed.
  echo Install from https://git-scm.com/download/win then run this again.
  pause
  exit /b 1
)

if not exist ".git" (
  echo [ERROR] This folder is not a git clone.
  echo Your friend should clone the private repo first, then run this file from that folder.
  pause
  exit /b 1
)

echo Pulling latest changes...
git pull --ff-only
if errorlevel 1 (
  echo.
  echo [WARN] git pull failed — starting with whatever is already here.
  echo        Check your internet / GitHub login if this keeps happening.
  echo.
)

set PORT=5173
set URL=http://localhost:%PORT%

echo Starting local server on %URL%
echo Close this window to stop the app.
echo.

REM Prefer Python (common on Windows), then Node/npx
where py >nul 2>&1
if not errorlevel 1 (
  start "" "%URL%"
  py -m http.server %PORT%
  goto :eof
)

where python >nul 2>&1
if not errorlevel 1 (
  start "" "%URL%"
  python -m http.server %PORT%
  goto :eof
)

where npx >nul 2>&1
if not errorlevel 1 (
  start "" "%URL%"
  npx --yes serve -l %PORT% .
  goto :eof
)

echo [ERROR] Need Python or Node.js to serve the app.
echo   Python: https://www.python.org/downloads/  ^(check "Add to PATH"^)
echo   Node:   https://nodejs.org/
pause
exit /b 1
