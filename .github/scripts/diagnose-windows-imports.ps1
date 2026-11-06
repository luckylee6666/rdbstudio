$ErrorActionPreference = 'Stop'
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -products '*' -property installationPath
$dumpbin = Get-ChildItem "$vs\VC\Tools\MSVC\*\bin\Hostx64\x64\dumpbin.exe" | Sort-Object FullName -Descending | Select-Object -First 1
$testExe = Get-ChildItem 'src-tauri/target/debug/deps/rdbstudio_lib-*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (!$dumpbin -or !$testExe) { throw 'Cannot find dumpbin or the Rust test executable' }
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ImportProbe {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr LoadLibraryW(string path);
  [DllImport("kernel32.dll", CharSet = CharSet.Ansi, ExactSpelling = true)]
  public static extern IntPtr GetProcAddress(IntPtr module, string name);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  public static extern uint GetModuleFileNameW(IntPtr module, StringBuilder path, int size);
}
'@
$imports = & $dumpbin.FullName /imports $testExe.FullName
$module = [IntPtr]::Zero
$dll = ''
foreach ($line in $imports) {
  if ($line -match '^\s+([^\s]+\.dll)\s*$') {
    $dll = $Matches[1]
    $module = [ImportProbe]::LoadLibraryW($dll)
    if ($module -eq [IntPtr]::Zero) {
      Write-Output "LOAD FAILED: $dll error=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    } else {
      $path = [Text.StringBuilder]::new(32768)
      [void][ImportProbe]::GetModuleFileNameW($module, $path, $path.Capacity)
      Write-Output "LOADED: $dll from $path"
    }
  } elseif ($module -ne [IntPtr]::Zero -and $line -match '^\s+[0-9A-Fa-f]+\s+([A-Za-z_?@$][^\s]*)\s*$') {
    $symbol = $Matches[1]
    if ([ImportProbe]::GetProcAddress($module, $symbol) -eq [IntPtr]::Zero) {
      Write-Output "MISSING IMPORT: $dll!$symbol"
    }
  }
}
Write-Output 'Full executable import table:'
$imports
