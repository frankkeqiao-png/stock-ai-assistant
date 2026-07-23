$ErrorActionPreference = "Continue"

$ProjectRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$Node = "C:\Users\surface\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$LogDir = Join-Path $ProjectRoot "logs"
$LogFile = Join-Path $LogDir "scheduled-state-sync.log"

if (!(Test-Path $LogDir)) {
  New-Item -ItemType Directory -Path $LogDir | Out-Null
}

function Write-Log($Message) {
  $Now = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $LogFile -Encoding UTF8 -Value "[$Now] $Message"
}

Write-Log "START durable state sync"
Set-Location $ProjectRoot

try {
  & $Node "modules\trading-assistant\scripts\sync-local-trading-assistant-state.js" 2>&1 | ForEach-Object { Write-Log $_ }
  if ($LASTEXITCODE -ne 0) { throw "state sync exited with $LASTEXITCODE" }
  Write-Log "DONE durable state sync"
} catch {
  Write-Log "ERROR $($_.Exception.Message)"
  exit 1
}
