@echo off
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 (
  echo Python 3 is needed on this computer. Install it from python.org.
  pause
  exit /b 1
)
py -3 -m venv .venv
if errorlevel 1 goto fail
.venv\Scripts\python.exe -m pip install --upgrade pip
.venv\Scripts\python.exe -m pip install -r requirements.txt
if errorlevel 1 goto fail
if not exist config.json copy config.example.json config.json
 echo.
 echo INSTALLED! Edit config.json, then run start_windows.bat
pause
exit /b 0
:fail
 echo Installation failed. Check the error above.
pause
exit /b 1
