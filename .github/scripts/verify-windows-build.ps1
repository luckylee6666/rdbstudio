$ErrorActionPreference = 'Stop'
$mt = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\mt.exe" | Sort-Object FullName -Descending | Select-Object -First 1
if (!$mt) { throw 'Windows SDK manifest tool was not found' }
$unit = Get-ChildItem 'src-tauri/target/debug/deps/rdbstudio_lib-*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$integration = Get-ChildItem 'src-tauri/target/debug/deps/e2e_sqlite-*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$app = Get-Item 'src-tauri/target/release/rdbstudio.exe'
foreach ($binary in @($unit, $integration, $app)) {
  if (!$binary) { throw 'Expected test or application executable was not found' }
  $manifest = Join-Path $env:RUNNER_TEMP "$($binary.BaseName).manifest"
  & $mt.FullName "-inputresource:$($binary.FullName);#1" "-out:$manifest"
  if ($LASTEXITCODE -ne 0) { throw "Cannot read manifest: $($binary.Name)" }
  [xml]$xml = Get-Content $manifest -Raw
  $dependency = $xml.SelectSingleNode("//*[local-name()='assemblyIdentity' and @name='Microsoft.Windows.Common-Controls' and @version='6.0.0.0']")
  if (!$dependency) { throw "Common Controls v6 missing: $($binary.Name)" }
  Write-Output "Common Controls v6 verified: $($binary.Name)"
}
$expected = $env:RELEASE_TAG -replace '^v', ''
if ($app.VersionInfo.ProductVersion -ne $expected) { throw 'Application version does not match release tag' }
$process = Start-Process -FilePath $app.FullName -PassThru
try {
  Start-Sleep -Seconds 10
  if ($process.HasExited) { throw "Application exited during startup: $($process.ExitCode)" }
  Write-Output "Application startup smoke check passed: $expected"
} finally {
  if (!$process.HasExited) { Stop-Process -Id $process.Id }
}
