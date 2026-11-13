@echo off
rem RBU Studio: song library, details, build, chart and effects editor (opens in its own window)
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org/en/download and run this again. & pause & exit /b 1)
node studio\server.js --open %*
