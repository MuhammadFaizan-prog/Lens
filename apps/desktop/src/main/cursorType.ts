/**
 * The system cursor's type while recording (demand #12: Lens's cursor matches the UI under it).
 *
 * Windows: a PowerShell child (no native module, PowerShell ships with Windows) loads the standard
 * system cursors (LoadCursor IDC_*), then polls GetCursorInfo every ~15 ms and prints the IDC id of
 * the current cursor whenever it changes ("0" for a custom / app cursor, "-1" hidden). Main stamps each
 * line on the video clock when it arrives (a few ms of pipe latency) and logs a `cursor-shape` event.
 * Apps that draw their own cursor art (custom HCURSOR) read as "0" and keep the previous type.
 *
 * macOS / Linux: no system API reachable without a native module here, so nothing is logged and
 * the editor infers types (packages/engine/src/cursorShapes.ts).
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { CursorShape } from "../../../../packages/engine/src/types";

/** Windows IDC_* ids -> Lens cursor type. */
export const IDC_SHAPES: Record<number, CursorShape> = {
  32512: "arrow", // IDC_ARROW
  32513: "text", // IDC_IBEAM
  32514: "wait", // IDC_WAIT
  32515: "crosshair", // IDC_CROSS
  32516: "arrow", // IDC_UPARROW
  32642: "resize-nwse", // IDC_SIZENWSE
  32643: "resize-nesw", // IDC_SIZENESW
  32644: "resize-ew", // IDC_SIZEWE
  32645: "resize-ns", // IDC_SIZENS
  32646: "move", // IDC_SIZEALL
  32648: "not-allowed", // IDC_NO
  32649: "pointer", // IDC_HAND
  32650: "wait", // IDC_APPSTARTING (arrow + busy)
  32651: "arrow", // IDC_HELP
  32671: "arrow", // IDC_PIN
  32672: "pointer", // IDC_PERSON
};

/** One poller line -> a cursor type, or null (custom / hidden / garbage: keep the previous type). */
export function parseCursorLine(line: string): CursorShape | null {
  const s = line.trim();
  if (!/^-?\d+$/.test(s)) return null;
  return IDC_SHAPES[Number(s)] ?? null;
}

/** The PowerShell poller (Windows). Prints the IDC id on change, one per line. */
export const POLL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LensCursor {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] public struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT pt; }
  [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO ci);
  [DllImport("user32.dll")] public static extern IntPtr LoadCursor(IntPtr hInstance, IntPtr id);
}
'@
$ids = 32512,32513,32514,32515,32516,32642,32643,32644,32645,32646,32648,32649,32650,32651,32671,32672
$map = @{}
foreach ($id in $ids) { $h = [LensCursor]::LoadCursor([IntPtr]::Zero, [IntPtr]$id); if ($h -ne [IntPtr]::Zero) { $map[$h.ToInt64()] = $id } }
$ci = New-Object LensCursor+CURSORINFO
$ci.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($ci)
$last = -2
[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()
while ($true) {
  $cur = 0
  if ([LensCursor]::GetCursorInfo([ref]$ci)) {
    if (($ci.flags -band 1) -eq 0) { $cur = -1 } elseif ($map.ContainsKey($ci.hCursor.ToInt64())) { $cur = $map[$ci.hCursor.ToInt64()] }
  }
  if ($cur -ne $last) { [Console]::Out.WriteLine($cur); [Console]::Out.Flush(); $last = $cur }
  Start-Sleep -Milliseconds 15
}
`;

export interface CursorTypeWatcher {
  stop(): void;
}

/**
 * Start watching the system cursor type. `onShape(shape)` is called on each change (main stamps the
 * time). Returns null where the platform has no watcher. `spawnFn` is injectable for tests.
 */
export function watchCursorType(onShape: (shape: CursorShape) => void, opts: { platform?: string; spawnFn?: typeof spawn; onError?: (msg: string) => void } = {}): CursorTypeWatcher | null {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return null;
  const sp = opts.spawnFn ?? spawn;
  let child: ChildProcess | null = null;
  try {
    const encoded = Buffer.from(POLL_SCRIPT, "utf16le").toString("base64");
    child = sp("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    opts.onError?.(`cursor type watcher did not start: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  let buf = "";
  let last: CursorShape | null = null;
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const s = parseCursorLine(line);
      if (s && s !== last) {
        last = s;
        onShape(s);
      }
    }
  });
  let errText = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (d: string) => (errText = (errText + d).slice(-400)));
  child.on("error", (e) => opts.onError?.(`cursor type watcher: ${e.message}`));
  child.on("exit", (code) => {
    if (code && code !== 0 && errText) opts.onError?.(`cursor type watcher exited ${code}: ${errText.trim()}`);
  });
  return {
    stop() {
      try {
        child?.kill();
      } catch {
        /* already gone */
      }
      child = null;
    },
  };
}
