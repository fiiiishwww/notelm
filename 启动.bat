@echo off
chcp 936 >nul
cd /d "%~dp0"
title Notebook - 学习型笔记

echo.
echo   Notebook - 学习型笔记
echo   ------------------------------
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [!] 这台机器上没找到 Node.js
  echo.
  echo       请先到 https://nodejs.org/ 下载安装 LTS 版本，
  echo       装完重新双击本文件即可。
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo   第一次启动，正在安装依赖，大概 1-3 分钟，只此一次...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   [!] 依赖安装失败，请把上面的报错内容发出来。
    echo.
    pause
    exit /b 1
  )
)

echo   正在启动，稍后会自动打开浏览器：
echo   http://127.0.0.1:3000
echo   Phone (same Wi-Fi): see LAN URL printed below after startup.
echo.
echo   想停止服务：在这个窗口按 Ctrl+C，或者直接关掉窗口。
echo.

set NB_HOST=0.0.0.0
call npm run dev
pause
