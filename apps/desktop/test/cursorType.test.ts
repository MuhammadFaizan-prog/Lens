import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { IDC_SHAPES, parseCursorLine, POLL_SCRIPT, watchCursorType } from "../src/main/cursorType";
import { EventLogWriter } from "../src/shared/eventlog";
import { parseEventLog } from "../../../packages/engine/src/events";
import { CURSOR_SHAPES } from "../../../packages/engine/src/cursorShapes";

// demand #12: the recorder logs the system cursor's type (Windows GetCursorInfo poller)
describe("cursor type watcher", () => {
  it("maps every standard Windows cursor to a Lens type, ignores custom / hidden / garbage", () => {
    for (const s of Object.values(IDC_SHAPES)) expect(CURSOR_SHAPES).toContain(s);
    expect(parseCursorLine("32649")).toBe("pointer");
    expect(parseCursorLine("32513\r")).toBe("text");
    expect(parseCursorLine("32644")).toBe("resize-ew");
    expect(parseCursorLine("32514")).toBe("wait");
    expect(parseCursorLine("0")).toBeNull();
    expect(parseCursorLine("-1")).toBeNull();
    expect(parseCursorLine("ready")).toBeNull();
    // the script asks for exactly the ids we map
    const ids = POLL_SCRIPT.match(/\$ids = ([\d,]+)/)![1]!.split(",").map(Number);
    expect(ids.sort()).toEqual(Object.keys(IDC_SHAPES).map(Number).sort());
  });

  it("is a no-op off Windows; on Windows reports changes only, split lines included", () => {
    expect(watchCursorType(() => undefined, { platform: "linux" })).toBeNull();
    const out = new PassThrough();
    const err = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout: out, stderr: err, kill: () => true });
    let args: string[] = [];
    const got: string[] = [];
    const w = watchCursorType((s) => got.push(s), { platform: "win32", spawnFn: ((cmd: string, a: string[]) => ((args = [cmd, ...a]), child)) as never });
    expect(w).not.toBeNull();
    expect(args[0]).toBe("powershell.exe");
    expect(Buffer.from(args[args.length - 1]!, "base64").toString("utf16le")).toContain("GetCursorInfo");
    out.write("ready\n32512\n326");
    out.write("49\n0\n32649\n32513\n");
    return new Promise<void>((r) => setImmediate(() => {
      expect(got).toEqual(["arrow", "pointer", "text"]);
      w!.stop();
      r();
    }));
  });

  it("writes cursor-shape events the engine parses", () => {
    let text = "";
    const w = new EventLogWriter((l) => (text += l));
    w.move(0, 10, 10);
    w.shape(120.04, "pointer");
    w.shape(500, "text");
    const ev = parseEventLog(text);
    expect(ev.filter((e) => e.type === "cursor-shape")).toEqual([{ t: 120, type: "cursor-shape", shape: "pointer" }, { t: 500, type: "cursor-shape", shape: "text" }]);
    expect(w.counts.shape).toBe(2);
  });
});
