$ErrorActionPreference = 'Stop'
if (-not $env:WINDOWS_CERTIFICATE) { exit 0 }
$folder = Join-Path $env:RUNNER_TEMP 'rdbstudio-signing'
New-Item -ItemType Directory -Force -Path $folder | Out-Null
$path = Join-Path $folder 'certificate.pfx'
try {
  [IO.File]::WriteAllBytes($path, [Convert]::FromBase64String($env:WINDOWS_CERTIFICATE))
  $password = if ($env:WINDOWS_CERTIFICATE_PASSWORD) { ConvertTo-SecureString -String $env:WINDOWS_CERTIFICATE_PASSWORD -AsPlainText -Force } else { [Security.SecureString]::new() }
  $certificate = Import-PfxCertificate -FilePath $path -Password $password -CertStoreLocation Cert:\CurrentUser\My
  if (-not $certificate.Thumbprint) { throw 'Certificate import did not return a certificate' }
  "WINDOWS_CERTIFICATE_THUMBPRINT=$($certificate.Thumbprint)" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
} finally {
  if (Test-Path $path) { Remove-Item -Force $path }
}
