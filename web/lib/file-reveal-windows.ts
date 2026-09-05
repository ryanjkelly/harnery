import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/** Encode the file as data, separately from PowerShell source. File names may
 * contain quotes, dollar signs, and other PowerShell metacharacters. */
export function explorerFocusScript(windowsFile: string): string {
  const encodedPath = Buffer.from(windowsFile, "utf8").toString("base64");
  return `
$ErrorActionPreference = 'Stop'
$targetFile = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
$targetFolder = [IO.Path]::GetDirectoryName($targetFile).TrimEnd('\\')
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FolderWindow {
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)] public static extern int SHParseDisplayName(string name, IntPtr context, out IntPtr item, uint requested, out uint attributes);
  [DllImport("shell32.dll")] public static extern int SHOpenFolderAndSelectItems(IntPtr item, uint count, IntPtr children, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hwnd, int command);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
'@
$item = [IntPtr]::Zero
$attributes = [uint32]0
[Runtime.InteropServices.Marshal]::ThrowExceptionForHR([FolderWindow]::SHParseDisplayName($targetFile, [IntPtr]::Zero, [ref]$item, 0, [ref]$attributes))
try {
  [Runtime.InteropServices.Marshal]::ThrowExceptionForHR([FolderWindow]::SHOpenFolderAndSelectItems($item, 0, [IntPtr]::Zero, 0))
} finally {
  [Runtime.InteropServices.Marshal]::FreeCoTaskMem($item)
}
$shell = New-Object -ComObject Shell.Application
$deadline = [DateTime]::UtcNow.AddSeconds(3)
do {
  foreach ($window in $shell.Windows()) {
    try {
      if ([IO.Path]::GetFileName($window.FullName) -ine 'explorer.exe') { continue }
      $folder = $window.Document.Folder.Self.Path.TrimEnd('\\')
      if ($folder -ine $targetFolder) { continue }
      $handle = [IntPtr]([long]$window.HWND)
      if ([FolderWindow]::IsIconic($handle)) {
        [void][FolderWindow]::ShowWindowAsync($handle, 9)
      }
      # Raise the matching folder even when Windows retains keyboard focus in
      # the browser. Remove topmost immediately so Explorer is not pinned.
      try {
        [void][FolderWindow]::SetWindowPos($handle, [IntPtr](-1), 0, 0, 0, 0, 3)
      } finally {
        [void][FolderWindow]::SetWindowPos($handle, [IntPtr](-2), 0, 0, 0, 0, 3)
      }
      [void][FolderWindow]::SetForegroundWindow($handle)
      for ($attempt = 0; $attempt -lt 10; $attempt++) {
        if ([FolderWindow]::GetForegroundWindow() -eq $handle) {
          '{"foreground":true}'
          exit 0
        }
        Start-Sleep -Milliseconds 50
      }
      '{"foreground":false}'
      exit 0
    } catch { continue }
  }
  Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)
'{"foreground":false}'
`;
}

export async function focusExplorerFile(
  windowsFile: string,
  powershellCommand: string,
): Promise<boolean> {
  const script = explorerFocusScript(windowsFile);
  const { stdout } = await execFile(
    powershellCommand,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", timeout: 8_000, windowsHide: true },
  );
  return JSON.parse(stdout.trim()).foreground === true;
}
