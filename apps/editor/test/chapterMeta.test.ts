import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chapterArgs, embedChapters, wantsChapters } from "../server/chapterMeta";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe("chapters into the MP4 (demand #27)", () => {
  it("only when the plan asks for it", () => {
    expect(wantsChapters({})).toBe(false);
    expect(wantsChapters({ chapters: { title: "", description: "", embed: false, items: [{ outMs: 0, title: "a" }] } })).toBe(false);
    expect(wantsChapters({ chapters: { title: "", description: "", embed: true, items: [] } })).toBe(false);
    expect(wantsChapters({ chapters: { title: "", description: "", embed: true, items: [{ outMs: 0, title: "a" }] } })).toBe(true);
    expect(chapterArgs("a.mp4", "m", "b.mp4")).toEqual(expect.arrayContaining(["-map_chapters", "1", "-c", "copy"]));
  });

  it.skipIf(!hasFfmpeg)("writes chapters, title and description; streams are copied untouched", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lens-ch-"));
    const mp4 = path.join(dir, "export.mp4");
    expect(spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=6", "-f", "lavfi", "-i", "sine=d=6", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", mp4]).status).toBe(0);
    const md5 = (f: string) => spawnSync("ffmpeg", ["-v", "error", "-i", f, "-map", "0:v", "-c", "copy", "-f", "md5", "-"], { encoding: "utf8" }).stdout.trim();
    const before = md5(mp4);
    await embedChapters("ffmpeg", mp4, { output: { width: 320, height: 180, fps: 30, frames: 180, durationMs: 6000 }, chapters: { title: "My video", description: "About it", embed: true, items: [{ outMs: 0, title: "One" }, { outMs: 2500, title: "Two = 2; three" }] } });
    const j = JSON.parse(spawnSync("ffprobe", ["-v", "error", "-show_chapters", "-show_entries", "format_tags", "-of", "json", mp4], { encoding: "utf8" }).stdout);
    expect(j.chapters.map((c: any) => [Number(c.start_time), Number(c.end_time), c.tags.title])).toEqual([[0, 2.5, "One"], [2.5, 6, "Two = 2; three"]]);
    expect(j.format.tags.title).toBe("My video");
    expect(md5(mp4)).toBe(before);
    expect(fs.readdirSync(dir).sort()).toEqual(["export.mp4"]);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
