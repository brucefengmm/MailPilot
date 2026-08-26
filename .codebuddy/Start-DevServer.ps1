# Start MailPilot Tauri dev server in background.
# Writes stdout+stderr to logs\tauri-dev.log
# Use: powershell -NoProfile -ExecutionPolicy Bypass -File Start-DevServer.ps1
$logDir = Join-Path $PSScriptRoot "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logPath = Join-Path $logDir "tauri-dev.log"

# Tee all output to log file (PowerShell-native, no `*>` quirks).
Start-Transcript -Path $logPath -Append | Out-Null
try {
    Set-Location "F:\code\MailPilot"
    & pnpm run tauri dev
} finally {
    Stop-Transcript | Out-Null
}