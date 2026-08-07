param(
    [ValidateSet("debug", "release")]
    [string]$Variant = "debug",
    [switch]$SkipVersionBump,
    [string]$Version = ""
)

# "Continue": npm/gradle write notices to stderr, which "Stop" turns into a
# terminating error. Each step below checks $LASTEXITCODE instead.
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot

function Write-Utf8NoBom([string]$Path, [string]$Content) {
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($Path, $Content.TrimEnd() + "`n", $utf8)
}

function Update-AppVersion([string]$RequestedVersion) {
    $pkgPath = Join-Path $PSScriptRoot "package.json"
    $pkgRaw = [System.IO.File]::ReadAllText($pkgPath)
    if ($pkgRaw.Length -gt 0 -and [int][char]$pkgRaw[0] -eq 0xFEFF) {
        $pkgRaw = $pkgRaw.Substring(1)
    }
    $pkg = $pkgRaw | ConvertFrom-Json
    if ($RequestedVersion) {
        if ($RequestedVersion -notmatch '^\d+\.\d+\.\d+$') {
            throw "Version must use major.minor.patch format"
        }
        $newVersion = $RequestedVersion
    } else {
        $parts = $pkg.version.Split(".")
        while ($parts.Count -lt 3) { $parts += "0" }
        $major = [int]$parts[0]
        $minor = [int]$parts[1]
        $patch = [int]$parts[2] + 1
        $newVersion = "$major.$minor.$patch"
    }

    $gradlePath = Join-Path $PSScriptRoot "android\app\build.gradle"
    $gradle = [System.IO.File]::ReadAllText($gradlePath)
    if ($gradle.Length -gt 0 -and [int][char]$gradle[0] -eq 0xFEFF) {
        $gradle = $gradle.Substring(1)
    }
    if ($gradle -notmatch 'versionCode\s+(\d+)') {
        throw "versionCode not found in android/app/build.gradle"
    }
    $newCode = [int]$Matches[1] + 1

    $pkgRaw = $pkgRaw -replace '"version"\s*:\s*"[^"]+"', "`"version`": `"$newVersion`""
    Write-Utf8NoBom $pkgPath $pkgRaw

    $gradle = [regex]::Replace($gradle, 'versionCode\s+\d+', "versionCode $newCode")
    $gradle = [regex]::Replace($gradle, 'versionName\s+"[^"]+"', "versionName `"$newVersion`"")
    Write-Utf8NoBom $gradlePath $gradle

    $readmePath = Join-Path $PSScriptRoot "README.md"
    if (Test-Path $readmePath) {
        $readme = [System.IO.File]::ReadAllText($readmePath)
        if ($readme.Length -gt 0 -and [int][char]$readme[0] -eq 0xFEFF) {
            $readme = $readme.Substring(1)
        }
        $readme = [regex]::Replace($readme, '\*\*Version\s+[^*]+\*\*', "**Version $newVersion**")
        Write-Utf8NoBom $readmePath $readme
    }

    Write-Host "Version bumped to $newVersion (versionCode $newCode)"
    return @{ Version = $newVersion; Code = $newCode }
}

$sdkRoot = Join-Path $PSScriptRoot "android-sdk"
$localProps = Join-Path $PSScriptRoot "android\local.properties"
if (Test-Path $sdkRoot) {
    $escaped = ($sdkRoot -replace "\\", "\\")
    "sdk.dir=$escaped" | Set-Content -Path $localProps -Encoding ASCII
}

if ($SkipVersionBump -and $Version) {
    throw "Use either -SkipVersionBump or -Version, not both."
}
if (-not $SkipVersionBump) {
    Update-AppVersion $Version | Out-Null
}

if (-not (Test-Path "node_modules")) {
    npm install
}

npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not (Test-Path "android")) {
    npx cap add android
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

npx cap sync android
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Push-Location android
try {
    $gradleArgs = @("-I", "mirror-init.gradle")
    if ($Variant -eq "release") {
        .\gradlew.bat @gradleArgs assembleRelease
    } else {
        .\gradlew.bat @gradleArgs assembleDebug
    }
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}

if ($Variant -eq "release") {
    Write-Host "APK: android\app\build\outputs\apk\release\app-release.apk"
} else {
    Write-Host "APK: android\app\build\outputs\apk\debug\app-debug.apk"
}
