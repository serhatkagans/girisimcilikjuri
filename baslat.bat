@echo off
cd /d "%~dp0"
if not exist .env (
  echo .env dosyasi yok. .env.example dosyasini .env olarak kopyalayip JURI_SIFRE degerini yazin.
  pause
  exit /b 1
)
node --no-warnings --env-file=.env server.js
pause
