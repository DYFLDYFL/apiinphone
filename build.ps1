param(
    [ValidateSet("debug", "release")]
    [string]$Variant = "debug"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$sdkRoot = Join-Path $PSScriptRoot "android-sdk"
$localProps = Join-Path $PSScriptRoot "android\local.properties"
if (Test-Path $sdkRoot) {
    $escaped = ($sdkRoot -replace "\\", "\\")
    "sdk.dir=$escaped" | Set-Content -Path $localProps -Encoding ASCII
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
    if ($Variant -eq "release") {
        .\gradlew.bat assembleRelease
    } else {
        .\gradlew.bat assembleDebug
    }
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}

if ($Variant -eq "release") {
    Write-Host "APK: android\app\build\outputs\apk\release\app-release-unsigned.apk"
} else {
    Write-Host "APK: android\app\build\outputs\apk\debug\app-debug.apk"
}
