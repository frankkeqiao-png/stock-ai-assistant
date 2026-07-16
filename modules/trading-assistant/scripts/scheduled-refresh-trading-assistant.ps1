$ErrorActionPreference = "Continue"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Node = "C:\Users\surface\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$LogDir = Join-Path $ProjectRoot "logs"
$LogFile = Join-Path $LogDir "scheduled-refresh.log"

if (!(Test-Path $LogDir)) {
  New-Item -ItemType Directory -Path $LogDir | Out-Null
}

function Write-Log($Message) {
  $Now = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $LogFile -Encoding UTF8 -Value "[$Now] $Message"
}

Write-Log "START trading assistant refresh"
Set-Location $ProjectRoot

try {
  & $Node "scripts\refresh-trading-assistant.js" 2>&1 | ForEach-Object { Write-Log $_ }
  & $Node "scripts\update-strategy-review.js" 2>&1 | ForEach-Object { Write-Log $_ }
  & $Node "scripts\audit-trading-assistant-data.js" 2>&1 | ForEach-Object { Write-Log $_ }
  Write-Log "DONE trading assistant refresh"
} catch {
  Write-Log "ERROR $($_.Exception.Message)"
  exit 1
}
