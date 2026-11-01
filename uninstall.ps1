# reasonix-token-hud uninstaller - removes the profile copy and its patch block.
# ASCII-only on purpose: Windows PowerShell 5.1 misreads BOM-less UTF-8 scripts.
$ErrorActionPreference = "Stop"

$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\desktop"
$target = Join-Path $profileDir "node_modules\reasonix-token-hud"

if (Test-Path $target) {
    $resolved = [IO.Path]::GetFullPath($target)
    if ((Split-Path $resolved -Leaf) -ne "reasonix-token-hud") { throw "Unexpected target: $resolved" }
    Remove-Item -LiteralPath $resolved -Recurse -Force
    Write-Host "Removed $resolved"
} else {
    Write-Host "Plugin folder not present"
}

$patch = Join-Path $profileDir "cordis.patch.yml"
if (Test-Path $patch) {
    $text = Get-Content -LiteralPath $patch -Raw -Encoding utf8
    $pattern = "(?ms)^# reasonix-token-hud[^\r\n]*\r?\n- insert:\r?\n    - id: reasonix-token-hud\r?\n      name: 'reasonix-token-hud'\r?\n?"
    $next = [regex]::Replace($text, $pattern, "")
    if ($next -ne $text) {
        [IO.File]::WriteAllText($patch, $next, (New-Object Text.UTF8Encoding($false)))
        Write-Host "Removed the reasonix-token-hud patch block"
    } else {
        Write-Host "No reasonix-token-hud patch block found"
    }
}

Write-Host "Restart DeepSeek Harness to finish uninstalling."
