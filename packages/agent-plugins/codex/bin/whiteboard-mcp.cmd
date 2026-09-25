@echo off
setlocal DisableDelayedExpansion
rem Codex runs this on Windows in place of the extensionless whiteboard-mcp.
rem Leave the plugin directory so an update can replace it while the server runs.
cd /d "%SystemRoot%"
if exist "%USERPROFILE%\.local\bin\whiteboard.cmd" (
  call "%USERPROFILE%\.local\bin\whiteboard.cmd" mcp %*
) else (
  call whiteboard.cmd mcp %*
)
exit /b %errorlevel%
