import { describe, expect, it } from "vitest";
import { clicks, detectTyping, parseEventLog, rawCursorAt, shortcutOverlays } from "../../../packages/engine/src/events";
import { EventLogWriter, formatEvent, headerLine, keyEvent, mouseButton } from "../src/shared/eventlog";

const NO = { ctrl: false, alt: false, shift: false, meta: false };

describe("event log format", () => {
  it("lines parse with the engine's parser; header is a comment", () => {
    const lines: string[] = [headerLine({ capture: { width: 1280, height: 720 } }) + "\n"];
    const w = new EventLogWriter((l) => lines.push(l));
    w.move(0, 10.123, 20.456);
    w.move(16.7, 11, 21);
    w.down(20.04, 11, 21, "left");
    w.up(90, 11, 21, "left");
    w.scroll(100, 11, 21, 0, -3);
    w.key(keyEvent(120, "S", { ...NO, ctrl: true }));
    const ev = parseEventLog(lines.join(""));
    expect(ev.map((e) => e.type)).toEqual(["move", "move", "down", "up", "scroll", "key"]);
    expect(ev[0]).toEqual({ t: 0, type: "move", x: 10.12, y: 20.46 });
    expect(ev[2]).toEqual({ t: 20, type: "down", x: 11, y: 21, button: "left" });
    expect(clicks(ev)).toEqual([{ t: 20, x: 11, y: 21 }]);
    expect(shortcutOverlays(ev, 1000).map((o) => o.label)).toEqual(["Ctrl S"]); // the engine's overlay label format
  });

  it("rounding: t to 0.1 ms, x / y to 0.01 px", () => {
    expect(formatEvent({ t: 12.3456, type: "down", x: 1.23456, y: 7.891, button: "right" })).toBe('{"t":12.3,"type":"down","x":1.23,"y":7.89,"button":"right"}');
  });

  it("privacy: plain typing is timing only, shortcuts keep the combo, bare modifiers are dropped", () => {
    expect(keyEvent(5, "A", NO)).toEqual({ t: 5, type: "key", key: "", modifiers: [] });
    expect(keyEvent(5, "A", { ...NO, shift: true })).toEqual({ t: 5, type: "key", key: "", modifiers: [] });
    expect(keyEvent(5, "Enter", NO)).toEqual({ t: 5, type: "key", key: "", modifiers: [] });
    expect(keyEvent(5, "7", NO)).toEqual({ t: 5, type: "key", key: "", modifiers: [] });
    expect(keyEvent(5, undefined, { ...NO, ctrl: true })).toEqual({ t: 5, type: "key", key: "", modifiers: [] });
    expect(keyEvent(5, "Shift", { ...NO, shift: true })).toBeNull();
    expect(keyEvent(5, "CtrlRight", { ...NO, ctrl: true })).toBeNull();
    expect(keyEvent(5, "S", { ...NO, ctrl: true, shift: true })).toEqual({ t: 5, type: "key", key: "S", modifiers: ["ctrl", "shift"] });
    expect(keyEvent(5, "Space", { ...NO, alt: true })).toEqual({ t: 5, type: "key", key: " ", modifiers: ["alt"] });
    expect(keyEvent(5, "Slash", { ...NO, meta: true }, "darwin")).toEqual({ t: 5, type: "key", key: "/", modifiers: ["cmd"] });
    expect(keyEvent(5, "Tab", { ...NO, meta: true }, "win32")).toEqual({ t: 5, type: "key", key: "Tab", modifiers: ["meta"] });
  });

  it("a typed sentence leaves no characters in the log but still drives typing detection", () => {
    const lines: string[] = [];
    const w = new EventLogWriter((l) => lines.push(l));
    const text = "hunter2 Secret";
    [...text].forEach((ch, i) => w.key(keyEvent(i * 150, ch === " " ? "Space" : /\d/.test(ch) ? ch : ch.toUpperCase(), { ...NO, shift: ch !== ch.toLowerCase() })));
    const log = lines.join("");
    const keys = parseEventLog(log).filter((e) => e.type === "key");
    expect(keys.length).toBe(text.length);
    for (const k of keys) expect(k).toMatchObject({ key: "", modifiers: [] });
    expect(log).not.toMatch(/hunter|Secret|"key":"[^"]/);
    expect(detectTyping(parseEventLog(log)).length).toBe(1);
    expect(w.counts).toMatchObject({ key: text.length, shortcut: 0 });
  });

  it("cursor samples: unchanged positions are skipped, the still point is repeated before movement resumes", () => {
    const lines: string[] = [];
    const w = new EventLogWriter((l) => lines.push(l));
    w.move(0, 100, 100);
    for (let t = 16; t <= 1000; t += 16) w.move(t, 100, 100); // still for a second
    w.move(1008, 200, 100);
    w.end(1500);
    const ev = parseEventLog(lines.join(""));
    expect(ev.map((e) => e.t)).toEqual([0, 992, 1008, 1500]);
    // interpolation does not smear the jump back over the still second
    expect(rawCursorAt(ev, 900)).toEqual({ x: 100, y: 100 });
    expect(rawCursorAt(ev, 1000)!.x).toBeCloseTo(150, 6);
  });

  it("mouse buttons", () => {
    expect([mouseButton(1), mouseButton(2), mouseButton(3), mouseButton(undefined)]).toEqual(["left", "right", "middle", "left"]);
  });
});
