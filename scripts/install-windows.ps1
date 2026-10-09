# WSL owns the application environment; Windows only prepares/selects its distribution.
param(
    [string]$Distribution = '',
    [switch]$Help
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if ($Help) {
    Write-Host 'Usage: install-win.bat [-Distribution Ubuntu]'
    Write-Host 'The Linux installer prompts for repository, model, cache and download choices.'
    exit 0
}
try {
    $wslExecutable = Join-Path $env:SystemRoot 'System32\wsl.exe'
    $installedDistributions = @()
    if (Test-Path -LiteralPath $wslExecutable) {
        $previousErrorPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $listed = & $wslExecutable --list --quiet 2>$null
        $listExitCode = $LASTEXITCODE
        $ErrorActionPreference = $previousErrorPreference
        if ($listExitCode -eq 0) {
            $installedDistributions = @($listed | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ -and $_ -notmatch '^docker-desktop' })
        }
    }
    if (-not $Distribution -and $installedDistributions.Count -gt 0) {
        if ($installedDistributions -contains 'Ubuntu') { $Distribution = 'Ubuntu' }
        else { $Distribution = $installedDistributions[0] }
    }
    if (-not $Distribution) { $Distribution = 'Ubuntu-24.04' }
    if ($installedDistributions -notcontains $Distribution) {
        if ($Distribution -ne 'Ubuntu-24.04') {
            throw 'The selected distribution is not installed. Install it first, or omit -Distribution to install Ubuntu-24.04.'
        }
        $answer = Read-Host 'Install WSL2 and Ubuntu-24.04? Administrator approval and a restart may be required [y/N]'
        if ($answer -notmatch '^(y|yes)$') { throw 'WSL installation was declined.' }
        if (-not (Test-Path -LiteralPath $wslExecutable)) { throw 'WSL is unavailable on this Windows version. See https://learn.microsoft.com/windows/wsl/install' }
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $administrator = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        if ($administrator) {
            & $wslExecutable --install --distribution Ubuntu-24.04 --no-launch
            if ($LASTEXITCODE -notin @(0, 3010)) { throw 'Windows could not install WSL.' }
        } else {
            $process = Start-Process -FilePath $wslExecutable -Verb RunAs -ArgumentList @('--install', '--distribution', 'Ubuntu-24.04', '--no-launch') -WindowStyle Hidden -Wait -PassThru
            if ($process.ExitCode -notin @(0, 3010)) { throw 'Windows could not install WSL.' }
        }
        Write-Host 'Restart Windows if requested. Open Ubuntu-24.04 once to create your Linux username, then rerun install-win.bat.'
        exit 1
    }
    $details = & $wslExecutable --list --verbose 2>$null
    $distributionLine = @($details | Where-Object { ($_ -replace "`0", '') -match ('\b' + [regex]::Escape($Distribution) + '\s+.*\s+2\s*$') })
    if ($distributionLine.Count -eq 0) { throw 'Select a WSL2 distribution. Convert it with wsl --set-version DISTRIBUTION 2, then rerun.' }
    & $wslExecutable --distribution $Distribution --exec bash -c 'test "$(id -u)" -ne 0'
    if ($LASTEXITCODE -ne 0) { throw 'Open the Linux distribution and finish creating a non-root user before installation.' }
    Write-Host "Installing Syntonal Studio in WSL2 distribution: $Distribution"
    & $wslExecutable --distribution $Distribution --cd $projectRoot --exec bash install-linux.sh
    if ($LASTEXITCODE -ne 0) { throw "Linux installation stopped with exit code $LASTEXITCODE." }
    $runtimeRoot = Join-Path $projectRoot '.runtime'
    New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $runtimeRoot 'wsl-distribution.txt'), $Distribution, [System.Text.UTF8Encoding]::new($false))
    Write-Host 'Installation complete. Start the app with launch-win.bat.'
} catch {
    Write-Error -ErrorAction Continue $_
    exit 1
}
