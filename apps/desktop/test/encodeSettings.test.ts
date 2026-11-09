/**
 * Settings reach ffmpeg (Windows report 2026-11-09: "bitrate / encoder ignore Settings"):
 *   Record quality -> finalize crf + preset, Record fps -> finalize -r, Export bitrate -> export -b:v,
 *   Hardware acceleration off -> libx264 only; and the hardware H.264 test-encode falls back to libx264
 *   when it fails (or when the encoder passes the probe but fails on the real stream).
 * ffmpeg is faked (node:child_process.spawn): these check the arguments, bench-finalize.mjs times the real thing.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ screen: {} }));

type Call = { cmd: string; args: string[] };
const calls: Call[] = [];
/** exit code per spawned ffmpeg (default 0) */
let exitCode: (c: Call) => number = () => 0;

vi.mock("node:child_process", async (orig) => {
  const real = await orig<typeof import("node:child_process")>();
  return {
    ...real,
    spawn: (cmd: string, args: string[]) => {
      const c = { cmd, args: [...args] };
      calls.push(c);
      const p = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
      p.stdout = new EventEmitter();
      p.stderr = new EventEmitter();
      p.kill = () => undefined;
      setTimeout(() => {
        const code = exitCode(c);
        if (args.includes("-progress")) p.stdout.emit("data", Buffer.from("out_time_us=2500000\nprogress=continue\n"));
        p.stderr.emit("data", Buffer.from(code ? "Error: no device\n" : "  Duration: 00:00:05.00, start: 0.000000\n"));
        p.emit("exit", code);
        p.emit("close", code);
      }, 1);
      return p;
    },
  };
});

const { Recording } = await import("../src/main/recording");
const { CRF, h264Args, hardwareCandidates, pickH264 } = await import("../../editor/server/h264");
const { browserExportArgs, exportBitrateMbps } = await import("../../editor/server/browserExport");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lens-encset-"));
let n = 0;
/** an encode (not the duration probe `ffmpeg -i screen.mp4`) writing `name` */
const outFile = (c: Call, name: string) => c.args[c.args.length - 1]!.endsWith(name) && c.args.includes("-c:v");
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const isProbe = (c: Call) => c.args.includes("lavfi");

/** A stopped recording with screen + mic + camera chunks on disk, finalized against the fake ffmpeg. */
async function finalize(quality: "standard" | "high" | "max", fps: 30 | 60, ffmpeg = `ffmpeg-${n++}`) {
  const rec = new Recording(path.join(tmp, `r${n++}`), null, null);
  // the fields start() / stopInput() set (start() needs Electron's screen API)
  const priv = rec as unknown as { info: unknown; stopEpoch: number };
  for (const f of ["recording.webm", "mic.webm", "cam.webm"]) fs.writeFileSync(path.join(rec.dir, f), "x");
  priv.info = {
    sourceId: "screen:0", sourceName: "t", kind: "screen", displayId: "0", capture: { width: 1920, height: 1080 }, fps, quality, videoMime: "video/webm", videoStart: 1000,
    mic: { mime: "audio/webm", start: 1000 }, webcam: { mime: "video/webm", start: 1000 }, system: null,
  };
  priv.stopEpoch = 6000;
  await rec.finalize(ffmpeg);
  const screen = calls.filter((c) => outFile(c, "screen.mp4"));
  const cam = calls.find((c) => outFile(c, "cam.mp4"))!;
  return { rec, screen, cam, probes: calls.filter(isProbe) };
}

beforeEach(() => {
  calls.length = 0;
  exitCode = () => 0;
  delete process.env.LENS_H264_ENCODER;
  delete process.env.LENS_H264_HW;
});
const PLATFORM = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => void Object.defineProperty(process, "platform", PLATFORM));

describe("Settings > Record quality / fps -> finalize ffmpeg args", () => {
  it.each([
    ["standard", 30, 23, "superfast"],
    ["high", 60, 20, "superfast"],
    ["max", 60, 17, "veryfast"],
  ] as const)("%s @ %i fps: libx264 -crf %i -preset %s -r fps, cfr", async (quality, fps, crf, preset) => {
    process.env.LENS_H264_ENCODER = "libx264";
    const { rec, screen, cam } = await finalize(quality, fps);
    expect(screen).toHaveLength(1);
    const a = screen[0]!.args;
    expect(after(a, "-c:v")).toBe("libx264");
    expect(after(a, "-crf")).toBe(String(crf));
    expect(after(a, "-preset")).toBe(preset);
    expect(after(a, "-r")).toBe(String(fps));
    expect(after(a, "-fps_mode")).toBe("cfr");
    expect(after(a, "-t")).toBe("5.000");
    expect(a).not.toContain("-b:v"); // constant quality, no bitrate cap on the master
    // the camera follows the recording fps too
    expect(after(cam.args, "-r")).toBe(String(fps));
    expect(rec.finalizeInfo).toMatchObject({ encoder: "libx264", quality });
  });

  it("no quality in StartInfo (older renderer) -> high (crf 20)", async () => {
    process.env.LENS_H264_ENCODER = "libx264";
    const rec = new Recording(path.join(tmp, `q${n++}`), null, null) as never as { dir: string; info: unknown; stopEpoch: number; finalize: (f: string) => Promise<unknown> };
    fs.writeFileSync(path.join(rec.dir, "recording.webm"), "x");
    rec.info = { capture: { width: 1280, height: 720 }, fps: 30, videoStart: 0, mic: null, kind: "screen", sourceId: "s", sourceName: "s", videoMime: "" };
    rec.stopEpoch = 2000;
    await rec.finalize("ffmpeg-noq");
    expect(after(calls.find((c) => outFile(c, "screen.mp4"))!.args, "-crf")).toBe("20");
  });

  it("CRF table: standard 23, high 20, max 17 (no crf 16)", () => {
    expect(CRF).toEqual({ standard: 23, high: 20, max: 17 });
    expect(after(h264Args("h264_nvenc", "max"), "-cq")).toBe("17");
    expect(after(h264Args("h264_qsv", "standard"), "-global_quality")).toBe("23");
    expect(after(h264Args("h264_amf", "high"), "-qp_i")).toBe("20");
  });
});

describe("hardware H.264: test-encode, fallback to libx264", () => {
  it("probe fails -> libx264 for the screen, no hardware args", async () => {
    exitCode = (c) => (isProbe(c) ? 1 : 0);
    const { rec, screen, probes } = await finalize("high", 60, "ff-probe-fails");
    expect(probes.map((c) => after(c.args, "-c:v"))).toEqual(hardwareCandidates());
    expect(screen).toHaveLength(1);
    expect(after(screen[0]!.args, "-c:v")).toBe("libx264");
    expect(rec.finalizeInfo?.encoder).toBe("libx264");
    expect(rec.warnings.join(" ")).not.toMatch(/hardware encoder/);
  });

  it("probe passes -> hardware encoder at the quality's cq", async () => {
    const { rec, screen } = await finalize("standard", 30, "ff-probe-ok");
    const enc = hardwareCandidates()[0]!;
    expect(after(screen[0]!.args, "-c:v")).toBe(enc);
    expect(screen[0]!.args).toContain("23");
    expect(rec.finalizeInfo?.encoder).toBe(enc);
  });

  // before the real-encode failure below: markBroken holds for the whole process
  it("Windows: nvenc, qsv, amf tried in order; all failing -> libx264", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    expect(hardwareCandidates()).toEqual(["h264_nvenc", "h264_qsv", "h264_amf"]);
    exitCode = (c) => (isProbe(c) && after(c.args, "-c:v") !== "h264_qsv" ? 1 : 0);
    expect(await pickH264("ff-win-qsv")).toBe("h264_qsv");
    exitCode = () => 1;
    calls.length = 0;
    expect(await pickH264("ff-win-none")).toBe("libx264");
    expect(calls.map((c) => after(c.args, "-c:v"))).toEqual(["h264_nvenc", "h264_qsv", "h264_amf"]);
  });

  it("probe passes but the real encode fails -> redone once with libx264, warning recorded, encoder marked broken", async () => {
    exitCode = (c) => (!isProbe(c) && outFile(c, "screen.mp4") && after(c.args, "-c:v") !== "libx264" ? 1 : 0);
    const { rec, screen } = await finalize("high", 60, "ff-real-fails");
    expect(screen.map((c) => after(c.args, "-c:v"))).toEqual([hardwareCandidates()[0], "libx264"]);
    expect(after(screen[1]!.args, "-crf")).toBe("20");
    expect(rec.finalizeInfo?.encoder).toBe("libx264");
    expect(rec.warnings.join(" ")).toMatch(/hardware encoder h264_\w+ failed .*used libx264/s);
    // the next pick on this ffmpeg skips the broken encoder
    calls.length = 0;
    exitCode = () => 0;
    expect(await pickH264("ff-real-fails")).toBe(hardwareCandidates().length > 1 ? hardwareCandidates()[1] : "libx264");
  });

  it("Settings > Hardware acceleration off (LENS_H264_HW=off) -> libx264 without probing", async () => {
    process.env.LENS_H264_HW = "off";
    const { screen, probes, rec } = await finalize("max", 30, "ff-hw-off");
    expect(probes).toHaveLength(0);
    expect(after(screen[0]!.args, "-c:v")).toBe("libx264");
    expect(rec.finalizeInfo?.encoder).toBe("libx264");
  });
});

describe("Settings > Export bitrate / fps -> export ffmpeg args", () => {
  const plan = (fps: number) => ({ output: { width: 1920, height: 1080, fps, frames: 90, durationMs: 3000 }, frames: new Array(90).fill({}) }) as never;
  it("bitrate 0 (auto) -> crf 18, no -b:v; output fps -> -framerate / -r", () => {
    const a = browserExportArgs(plan(60), "v.mp4");
    expect(after(a, "-crf")).toBe("18");
    expect(a).not.toContain("-b:v");
    expect(after(a, "-r")).toBe("60");
    expect(after(a, "-framerate")).toBe("60");
  });
  it("bitrate 8 Mbps -> -b:v 8M -maxrate 12M -bufsize 16M, no crf", () => {
    const a = browserExportArgs(plan(30), "v.mp4", { bitrateMbps: 8 });
    expect(after(a, "-b:v")).toBe("8M");
    expect(after(a, "-maxrate")).toBe("12M");
    expect(after(a, "-bufsize")).toBe("16M");
    expect(a).not.toContain("-crf");
    expect(after(a, "-r")).toBe("30");
  });
  it("LENS_EXPORT_BITRATE_MBPS (set by the desktop app from Settings) is parsed and clamped", () => {
    expect(exportBitrateMbps({ LENS_EXPORT_BITRATE_MBPS: "12" })).toBe(12);
    expect(exportBitrateMbps({ LENS_EXPORT_BITRATE_MBPS: "0" })).toBe(0);
    expect(exportBitrateMbps({ LENS_EXPORT_BITRATE_MBPS: "abc" })).toBe(0);
    expect(exportBitrateMbps({ LENS_EXPORT_BITRATE_MBPS: "900" })).toBe(200);
    expect(exportBitrateMbps({})).toBe(0);
  });
});
