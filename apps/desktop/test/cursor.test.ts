import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ screen: {} }));
import { cursorBaked } from "../src/main/recording";

// Windows #9: Lens's own cursor is drawn only when the capture really left the OS cursor out
describe("cursorBaked", () => {
  it("is clean only for getDisplayMedia reporting cursor never", () => {
    expect(cursorBaked({ requested: "never", reported: "never", api: "getDisplayMedia" })).toBe(false);
  });
  it("is baked when Chromium ignores the constraint, on the legacy path, when asked, or unknown", () => {
    expect(cursorBaked({ requested: "never", reported: "always", api: "getDisplayMedia" })).toBe(true);
    expect(cursorBaked({ requested: "never", reported: null, api: "getDisplayMedia" })).toBe(true);
    expect(cursorBaked({ requested: "never", reported: "never", api: "getUserMedia" })).toBe(true);
    expect(cursorBaked({ requested: "always", reported: "never", api: "getDisplayMedia" })).toBe(true);
    expect(cursorBaked(undefined)).toBe(true);
  });
});
