/**
 * Recorder window: source picker, mic toggle, Start / Stop (button, global hotkey, tray), capture
 * with desktopCapturer + getUserMedia + MediaRecorder (webm chunks streamed to the main process every
 * second), and the live preview that applies the engine's auto-zoom to the click stream as it arrives.
 */
import { LiveCamera, viewportOf } from "../shared/liveCamera";
import type { InputEvent } from "../../../../packages/engine/src/types";

interface Source {
  id: string;
  name: string;
  kind: "screen" | "window";
  displayId?: string;
  thumbnail: string;
  size: { width: number; height: number } | null;
}

interface Bridge {
  sources(): Promise<Source[]>;
  status(): Promise<{ hotkey: string; hook: boolean; hookError: string | null; recording: boolean; recordingsDir: string; platform: string }>;
  begin(): Promise<{ dir: string }>;
  started(info: unknown): Promise<unknown>;
  chunk(kind: "video" | "audio", data: ArrayBuffer): void;
  stop(opts?: { stopAt?: number }): Promise<{ dir: string; durationMs: number; warnings: string[]; clickSources: Record<string, number> }>;
  abort(): Promise<void>;
  onToggle(fn: () => void): void;
  onLive(fn: (b: { t: number; cursor: { x: number; y: number } | null; events: InputEvent[] }) => void): void;
  onFinalizing(fn: (stage: string) => void): void;
  updateState(): Promise<UpdateUi>;
  updateCheck(): Promise<UpdateUi>;
  updateDownload(): Promise<UpdateUi>;
  updateInstall(): Promise<void>;
  onUpdate(fn: (s: UpdateUi) => void): void;
}

interface UpdateUi {
  status: string;
  version?: string;
  percent?: number;
  message?: string;
  reason?: string;
  current?: string;
}

const lens = (window as unknown as { lensDesktop: Bridge }).lensDesktop;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const FPS = Number(new URLSearchParams(location.search).get("fps")) || 30;
const nowEpoch = () => performance.timeOrigin + performance.now();

let sources: Source[] = [];
let tab: "screen" | "window" = "screen";
let selected: Source | null = null;
let state: "idle" | "starting" | "recording" | "stopping" = "idle";
let streams: MediaStream[] = [];
let videoRec: MediaRecorder | null = null;
let audioRec: MediaRecorder | null = null;
let sendChain: Promise<void> = Promise.resolve();
let camera: LiveCamera | null = null;
let capture = { width: 0, height: 0 };
let liveCursor: { x: number; y: number } | null = null;
let liveT = 0;
let videoStart = 0;
let ripples: Array<{ t: number; x: number; y: number }> = [];
let lastResult: unknown = null;
let lastError: string | null = null;
const liveLog: { batches: number; downs: number } = { batches: 0, downs: 0 };

function setStatus(text: string, rec = false): void {
  const s = $("status");
  s.textContent = text;
  s.classList.toggle("rec", rec);
}

async function loadSources(): Promise<void> {
  sources = await lens.sources();
  if (!selected || !sources.some((s) => s.id === selected!.id)) selected = sources.find((s) => s.kind === "screen") ?? sources[0] ?? null;
  renderSources();
}

function renderSources(): void {
  const box = $("sources");
  box.innerHTML = "";
  for (const s of sources.filter((x) => x.kind === tab)) {
    const b = document.createElement("button");
    b.className = "src" + (selected?.id === s.id ? " sel" : "");
    b.dataset.id = s.id;
    const img = document.createElement("img");
    img.src = s.thumbnail;
    img.alt = "";
    const label = document.createElement("span");
    label.textContent = s.name;
    b.append(img, label);
    b.onclick = () => {
      selected = s;
      renderSources();
    };
    box.append(b);
  }
  $("tab-screen").classList.toggle("active", tab === "screen");
  $("tab-window").classList.toggle("active", tab === "window");
}

function pickMime(kind: "video" | "audio"): string {
  // H.264 first: OpenH264 / hardware encoders keep up where VP8 fell behind (2-core test box: frame gaps up to 0.5 s, frames queued in memory)
  const list = kind === "video" ? ["video/webm;codecs=h264", "video/webm;codecs=vp8", "video/webm"] : ["audio/webm;codecs=opus", "audio/webm"];
  return list.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
}

function queueChunk(kind: "video" | "audio", blob: Blob): void {
  if (!blob.size) return;
  sendChain = sendChain.then(async () => lens.chunk(kind, await blob.arrayBuffer()));
}

function startedEvent(r: MediaRecorder): Promise<number> {
  return new Promise((resolve) => r.addEventListener("start", () => resolve(nowEpoch()), { once: true }));
}

/** Frame arrivals on the preview element (requestVideoFrameCallback), on the epoch clock. */
function watchFrames(v: HTMLVideoElement) {
  const seen: Array<{ presented: number; capture: number | null }> = [];
  let on = true;
  const cb = (_now: number, m: VideoFrameCallbackMetadata) => {
    const cap = (m as VideoFrameCallbackMetadata & { captureTime?: number }).captureTime;
    seen.push({ presented: performance.timeOrigin + m.presentationTime, capture: typeof cap === "number" && cap > 0 ? performance.timeOrigin + cap : null });
    if (on) v.requestVideoFrameCallback(cb);
  };
  v.requestVideoFrameCallback(cb);
  return {
    async firstAfter(t: number, timeoutMs: number) {
      const until = nowEpoch() + timeoutMs;
      for (;;) {
        const f = seen.find((x) => (x.capture ?? x.presented) >= t);
        if (f || nowEpoch() > until) return f ?? null;
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    stop() {
      on = false;
    },
  };
}

function stoppedEvent(r: MediaRecorder): Promise<void> {
  return new Promise((resolve) => r.addEventListener("stop", () => resolve(), { once: true }));
}

async function start(sourceId?: string): Promise<void> {
  if (state !== "idle") return;
  if (sourceId) selected = sources.find((s) => s.id === sourceId) ?? selected;
  if (!selected) await loadSources();
  const src = selected;
  if (!src) throw new Error("no capture source");
  state = "starting";
  lastError = null;
  setStatus("Starting…");
  $<HTMLButtonElement>("go").disabled = true;
  try {
    const size = src.size;
    const video = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        // Chromium's desktop capture constraints (Electron)
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: src.id,
          maxFrameRate: FPS,
          ...(size ? { maxWidth: size.width, maxHeight: size.height, minWidth: size.width, minHeight: size.height } : { maxWidth: 3840, maxHeight: 2160 }),
        },
      } as unknown as MediaTrackConstraints,
    });
    streams = [video];
    const v = $<HTMLVideoElement>("v");
    v.srcObject = video;
    await v.play();
    if (!v.videoWidth) await new Promise((r) => v.addEventListener("loadedmetadata", r, { once: true }));
    capture = { width: v.videoWidth, height: v.videoHeight };
    let mic: MediaStream | null = null;
    if ($<HTMLInputElement>("mic").checked) {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
      streams.push(mic);
    }
    await lens.begin();
    const vMime = pickMime("video");
    videoRec = new MediaRecorder(video, { mimeType: vMime, videoBitsPerSecond: Math.round(capture.width * capture.height * FPS * 0.12) });
    videoRec.ondataavailable = (e) => queueChunk("video", e.data);
    audioRec = mic ? new MediaRecorder(mic, { mimeType: pickMime("audio"), audioBitsPerSecond: 128000 }) : null;
    if (audioRec) audioRec.ondataavailable = (e) => queueChunk("audio", e.data);
    const vStarted = startedEvent(videoRec);
    const aStarted = audioRec ? startedEvent(audioRec) : Promise.resolve(0);
    const frames = watchFrames(v);
    const startCall = nowEpoch();
    videoRec.start(1000);
    audioRec?.start(1000);
    const startEvent = await vStarted;
    const micStart = await aStarted;
    // Video clock origin = the first frame the recorder took, i.e. the first frame reaching the stream
    // after start(). Its capture time (requestVideoFrameCallback captureTime) when Chromium reports it,
    // else when it was presented; the recorder's "start" event fires only after that frame was encoded.
    const first = await frames.firstAfter(startCall, 1500);
    frames.stop();
    videoStart = first?.capture ?? first?.presented ?? startCall;
    const clock = { startCall, startEvent, firstCapture: first?.capture ?? null, firstPresented: first?.presented ?? null, chosen: first?.capture ? "firstCapture" : first ? "firstPresented" : "startCall" };
    camera = new LiveCamera(capture);
    ripples = [];
    await lens.started({
      sourceId: src.id, sourceName: src.name, kind: src.kind, displayId: src.displayId, capture, fps: FPS, videoMime: vMime, videoStart, clock,
      mic: audioRec ? { mime: audioRec.mimeType, start: micStart } : null,
    });
    state = "recording";
    setStatus("Recording", true);
    $("pick").hidden = true;
    $("live").hidden = false;
    const go = $<HTMLButtonElement>("go");
    go.textContent = "Stop recording";
    go.classList.add("stop");
    go.disabled = false;
    requestAnimationFrame((n) => draw(n));
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    setStatus(`Could not start: ${lastError}`);
    for (const s of streams) s.getTracks().forEach((t) => t.stop());
    streams = [];
    await lens.abort();
    state = "idle";
    $<HTMLButtonElement>("go").disabled = false;
    throw e;
  }
}

async function stop(): Promise<unknown> {
  if (state !== "recording") return null;
  const stopAt = nowEpoch();
  state = "stopping";
  setStatus("Saving…");
  $<HTMLButtonElement>("go").disabled = true;
  const done = [videoRec, audioRec].filter((r): r is MediaRecorder => !!r).map((r) => {
    const p = stoppedEvent(r);
    r.stop();
    return p;
  });
  await Promise.all(done);
  await sendChain;
  for (const s of streams) s.getTracks().forEach((t) => t.stop());
  streams = [];
  // let the capture's frame buffers go (several hundred MB of shared memory at 720p otherwise stay mapped)
  const v = $<HTMLVideoElement>("v");
  v.pause();
  v.srcObject = null;
  v.load();
  videoRec = null;
  audioRec = null;
  try {
    lastResult = await lens.stop({ stopAt });
    setStatus("Saved — opened in the editor");
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    setStatus(`Save failed: ${lastError}`);
  }
  state = "idle";
  $("pick").hidden = false;
  $("live").hidden = true;
  const go = $<HTMLButtonElement>("go");
  go.textContent = "Start recording";
  go.classList.remove("stop");
  go.disabled = false;
  void loadSources();
  return lastResult;
}

let lastDraw = 0;
function draw(now: number = performance.now()): void {
  if (state !== "recording" && state !== "stopping") return;
  // ~30 fps is plenty for a 380 px preview and leaves the CPU to the capture encoder
  if (now - lastDraw < 30) return void requestAnimationFrame((n) => draw(n));
  lastDraw = now;
  const c = $<HTMLCanvasElement>("preview");
  const g = c.getContext("2d")!;
  const v = $<HTMLVideoElement>("v");
  const cam = camera?.state ?? { cx: capture.width / 2, cy: capture.height / 2, scale: 1 };
  const vp = viewportOf(cam, capture.width, capture.height);
  g.fillStyle = "#000";
  g.fillRect(0, 0, c.width, c.height);
  if (v.videoWidth) g.drawImage(v, vp.x, vp.y, vp.w, vp.h, 0, 0, c.width, c.height);
  const k = c.width / vp.w;
  const toPx = (x: number, y: number) => [(x - vp.x) * k, (y - vp.y) * k] as const;
  ripples = ripples.filter((r) => liveT - r.t < 600);
  for (const r of ripples) {
    const u = (liveT - r.t) / 600;
    const [x, y] = toPx(r.x, r.y);
    g.strokeStyle = `rgba(90, 200, 255, ${1 - u})`;
    g.lineWidth = 2;
    g.beginPath();
    g.arc(x, y, 6 + 18 * u, 0, Math.PI * 2);
    g.stroke();
  }
  if (liveCursor) {
    const [x, y] = toPx(liveCursor.x, liveCursor.y);
    g.fillStyle = "rgba(255,255,255,0.9)";
    g.beginPath();
    g.arc(x, y, 3, 0, Math.PI * 2);
    g.fill();
  }
  const secs = Math.max(0, (nowEpoch() - videoStart) / 1000);
  $("timer").textContent = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(Math.floor(secs % 60)).padStart(2, "0")}`;
  $("zoominfo").textContent = `${cam.scale.toFixed(2)}×`;
  requestAnimationFrame((n) => draw(n));
}

lens.onLive((b) => {
  liveLog.batches++;
  for (const e of b.events) {
    camera?.push(e);
    if (e.type === "down") {
      liveLog.downs++;
      ripples.push({ t: e.t, x: e.x, y: e.y });
    }
  }
  if (b.cursor) liveCursor = b.cursor;
  liveT = b.t;
  if (camera && liveCursor) camera.step(b.t, liveCursor);
});

lens.onFinalizing((stage) => setStatus(`Saving ${stage}…`));
lens.onToggle(() => void (state === "idle" ? start().catch(() => undefined) : stop()));
$("go").onclick = () => void (state === "idle" ? start().catch(() => undefined) : stop());
$("tab-screen").onclick = () => ((tab = "screen"), renderSources());
$("tab-window").onclick = () => ((tab = "window"), renderSources());
$("refresh").onclick = () => void loadSources();

void (async () => {
  const st = await lens.status();
  $("hotkey").textContent = st.hotkey.replace("CommandOrControl", st.platform === "darwin" ? "Cmd" : "Ctrl");
  if (!st.hook) $("hookwarn").textContent = "Click logging is off (input hook unavailable).";
  await loadSources();
})();

// ---- auto-update banner (main/updater.ts)
let update: UpdateUi = { status: "idle" };
function renderUpdate(u: UpdateUi): void {
  update = { ...update, ...u };
  const box = $("update");
  const btn = $<HTMLButtonElement>("update-btn");
  const text = $("update-text");
  box.hidden = !["available", "downloading", "downloaded", "error"].includes(update.status);
  btn.hidden = false;
  btn.disabled = false;
  if (update.status === "available") {
    text.textContent = `Update available v${update.version}`;
    btn.textContent = "Update";
  } else if (update.status === "downloading") {
    text.textContent = `Downloading v${update.version}… ${Math.round(update.percent ?? 0)}%`;
    btn.textContent = "Update";
    btn.disabled = true;
  } else if (update.status === "downloaded") {
    text.textContent = `v${update.version} is ready`;
    btn.textContent = "Restart to update";
  } else if (update.status === "error") {
    text.textContent = `Update failed: ${update.message ?? "unknown error"}`;
    btn.textContent = "Retry";
  }
  const link = $("check-updates");
  link.textContent = update.status === "checking" ? "Checking…" : update.status === "none" ? "Up to date · check again" : "Check for updates";
  link.hidden = update.status === "disabled";
}
$("update-btn").onclick = () => {
  if (update.status === "available") void lens.updateDownload();
  else if (update.status === "downloaded") {
    if (state === "recording") return void setStatus("Stop the recording before restarting to update");
    void lens.updateInstall();
  } else void lens.updateCheck();
};
$("check-updates").onclick = (e) => {
  e.preventDefault();
  void lens.updateCheck().then(renderUpdate);
};
lens.onUpdate(renderUpdate);
void lens.updateState().then((u) => {
  $("version").textContent = `v${u.current ?? "?"}`;
  renderUpdate(u);
});

// automation hook (e2e tests drive the recorder through it, like the editor's window.__lens)
(window as unknown as { lensRecorder: unknown }).lensRecorder = {
  start,
  stop,
  state: () => ({ state, capture, selected: selected?.id ?? null, sources: sources.map((s) => ({ id: s.id, kind: s.kind, name: s.name })), camera: camera?.state ?? null,
    zooms: camera?.zoomSegments(liveT) ?? [], liveT, liveLog, lastResult, lastError, update }),
};
