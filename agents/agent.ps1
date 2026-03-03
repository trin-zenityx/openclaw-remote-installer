# OpenClaw Remote Installer Agent (Windows PowerShell)
# This script connects to the teacher's installation server

$Server = "SERVER_URL_PLACEHOLDER"
$Token = "AGENT_TOKEN_PLACEHOLDER"
$PollInterval = 2

$ErrorActionPreference = 'Continue'

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  OpenClaw Remote Installer Agent" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

function Get-SystemInfo {
    $nodeVer = try { (node --version 2>$null) } catch { "not installed" }
    if (-not $nodeVer) { $nodeVer = "not installed" }

    $npmVer = try { (npm --version 2>$null) } catch { "not installed" }
    if (-not $npmVer) { $npmVer = "not installed" }

    $wslStatus = "not installed"
    try {
        $wslCheck = wsl --status 2>$null
        if ($LASTEXITCODE -eq 0) { $wslStatus = "installed" }
    } catch {}

    @{
        os = "windows"
        arch = $env:PROCESSOR_ARCHITECTURE
        shell = "powershell"
        nodeVersion = $nodeVer.Trim()
        npmVersion = $npmVer.Trim()
        path = $env:PATH
        homeDir = $env:USERPROFILE
        user = $env:USERNAME
        hostname = $env:COMPUTERNAME
        wsl2Status = $wslStatus
        psVersion = $PSVersionTable.PSVersion.ToString()
        osVersion = [System.Environment]::OSVersion.Version.ToString()
    } | ConvertTo-Json -Compress
}

function Register-Agent {
    $info = Get-SystemInfo
    $headers = @{
        "Content-Type" = "application/json"
        "X-Agent-Token" = $Token
    }
    try {
        $response = Invoke-RestMethod -Uri "$Server/api/agent/register" `
            -Method POST -Headers $headers -Body $info -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Send-Result {
    param($Id, $StdOut, $StdErr, $ExitCode)

    $stdoutB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($StdOut))
    $stderrB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($StdErr))

    $body = @{
        id = $Id
        stdout = $stdoutB64
        stderr = $stderrB64
        exitCode = $ExitCode
        encoding = "base64"
    } | ConvertTo-Json -Compress

    $headers = @{
        "Content-Type" = "application/json"
        "X-Agent-Token" = $Token
    }

    try {
        Invoke-RestMethod -Uri "$Server/api/agent/result" `
            -Method POST -Headers $headers -Body $body -ErrorAction Stop | Out-Null
    } catch {}
}

function Send-Heartbeat {
    $headers = @{ "X-Agent-Token" = $Token }
    try {
        Invoke-RestMethod -Uri "$Server/api/agent/heartbeat" `
            -Method POST -Headers $headers -ErrorAction SilentlyContinue | Out-Null
    } catch {}
}

# --- Main ---

Write-Host "Connecting to teacher's server..." -ForegroundColor Yellow

$registered = Register-Agent
if (-not $registered) {
    Write-Host "Failed to connect. Check your internet connection." -ForegroundColor Red
    exit 1
}

Write-Host "Connected! Waiting for teacher's instructions..." -ForegroundColor Green
Write-Host "(Keep this window open)" -ForegroundColor Green
Write-Host ""

$heartbeatCounter = 0
$isRegistered = $true

while ($true) {
    # Heartbeat every 10 seconds
    $heartbeatCounter++
    if ($heartbeatCounter -ge 5) {
        Send-Heartbeat
        $heartbeatCounter = 0
    }

    # Poll for command
    $pollResult = $null
    $pollError = $false
    $headers = @{ "X-Agent-Token" = $Token }
    try {
        $response = Invoke-WebRequest -Uri "$Server/api/agent/poll" `
            -Headers $headers -ErrorAction Stop
        if ($response.StatusCode -eq 200) {
            $pollResult = ($response.Content | ConvertFrom-Json)
        }
    } catch {
        $statusCode = 0
        if ($_.Exception.Response) {
            $statusCode = [int]$_.Exception.Response.StatusCode
        }
        # Auto-reconnect on 403/401 (server restarted and lost session)
        if ($statusCode -eq 403 -or $statusCode -eq 401) {
            if ($isRegistered) {
                Write-Host "Connection lost. Reconnecting..." -ForegroundColor Yellow
                $isRegistered = $false
            }
            $reregistered = Register-Agent
            if ($reregistered) {
                Write-Host "Reconnected!" -ForegroundColor Green
                $isRegistered = $true
            }
            Start-Sleep -Seconds $PollInterval
            continue
        }
    }

    $isRegistered = $true
    $task = $pollResult
    if ($task -and $task.command) {
        Write-Host "[>] Running: $($task.command)" -ForegroundColor Cyan

        $stdOut = ""
        $stdErr = ""
        $exitCode = 0

        try {
            # Execute command and capture output
            $output = Invoke-Expression $task.command 2>&1

            # Separate stdout and stderr
            $stdOutLines = @()
            $stdErrLines = @()
            foreach ($line in $output) {
                if ($line -is [System.Management.Automation.ErrorRecord]) {
                    $stdErrLines += $line.ToString()
                } else {
                    $stdOutLines += $line.ToString()
                }
            }
            $stdOut = $stdOutLines -join "`n"
            $stdErr = $stdErrLines -join "`n"

            $exitCode = $LASTEXITCODE
            if ($null -eq $exitCode) { $exitCode = 0 }
        } catch {
            $stdErr = $_.Exception.Message
            $exitCode = 1
        }

        # Display output
        if ($stdOut) { Write-Host $stdOut }
        if ($stdErr) { Write-Host $stdErr -ForegroundColor Red }
        Write-Host "[Exit code: $exitCode]" -ForegroundColor Cyan
        Write-Host ""

        Send-Result -Id $task.id -StdOut $stdOut -StdErr $stdErr -ExitCode $exitCode
    }

    Start-Sleep -Seconds $PollInterval
}
