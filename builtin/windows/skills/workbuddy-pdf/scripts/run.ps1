# Runs the workbuddy-pdf CLI for this skill and passes every argument through,
# so the caller sees the CLI's own output and exit code.
#
# The CLI is looked for in this order:
#   1. $env:WORKBUDDY_PDF
#   2. <skill>\bin\windows-<arch>\workbuddy-pdf.exe, the runtime bundled with
#      the skill (arch: x86_64 or arm64)
#   3. workbuddy-pdf on PATH
# `run.ps1 --locate` prints the CLI that would run, and runs nothing.
# Exit code 127 means none of the three was found.

$skillDir = Split-Path -Parent $PSScriptRoot

$cli = $null
if ($env:WORKBUDDY_PDF) {
    if (-not (Test-Path -LiteralPath $env:WORKBUDDY_PDF -PathType Leaf)) {
        [Console]::Error.WriteLine("workbuddy-pdf: WORKBUDDY_PDF='$($env:WORKBUDDY_PDF)' is not a file")
        exit 127
    }
    $cli = (Resolve-Path -LiteralPath $env:WORKBUDDY_PDF).ProviderPath
} else {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x86_64' }
    # Windows on Arm also runs the x64 build, under emulation.
    $candidates = @(Join-Path $skillDir "bin\windows-$arch\workbuddy-pdf.exe")
    if ($arch -eq 'arm64') {
        $candidates += Join-Path $skillDir 'bin\windows-x86_64\workbuddy-pdf.exe'
    }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $cli = $candidate
            break
        }
    }
    if (-not $cli) {
        $onPath = Get-Command workbuddy-pdf -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($onPath) { $cli = $onPath.Source }
    }
}

if (-not $cli) {
    [Console]::Error.WriteLine("workbuddy-pdf: CLI not found; looked for `$env:WORKBUDDY_PDF, $skillDir\bin\windows-$arch\workbuddy-pdf.exe, and workbuddy-pdf on PATH")
    exit 127
}

if ($args.Count -gt 0 -and $args[0] -eq '--locate') {
    Write-Output $cli
    exit 0
}

# Windows PowerShell does not escape a program's arguments when it joins them
# into a command line: a " inside one, or a trailing \ on one holding a space,
# would split it. So the command line is written here, each argument quoted
# the way the CLI's C runtime reads it back. The CLI shares this console, so
# its output and exit code are its own.
function Format-Argument([string]$value) {
    if ($value -ne '' -and $value -notmatch '[\s"]') { return $value }
    $quoted = ($value -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1'
    return '"' + $quoted + '"'
}

$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $cli
$start.Arguments = (@($args) | ForEach-Object { Format-Argument $_ }) -join ' '
$start.UseShellExecute = $false
$process = [System.Diagnostics.Process]::Start($start)
$process.WaitForExit()
exit $process.ExitCode
