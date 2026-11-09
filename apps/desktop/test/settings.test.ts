import { describe, expect, it } from "vitest";
import { defaultSettings, loadSettings, normalize, saveSettings, shortcutConflict } from "../src/main/settings";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const D = defaultSettings("/v", "CommandOrControl+Shift+R");

describe("settings (Windows #19)", () => {
  it("defaults: Videos/Lens and Videos/Lens/Exports", () => {
    expect(D.general.saveDir).toBe(path.join("/v", "Lens"));
    expect(D.general.exportDir).toBe(path.join("/v", "Lens", "Exports"));
  });
  it("drops invalid values and keeps valid ones", () => {
    const n = normalize({ record: { fps: 45, countdown: 3, quality: "max" }, export: { resolution: 999, bitrateMbps: -5 }, shortcuts: { startStop: "" } }, D);
    expect(n.record).toMatchObject({ fps: 30, countdown: 3, quality: "max" });
    expect(n.export.resolution).toBe(1080);
    expect(n.export.bitrateMbps).toBe(0);
    expect(n.shortcuts.startStop).toBe(D.shortcuts.startStop);
  });
  it("detects shortcut conflicts regardless of order / Ctrl spelling", () => {
    expect(shortcutConflict({ startStop: "CommandOrControl+Alt+K", region: "Alt+Ctrl+K", pause: "" })).toEqual(["startStop", "region"]);
    expect(shortcutConflict({ startStop: "CommandOrControl+Alt+K", region: "CommandOrControl+Shift+A", pause: "" })).toBeNull();
  });
  it("persists and reloads", () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lens-set-")), "settings.json");
    saveSettings(f, normalize({ general: { saveDir: "/x" } }, D));
    expect(loadSettings(f, D).general.saveDir).toBe("/x");
    fs.writeFileSync(f, "{broken");
    expect(loadSettings(f, D)).toEqual(D);
  });
});
