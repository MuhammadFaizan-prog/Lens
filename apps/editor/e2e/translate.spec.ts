/**
 * Caption translation in the editor (demand #8), on apps/editor/sample-translate (Spanish + Urdu
 * tracks made on-device by translate/lens-translate, Urdu selected).
 *
 * Bounds (written before the first run, docs/Tracker.md):
 *  - switching the caption language (Captions tab, Languages) changes the caption the plan draws to
 *    that track's words and changes the preview's caption band (mean |diff| >= 5 on the 8 px grid,
 *    rows of the bottom 30%) while nothing above the band changes (diff 0); undo puts the language
 *    and every pixel back (diff 0)
 *  - side-by-side edit of one segment shows the new words in the preview's caption; undo restores
 *  - Translate to… French runs the on-device model with progress, adds a French track, selects it
 *    and the caption shows French words; undo removes the track again
 *  - the .srt / .vtt files for the selected language hold its words on the output clock
 */
import { test } from "@playwright/test";
import path from "node:path";
import { EDITOR, expect, openEditor, seek, settle, shot, state, waitDrawn } from "./helpers";

const DIR = path.join(EDITOR, "sample-translate");
const URL = `/?dir=${encodeURIComponent(DIR)}`;

async function band(page: import("@playwright/test").Page): Promise<{ top: number[]; bottom: number[] }> {
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid="preview"]') as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    const top: number[] = [];
    const bottom: number[] = [];
    const y0 = Math.floor(c.height * 0.7);
    for (let y = 0; y < c.height; y += 8)
      for (let x = 0; x < c.width; x += 8) {
        const i = (y * c.width + x) * 4;
        (y < y0 ? top : bottom).push(d[i]!, d[i + 1]!, d[i + 2]!);
      }
    return { top, bottom };
  });
}

const mad = (a: number[], b: number[]) => a.reduce((s, v, i) => s + Math.abs(v - b[i]!), 0) / a.length;

test("caption language switch, side-by-side edit, translate with progress, subtitles, undo", async ({ page }) => {
  test.setTimeout(240_000);
  await openEditor(page, URL);
  await page.getByTestId("tab-captions").click();
  // a frame inside the second segment, with a highlighted word
  await seek(page, 190);
  await page.waitForTimeout(400); // Noto Naskh Arabic loads with the plan
  await waitDrawn(page);
  let s = await state(page);
  expect(s.project.translations.language).toBe("ur");
  const urWords = s.caption!.words;
  expect(urWords.join(" ")).toMatch(/[\u0600-\u06FF]/);
  const ur = await band(page);

  // switch to Spanish
  await page.getByTestId("caption-language").selectOption("es");
  await waitDrawn(page);
  s = await state(page);
  expect(s.project.translations.language).toBe("es");
  const es = s.project.translations.tracks.find((t: any) => t.language === "es");
  const esWords: string[] = es.segments.flatMap((x: any) => x.text.split(" "));
  expect(s.caption!.words.length).toBeGreaterThan(0);
  for (const w of s.caption!.words) expect(esWords).toContain(w);
  const esPx = await band(page);
  const capDiff = mad(ur.bottom, esPx.bottom);
  const restDiff = mad(ur.top, esPx.top);
  console.log(`ur -> es: caption band mean |diff| ${capDiff.toFixed(2)}, above the band ${restDiff.toFixed(3)}`);
  expect(capDiff).toBeGreaterThanOrEqual(5);
  expect(restDiff).toBe(0);
  await shot(page, "translate-es");

  // undo: Urdu and the same pixels
  await page.keyboard.press("Control+z");
  await waitDrawn(page);
  s = await state(page);
  expect(s.project.translations.language).toBe("ur");
  expect(s.caption!.words).toEqual(urWords);
  const back = await band(page);
  expect(mad(ur.bottom, back.bottom) + mad(ur.top, back.top)).toBe(0);
  await expect(page.getByTestId("caption-language")).toHaveValue("ur");
  await shot(page, "translate-ur");

  // side-by-side edit of the Spanish second segment
  await page.getByTestId("caption-language").selectOption("es");
  await waitDrawn(page);
  const seg = es.segments[1];
  await expect(page.getByTestId(`tr-src-${seg.id}`)).toHaveText(seg.source);
  const box = page.getByTestId(`tr-text-${seg.id}`);
  await box.fill("Mire cómo la cámara sigue cada clic.");
  await box.press("Enter");
  await waitDrawn(page);
  s = await state(page);
  expect(s.project.translations.tracks.find((t: any) => t.language === "es").segments[1]).toMatchObject({ text: "Mire cómo la cámara sigue cada clic.", edited: true });
  expect(["Mire", "cómo", "la", "cámara", "sigue", "cada", "clic."]).toEqual(expect.arrayContaining(s.caption!.words));
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+z");
  await waitDrawn(page);
  s = await state(page);
  expect(s.project.translations.tracks.find((t: any) => t.language === "es").segments[1].text).toBe(seg.text);

  // subtitles for the selected language, on the output clock
  const srt = await page.evaluate(() => (window as any).__lens.store.subtitleFile("es", "srt"));
  const vtt = await page.evaluate(() => (window as any).__lens.store.subtitleFile("es", "vtt"));
  expect(srt.name).toBe("captions.es.srt");
  expect(srt.text).toContain(es.segments[0].text.split(" ")[0]);
  expect(vtt.text.startsWith("WEBVTT")).toBe(true);
  expect(vtt.text).toContain("-->");

  // Translate to… French, with progress
  await page.getByTestId("translate-to").selectOption("fr");
  await page.getByTestId("translate-go").click();
  await page.waitForFunction(() => (window as any).__lens.store.get().translateRun?.state === "done", null, { timeout: 120_000 });
  await settle(page);
  s = await state(page);
  expect(s.project.translations.language).toBe("fr");
  const fr = s.project.translations.tracks.find((t: any) => t.language === "fr");
  expect(fr.segments.length).toBe(es.segments.length);
  const frWords: string[] = fr.segments.flatMap((x: any) => x.text.split(" "));
  for (const w of s.caption!.words) expect(frWords).toContain(w);
  const run = await page.evaluate(() => (window as any).__lens.store.get().translateRun);
  console.log(`translate to fr: ${run.total} segments in ${run.seconds} s`);
  expect(run.total).toBe(es.segments.length);
  await shot(page, "translate-fr");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+z");
  await waitDrawn(page);
  s = await state(page);
  expect(s.project.translations.tracks.map((t: any) => t.language).sort()).toEqual(["es", "ur"]);
});
