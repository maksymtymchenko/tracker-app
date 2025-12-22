# PowerShell script to terminate Windows Activity Tracker processes across all user sessions
# This script requires Administrator privileges to terminate processes in other user sessions
# Usage: Run this script as Administrator when updating the application

param(
    [switch]$Force = $false,
    [string]$ProcessName = "Windows Activity Tracker.exe"
)

# Check if running as Administrator
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "ERROR: This script requires Administrator privileges." -ForegroundColor Red
    Write-Host "Please right-click PowerShell and select 'Run as Administrator', then run this script again." -ForegroundColor Yellow
    exit 1
}

Write-Host "Terminating '$ProcessName' processes across all user sessions..." -ForegroundColor Cyan
Write-Host ""

# Get current username for comparison
$currentUser = $env:USERNAME

# Get all processes matching the name
$processes = Get-Process -Name "*Windows*Activity*Tracker*" -ErrorAction SilentlyContinue

if ($null -eq $processes -or $processes.Count -eq 0) {
    Write-Host "No processes found matching '$ProcessName'." -ForegroundColor Green
    exit 0
}

Write-Host "Found $($processes.Count) process(es):" -ForegroundColor Yellow
foreach ($proc in $processes) {
    try {
        $owner = $proc | Get-CimInstance -ClassName Win32_Process | Select-Object -ExpandProperty GetOwner | Select-Object -ExpandProperty User
        Write-Host "  PID $($proc.Id) - User: $owner - Session: $($proc.SessionId)" -ForegroundColor Gray
    } catch {
        Write-Host "  PID $($proc.Id) - Session: $($proc.SessionId) (could not determine user)" -ForegroundColor Gray
    }
}
Write-Host ""

# Group by user
$processesByUser = @{}
foreach ($proc in $processes) {
    try {
        $owner = $proc | Get-CimInstance -ClassName Win32_Process | Select-Object -ExpandProperty GetOwner | Select-Object -ExpandProperty User
        if (-not $processesByUser.ContainsKey($owner)) {
            $processesByUser[$owner] = @()
        }
        $processesByUser[$owner] += $proc
    } catch {
        $unknownUser = "Unknown"
        if (-not $processesByUser.ContainsKey($unknownUser)) {
            $processesByUser[$unknownUser] = @()
        }
        $processesByUser[$unknownUser] += $proc
    }
}

# Show summary
Write-Host "Processes by user:" -ForegroundColor Cyan
foreach ($user in $processesByUser.Keys) {
    $isCurrentUser = ($user -eq $currentUser)
    $label = if ($isCurrentUser) { "$user (current session)" } else { $user }
    Write-Host "  $label : $($processesByUser[$user].Count) process(es)" -ForegroundColor $(if ($isCurrentUser) { "Green" } else { "Yellow" })
}
Write-Host ""

# Terminate processes
$terminated = 0
$failed = 0
$errors = @()

foreach ($proc in $processes) {
    try {
        $procName = $proc.ProcessName
        $procId = $proc.Id
        
        Write-Host "Terminating PID $procId..." -NoNewline -ForegroundColor Cyan
        
        if ($Force) {
            Stop-Process -Id $procId -Force -ErrorAction Stop
        } else {
            # Try graceful termination first
            $proc.CloseMainWindow()
            Start-Sleep -Milliseconds 500
            if (-not $proc.HasExited) {
                Stop-Process -Id $procId -Force -ErrorAction Stop
            }
        }
        
        Write-Host " Success" -ForegroundColor Green
        $terminated++
    } catch {
        $errorMsg = $_.Exception.Message
        Write-Host " Failed: $errorMsg" -ForegroundColor Red
        $failed++
        $errors += "PID $($proc.Id): $errorMsg"
    }
}

Write-Host ""
Write-Host "Summary:" -ForegroundColor Cyan
Write-Host "  Terminated: $terminated" -ForegroundColor Green
if ($failed -gt 0) {
    Write-Host "  Failed: $failed" -ForegroundColor Red
    foreach ($err in $errors) {
        Write-Host "    - $err" -ForegroundColor Red
    }
}

# Verify all processes are terminated
Start-Sleep -Seconds 1
$remaining = Get-Process -Name "*Windows*Activity*Tracker*" -ErrorAction SilentlyContinue

if ($null -eq $remaining -or $remaining.Count -eq 0) {
    Write-Host ""
    Write-Host "All processes have been terminated successfully." -ForegroundColor Green
    exit 0
} else {
    Write-Host ""
    Write-Host "WARNING: $($remaining.Count) process(es) are still running:" -ForegroundColor Yellow
    foreach ($proc in $remaining) {
        Write-Host "  PID $($proc.Id) - Session: $($proc.SessionId)" -ForegroundColor Yellow
    }
    exit 1
}

