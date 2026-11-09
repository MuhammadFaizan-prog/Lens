// Records real Chromium MediaRecorder audio fixtures (Opus in WebM) for the export audio tests:
//   mono-opus.webm         a mono (channelCount 1) stream, as a Windows mic usually gives
//   (a mid-stream layout change is made in the test from ADTS AAC: Chromium keeps the track
//    mono when the source node changes its channel count)
// Source: a WebAudio voice-like signal (harmonic buzz with syllable envelope) - no recorded media.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
const out = process.argv[2] ?? "test/fixtures/audio";
const exe = fs.existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined;
const browser = await chromium.launch({ executablePath: exe, args: ["--autoplay-policy=no-user-gesture-required", "--disable-gpu"] });
const page = await browser.newPage();
await page.setContent("<html><body>rec</body></html>");
async function rec(seconds, switchAt) {
  return page.evaluate(async ([seconds, switchAt]) => {
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.resume();
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 1;
    dest.channelCountMode = "explicit";
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = 140;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1800;
    const env = ctx.createGain();
    env.gain.value = 0;
    const t0 = ctx.currentTime + 0.05;
    for (let t = 0; t < seconds; t += 0.5) {
      env.gain.setValueAtTime(0, t0 + t);
      env.gain.linearRampToValueAtTime(0.4, t0 + t + 0.05);
      env.gain.setValueAtTime(0.4, t0 + t + 0.3);
      env.gain.linearRampToValueAtTime(0, t0 + t + 0.35);
    }
    osc.connect(lp).connect(env).connect(dest);
    osc.start();
    const mr = new MediaRecorder(dest.stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 64000 });
    const chunks = [];
    mr.ondataavailable = (e) => chunks.push(e.data);
    const stopped = new Promise((r) => (mr.onstop = r));
    mr.start(250);
    if (switchAt) setTimeout(() => { dest.channelCount = 2; }, switchAt * 1000);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    mr.stop();
    await stopped;
    const b = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let s = "";
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
  }, [seconds, switchAt]);
}
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "mono-opus.webm"), Buffer.from(await rec(6, 0), "base64"));
await browser.close();
console.log("ok");
