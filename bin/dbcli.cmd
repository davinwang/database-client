@echo off
REM Windows wrapper：调用同目录下的 dbcli.mjs
node "%~dp0dbcli.mjs" %*
