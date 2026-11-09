/**
 * Preview noise reduction (Windows bug #16): the RNNoise AudioWorklet the editor's AudioEngine routes
 * through (src/media/rnnoiseDenoise.ts: loadRnnoise + RnnoiseWorkletNode, 2 channels, 48 kHz) run
 * in Chromium on the same noisy speech fixture as the export test. Same bounds: noise floor in the
 * pauses drops >= 10 dB, speech level within 1 dB.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

const SR = 48000;
const CHROMIUM = ["/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => fs.existsSync(p));
const hasTools = spawnSync("espeak-ng", ["--version"]).status === 0 && spawnSync("ffmpeg", ["-version"]).status === 0;
const PKG = path.resolve(__dirname, "..", "..", "..", "node_modules", "@sapphi-red", "web-noise-suppressor");

function pcm(file: string): Float32Array {
  const b = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "f32le", "-ac", "1", "-ar", String(SR), "-"], { maxBuffer: 1 << 27 }).stdout as Buffer;
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

/** espeak speech, 2 s pauses, hiss + rumble + hum at about -44 dBFS (as exportAudio.test.ts). */
export function noisySpeech(dir: string): { noisy: Float32Array; spans: Array<[number, number]> } {
  const lines = ["The quick brown fox jumps over the lazy dog.", "Open the settings panel and choose a folder.", "Then press record to start the capture."];
  const speech = lines.map((t, i) => {
    const f = path.join(dir, `s${i}.wav`);
    spawnSync("espeak-ng", ["-v", "en-us", "-s", "150", "-w", f, t]);
    return pcm(f);
  });
  const gap = 2 * SR;
  const total = speech.reduce((n, x) => n + x.length + gap, gap);
  const clean = new Float32Array(total);
  const spans: Array<[number, number]> = [];
  let pos = gap;
  for (const x of speech) {
    clean.set(x, pos);
    spans.push([pos / SR, (pos + x.length) / SR]);
    pos += x.length + gap;
  }
  let peak = 0;
  for (const v of clean) peak = Math.max(peak, Math.abs(v));
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
  let fan = 0;
  const noisy = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    fan = 0.95 * fan + rnd();
    noisy[i] = (clean[i]! / peak) * 0.5 + 0.007 * rnd() + 0.0015 * fan + 0.002 * Math.sin((2 * Math.PI * 50 * i) / SR);
  }
  return { noisy, spans };
}

describe.skipIf(!CHROMIUM || !hasTools)("preview denoise (RNNoise AudioWorklet)", () => {
  it("noise floor drops >= 10 dB, speech within 1 dB", async () => {
    const { chromium } = await import("playwright");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lens-pdn-"));
    const { noisy, spans } = noisySpeech(dir);
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/") {
        res.setHeader("content-type", "text/html");
        return res.end("<!doctype html><title>dn</title>");
      }
      if (url.pathname === "/noisy.f32") return res.end(Buffer.from(noisy.buffer));
      const f = path.join(PKG, "dist", path.normalize(url.pathname.replace(/^\/pkg\//, "")));
      if (!f.startsWith(path.join(PKG, "dist")) || !fs.existsSync(f)) {
        res.statusCode = 404;
        return res.end();
      }
      res.setHeader("content-type", f.endsWith(".wasm") ? "application/wasm" : "text/javascript");
      fs.createReadStream(f).pipe(res);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--disable-gpu"] });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);
      // a string, so vitest does not rewrite the page's dynamic import()
      const out = (await page.evaluate(`(async (sr) => {
        const lib = await import("/pkg/index.js");
        const x = new Float32Array(await (await fetch("/noisy.f32")).arrayBuffer());
        const ctx = new OfflineAudioContext(2, x.length, sr);
        const bin = await lib.loadRnnoise({ url: "/pkg/rnnoise.wasm", simdUrl: "/pkg/rnnoise_simd.wasm" });
        await ctx.audioWorklet.addModule("/pkg/rnnoise/workletProcessor.js");
        const node = new lib.RnnoiseWorkletNode(ctx, { wasmBinary: bin, maxChannels: 2 });
        const buf = ctx.createBuffer(2, x.length, sr);
        buf.copyToChannel(x, 0);
        buf.copyToChannel(x, 1);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(node).connect(ctx.destination);
        src.start();
        // the worklet instantiates its wasm asynchronously: hold the render after the first quantum
        // until it is up (a live AudioContext just plays dry for those first milliseconds)
        ctx.suspend(256 / sr).then(() => setTimeout(() => ctx.resume(), 500));
        const r = await ctx.startRendering();
        return Array.from(r.getChannelData(0));
      })(${SR})`)) as number[];
      const y = Float32Array.from(out);
      const lvl = (s: Float32Array, a: number, b: number) => {
        let acc = 0;
        for (let i = Math.round(a * SR); i < Math.round(b * SR); i++) acc += s[i]! * s[i]!;
        return 10 * Math.log10(acc / ((b - a) * SR) + 1e-24);
      };
      // RNNoise in the worklet delays the signal by one 480-sample frame (+ the 128-sample render quantum)
      let best = 0;
      let lag = 0;
      for (let d = 0; d <= 1200; d += 8) {
        let c = 0;
        for (let i = spans[0]![0] * SR; i < spans[0]![0] * SR + SR; i += 4) c += noisy[i]! * (y[i + d] ?? 0);
        if (c > best) [best, lag] = [c, d];
      }
      const shifted = y.subarray(lag);
      const quiet: Array<[number, number]> = [[0.3, spans[0]![0] - 0.3], ...spans.slice(0, -1).map((s, i) => [s[1] + 0.3, spans[i + 1]![0] - 0.3] as [number, number])];
      const avg = (s: Float32Array, rs: Array<[number, number]>) => rs.reduce((a, [p, q]) => a + lvl(s, p, q), 0) / rs.length;
      const drop = avg(noisy, quiet) - avg(shifted, quiet);
      const sp = avg(shifted, spans) - avg(noisy, spans);
      console.log(`[preview denoise] lag ${lag} samples, floor ${avg(noisy, quiet).toFixed(1)} -> ${avg(shifted, quiet).toFixed(1)} dBFS (drop ${drop.toFixed(1)} dB), speech ${sp.toFixed(2)} dB`);
      expect(drop).toBeGreaterThanOrEqual(10);
      expect(Math.abs(sp)).toBeLessThanOrEqual(1);
    } finally {
      await browser.close();
      server.close();
    }
  }, 90000);
});
