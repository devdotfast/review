import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** cmd expands percent signs even inside quotes; delayed expansion stays off. */
function batchPath(value: string): string {
  if (/["\r\n\0]/.test(value)) throw new Error("Invalid Windows command path");

  return value.replaceAll("%", "%%");
}

export function windowsCliShim(
  cliPath: string,
  runtimePath: string,
  devHome?: string,
): string {
  const lines = [
    "@echo off",
    "rem Managed by Whiteboard Desktop. Do not edit.",
    "setlocal DisableDelayedExpansion",
    'set "ELECTRON_RUN_AS_NODE=1"',
  ];

  if (devHome)
    lines.push(
      `if not defined DEV_REVIEW_HOME set "DEV_REVIEW_HOME=${batchPath(devHome)}"`,
    );
  lines.push(
    `"${batchPath(runtimePath)}" "${batchPath(cliPath)}" %*`,
    "exit /b %errorlevel%",
    "",
  );

  return lines.join("\r\n");
}

/** Preserve the unexpanded user PATH, including entries such as %USERPROFILE%. */
export async function updateWindowsUserPath(
  directory: string,
  remove = false,
): Promise<void> {
  const script = `
$ErrorActionPreference = 'Stop'
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
$state = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\\dev.fast\\Whiteboard\\CLI')
try {
  $old = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $dir = $env:WHITEBOARD_COMMAND_DIRECTORY
  $entries = @($old.Split(';'))
  $matches = @($entries | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\\') -ieq $dir.TrimEnd('\\') })
  if ($env:WHITEBOARD_REMOVE_COMMAND_PATH -eq '1') {
    if ([string]$state.GetValue('Path', '') -ine $dir) { return }
    $entries = @($entries | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\\') -ine $dir.TrimEnd('\\') })
    $key.SetValue('Path', ($entries -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
    $state.DeleteValue('Path', $false)
  } else {
    if ($matches.Count -gt 0) { return }
    $state.SetValue('Path', $dir)
    $value = if ($old) { $dir + ';' + $old } else { $dir }
    $key.SetValue('Path', $value, [Microsoft.Win32.RegistryValueKind]::ExpandString)
  }
} finally { $state.Dispose(); $key.Dispose() }
Add-Type -Namespace Whiteboard -Name EnvironmentChange -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr h, uint m, System.UIntPtr w, string l, uint f, uint t, out System.UIntPtr r);'
$result = [UIntPtr]::Zero
[void][Whiteboard.EnvironmentChange]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
`;

  await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      windowsHide: true,
      env: {
        ...process.env,
        WHITEBOARD_COMMAND_DIRECTORY: directory,
        WHITEBOARD_REMOVE_COMMAND_PATH: remove ? "1" : "0",
      },
    },
  );
}

export const WINDOWS_MACHINE_ENVIRONMENT_KEY =
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";

/**
 * A running process keeps the PATH it started with, so the saved user PATH is
 * what tells whether new terminals will find the command.
 */
export async function windowsUserPathContains(
  directory: string,
  key = "HKCU\\Environment",
): Promise<boolean> {
  let stdout: string;

  try {
    ({ stdout } = await execFileAsync("reg.exe", ["query", key, "/v", "Path"], {
      windowsHide: true,
    }));
  } catch {
    return false;
  }

  const saved = stdout.match(/^\s*Path\s+REG_\w+\s*(.*)$/im)?.[1] ?? "";
  const target = path.win32.resolve(directory).toLowerCase();

  return saved.split(";").some((entry) => {
    const expanded = entry
      .trim()
      .replace(/%([^%]+)%/g, (whole, name) => process.env[name] ?? whole);

    return (
      expanded.length > 0 &&
      path.win32.resolve(expanded).toLowerCase() === target
    );
  });
}
