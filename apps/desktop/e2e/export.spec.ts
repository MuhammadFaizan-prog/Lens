/**
 * Export from the desktop app (in-browser render path, no Python): opens a recorded bundle in the
 * bundled editor (LENS_OPEN_BUNDLE; default: the last record.spec.ts bundle) and exports it.
 * Bound (set before measuring): the MP4 has exactly the plan's frame count, at the plan's size, tagged
 * BT.709. Output 720p30 (default 1080p60): same code path, lighter for the 2-core / ~1.5 GB test box.
 */
import { _electron as electron, expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { DESKTOP, RUNS, epoch, ffprobeJson, sleep, startXvfb } from "./helpers";

const DISPLAY = Number(process.env.LENS_E2E_DISPLAY ?? 97);
let xvfb: ChildProcess | null = null;
test.afterAll(() => xvfb?.kill());

test("export a recorded project from the desktop app", async () => {
  test.setTimeout(900_000);
  const bundle = process.env.LENS_OPEN_BUNDLE ?? fs.readFileSync(path.join(RUNS, "last-bundle.txt"), "utf8").trim();
  xvfb = await startXvfb(DISPLAY, 1600, 1000);
  const app = await electron.launch({
    args: [DESKTOP, "--no-sandbox"],
    env: { ...process.env, DISPLAY: `:${DISPLAY}`, LENS_LOWMEM: "1", LENS_NO_UPDATE: "1", LENS_OPEN_BUNDLE: bundle, LENS_USER_DATA: path.join(RUNS, `export-ud-${Date.now()}`) },
  });
  try {
    let ed = null;
    for (let i = 0; i < 120 && !ed; i++) {
      ed = app.windows().find((p) => p.url().includes("dir=")) ?? null;
      if (!ed) await sleep(500);
    }
    expect(ed, "editor window").toBeTruthy();
    await ed!.waitForFunction(() => (window as any).__lens?.state().status === "ready", null, { timeout: 180_000 });
    // Smaller project on request (low-RAM box): LENS_E2E_EXPORT_RES (default 720), LENS_E2E_EXPORT_KEEP_S
    // (cut everything after N s of source). Same code path; the bound is unchanged.
    const res = Number(process.env.LENS_E2E_EXPORT_RES ?? 720);
    const srcMs = JSON.parse(fs.readFileSync(path.join(bundle, "meta.json"), "utf8")).durationMs as number;
    const keepMs = process.env.LENS_E2E_EXPORT_KEEP_S ? Number(process.env.LENS_E2E_EXPORT_KEEP_S) * 1000 : 0;
    await ed!.evaluate(([res, keepMs, srcMs]) => (window as any).__lens.store.edit("Output for export test", (p: any) => ({
      ...p,
      output: { ...p.output, resolution: res, fps: 30 },
      edits: keepMs ? { ...p.edits, cuts: [...p.edits.cuts, { startMs: keepMs, endMs: srcMs }] } : p.edits,
    })), [res, keepMs, srcMs]);
    await ed!.waitForFunction(() => (window as any).__lens.state().fps === 30, null, { timeout: 30_000 });
    const planFrames = await ed!.evaluate(() => (window as any).__lens.state().frames);
    const before = new Set(fs.existsSync(path.join(bundle, ".lens-export")) ? fs.readdirSync(path.join(bundle, ".lens-export")) : []);
    const t0 = epoch();
    await ed!.evaluate(() => (window as any).__lens.store.exportVideo(true));
    await ed!.waitForFunction(() => { const e = (window as any).__lens.store.get().exporting; return e && (e.state === "done" || e.state === "error"); }, null, { timeout: 840_000, polling: 1000 });
    const ex = await ed!.evaluate(() => (window as any).__lens.store.get().exporting);
    const report: Record<string, unknown> = { bundle, ...ex, wallS: (epoch() - t0) / 1000, planFrames };
    expect(ex.state, ex.error).toBe("done");
    const id = fs.readdirSync(path.join(bundle, ".lens-export")).find((d) => !before.has(d))!;
    const out = path.join(bundle, ".lens-export", id, "export.mp4");
    const ep = ffprobeJson(["-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames,width,height,color_space,color_transfer,color_primaries,codec_name:format=duration", out]);
    const st = ep.streams[0];
    Object.assign(report, { file: out, frames: Number(st.nb_read_frames), width: st.width, height: st.height, codec: st.codec_name, color: [st.color_space, st.color_transfer, st.color_primaries], durationS: Number(ep.format.duration) });
    fs.writeFileSync(path.join(path.dirname(out), "export-report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    expect(Number(st.nb_read_frames)).toBe(planFrames);
    expect([st.width, st.height]).toEqual([Math.round((res * 16) / 9 / 2) * 2, res]);
    expect(st.color_space).toBe("bt709");
  } finally {
    await app.close().catch(() => undefined);
  }
});
