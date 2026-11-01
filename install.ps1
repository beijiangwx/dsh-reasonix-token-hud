# reasonix-token-hud installer - copies the plugin into the Desktop profile and
# inserts its Host entry into the profile patch. Idempotent: running it twice
# leaves one copy and one patch block.
#
# Keep this file ASCII-only: Windows PowerShell 5.1 reads a BOM-less .ps1 as
# ANSI, which corrupts non-ASCII text inside here-strings.
$ErrorActionPreference = "Stop"

$source = $PSScriptRoot
if (-not (Test-Path (Join-Path $source "lib\client.js"))) {
    throw "install.ps1 must sit next to lib\client.js (run it from the plugin folder)."
}

$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\desktop"
if (-not (Test-Path $profileDir)) {
    throw "Desktop profile not found at $profileDir. Start DeepSeek Harness once, or install into your web profile instead."
}

$nodeModules = Join-Path $profileDir "node_modules"
$target = Join-Path $nodeModules "reasonix-token-hud"
if (-not (Test-Path $nodeModules)) {
    throw "Missing $nodeModules. Start DeepSeek Harness once so the profile is installed."
}

# Refuse to delete anything that is not exactly the plugin folder we manage.
$resolvedTarget = [IO.Path]::GetFullPath($target)
$resolvedRoot = [IO.Path]::GetFullPath($nodeModules) + [IO.Path]::DirectorySeparatorChar
if (-not $resolvedTarget.StartsWith($resolvedRoot) -or (Split-Path $resolvedTarget -Leaf) -ne "reasonix-token-hud") {
    throw "Refusing to write outside the profile's node_modules: $resolvedTarget"
}

if ((Test-Path $target) -and ([IO.Path]::GetFullPath($source) -ne $resolvedTarget)) {
    Remove-Item -LiteralPath $target -Recurse -Force
}
New-Item -ItemType Directory -Force $target | Out-Null

foreach ($item in @("lib", "package.json", "cordis.patch.yml", "README.md")) {
    $from = Join-Path $source $item
    if (Test-Path $from) {
        Copy-Item -LiteralPath $from -Destination $target -Recurse -Force
    }
}

$patch = Join-Path $profileDir "cordis.patch.yml"
$existing = if (Test-Path $patch) { Get-Content -LiteralPath $patch -Raw -Encoding utf8 } else { "" }
if ($existing -notmatch "(?m)^\s*-\s*id:\s*reasonix-token-hud\s*$") {
    $block = "`r`n# reasonix-token-hud - usage and cost HUD (added by install.ps1)`r`n- insert:`r`n    - id: reasonix-token-hud`r`n      name: 'reasonix-token-hud'`r`n"
    [IO.File]::WriteAllText($patch, ($existing.TrimEnd() + $block), (New-Object Text.UTF8Encoding($false)))
    Write-Host "Patched $patch"
} else {
    Write-Host "Patch already contains reasonix-token-hud"
}

Write-Host ""
Write-Host "Installed to $target"
Write-Host "Restart DeepSeek Harness to load the plugin (right sidebar -> guide -> usage & cost)."
