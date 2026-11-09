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
  captureSource(id: string, opts?: { systemAudio?: boolean }): Promise<{ ok: boolean }>;
  pickRegion(displayId: string | undefined): Promise<{ x: number; y: number; w: number; h: number } | null>;
  teleprompter(): Promise<{ open: boolean }>;
  status(): Promise<{ hotkey: string; hook: boolean; hookError: string | null; recording: boolean; recordingsDir: string; platform: string }>;
  begin(): Promise<{ dir: string }>;
  started(info: unknown): Promise<unknown>;
  chunk(kind: "video" | "audio" | "camera" | "system", data: ArrayBuffer): void;
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
let webcamRec: MediaRecorder | null = null;
let systemRec: MediaRecorder | null = null;
// ---- recorder home (Windows #7): mode cards + devices column
type Mode = "screen" | "region" | "window";
let mode: Mode = "screen";
/** Custom mode: the dragged region as fractions of the chosen screen (null = not drawn yet). */
let region: { x: number; y: number; w: number; h: number } | null = null;
let micStream: MediaStream | null = null;
let webcamStream: MediaStream | null = null;
let meterStop: (() => void) | null = null;
const meter = { peak: 0 };
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

let sourcesError: string | null = null;
async function loadSources(): Promise<void> {
  try {
    sources = await lens.sources();
    sourcesError = null;
  } catch (e) {
    sources = [];
    sourcesError = e instanceof Error ? e.message : String(e);
  }
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
      if (mode === "region") void drawRegion();
    };
    box.append(b);
  }
  if (!box.childElementCount) {
    const p = document.createElement("p");
    p.className = "empty";
    p.dataset.testid = "sources-empty";
    p.textContent = sourcesError ? `Could not list ${tab}s: ${sourcesError}. Press ↻ to retry.` : tab === "screen" ? "No screens found. Press ↻ to retry." : "No windows to record. Open one, then press ↻.";
    box.append(p);
  }
  $("pick-title").textContent = mode === "window" ? "Windows" : mode === "region" ? "Pick the screen, then drag the area to record" : "Screens";
  $("tab-screen").classList.toggle("active", tab === "screen");
  $("tab-window").classList.toggle("active", tab === "window");
}

function pickMime(kind: "video" | "audio"): string {
  // H.264 first: OpenH264 / hardware encoders keep up where VP8 fell behind (2-core test box: frame gaps up to 0.5 s, frames queued in memory)
  const list = kind === "video" ? ["video/webm;codecs=h264", "video/webm;codecs=vp8", "video/webm"] : ["audio/webm;codecs=opus", "audio/webm"];
  return list.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
}

function queueChunk(kind: "video" | "audio" | "camera" | "system", blob: Blob): void {
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

let captureApi: "getDisplayMedia" | "getUserMedia" = "getDisplayMedia";

/**
 * The capture stream. getDisplayMedia (the main process hands it the chosen source, no picker) so the
 * OS cursor can be left out (cursor: "never"; Windows #9). Electron builds without
 * setDisplayMediaRequestHandler support fall back to the legacy desktop capture, which always
 * includes the OS cursor.
 */
async function captureStream(src: Source, size: Source["size"], cursor: "never" | "always", systemAudio = false): Promise<MediaStream> {
  try {
    await lens.captureSource(src.id, { systemAudio });
    const s = await navigator.mediaDevices.getDisplayMedia({
      audio: systemAudio,
      video: {
        cursor,
        frameRate: { ideal: FPS, max: FPS },
        ...(size ? { width: { ideal: size.width, max: size.width }, height: { ideal: size.height, max: size.height } } : { width: { max: 3840 }, height: { max: 2160 } }),
      } as unknown as MediaTrackConstraints,
    });
    captureApi = "getDisplayMedia";
    return s;
  } catch (e) {
    console.warn("[lens] getDisplayMedia failed, legacy desktop capture (OS cursor included):", e);
    captureApi = "getUserMedia";
    return navigator.mediaDevices.getUserMedia({
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
  }
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
    const cursorWanted: "never" | "always" = $<HTMLInputElement>("syscursor").checked ? "always" : "never";
    const wantSystem = $<HTMLSelectElement>("sys-audio").value === "loopback";
    if (mode === "region" && !region) throw new Error("drag the area to record first (Custom mode)");
    const video = await captureStream(src, size, cursorWanted, wantSystem);
    const vt = video.getVideoTracks()[0];
    const cursorInfo = { requested: cursorWanted, reported: ((vt?.getSettings() as { cursor?: string } | undefined)?.cursor ?? null), api: captureApi };
    streams = [video];
    const v = $<HTMLVideoElement>("v");
    v.srcObject = video;
    await v.play();
    if (!v.videoWidth) await new Promise((r) => v.addEventListener("loadedmetadata", r, { once: true }));
    capture = { width: v.videoWidth, height: v.videoHeight };
    let mic: MediaStream | null = null;
    const micId = $<HTMLSelectElement>("mic-device").value;
    if (micId || $<HTMLInputElement>("mic").checked) mic = micStream ?? (await openMic(micId));
    const webcam = $<HTMLSelectElement>("cam-device").value ? webcamStream : null;
    if (mic) streams.push(mic);
    if (webcam) streams.push(webcam);
    const sysTracks = video.getAudioTracks();
    const sysStream = sysTracks.length ? new MediaStream(sysTracks) : null;
    await lens.begin();
    const vMime = pickMime("video");
    videoRec = new MediaRecorder(video, { mimeType: vMime, videoBitsPerSecond: Math.round(capture.width * capture.height * FPS * 0.12) });
    videoRec.ondataavailable = (e) => queueChunk("video", e.data);
    audioRec = mic ? new MediaRecorder(mic, { mimeType: pickMime("audio"), audioBitsPerSecond: 128000 }) : null;
    if (audioRec) audioRec.ondataavailable = (e) => queueChunk("audio", e.data);
    webcamRec = webcam ? new MediaRecorder(webcam, { mimeType: pickMime("video"), videoBitsPerSecond: 2_500_000 }) : null;
    if (webcamRec) webcamRec.ondataavailable = (e) => queueChunk("camera", e.data);
    systemRec = sysStream ? new MediaRecorder(sysStream, { mimeType: pickMime("audio"), audioBitsPerSecond: 128000 }) : null;
    if (systemRec) systemRec.ondataavailable = (e) => queueChunk("system", e.data);
    const wStarted = webcamRec ? startedEvent(webcamRec) : Promise.resolve(0);
    const sStarted = systemRec ? startedEvent(systemRec) : Promise.resolve(0);
    const vStarted = startedEvent(videoRec);
    const aStarted = audioRec ? startedEvent(audioRec) : Promise.resolve(0);
    const frames = watchFrames(v);
    const startCall = nowEpoch();
    videoRec.start(1000);
    audioRec?.start(1000);
    webcamRec?.start(1000);
    systemRec?.start(1000);
    const startEvent = await vStarted;
    const micStart = await aStarted;
    const webcamStart = await wStarted;
    const systemStart = await sStarted;
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
      mic: audioRec ? { mime: audioRec.mimeType, start: micStart } : null, cursor: cursorInfo,
      webcam: webcamRec ? { mime: webcamRec.mimeType, start: webcamStart } : null,
      system: systemRec ? { mime: systemRec.mimeType, start: systemStart } : null,
      crop: mode === "region" && region ? { x: Math.round(region.x * capture.width), y: Math.round(region.y * capture.height), w: Math.round(region.w * capture.width), h: Math.round(region.h * capture.height) } : null,
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
    micStream = null;
    webcamStream = null;
    void applyDevices();
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
  const done = [videoRec, audioRec, webcamRec, systemRec].filter((r): r is MediaRecorder => !!r).map((r) => {
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
  webcamRec = null;
  systemRec = null;
  // the device streams were stopped with the rest: reopen the previews / meter for the next take
  micStream = null;
  webcamStream = null;
  void applyDevices();
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
async function openMic(deviceId: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
}

function startMeter(stream: MediaStream): () => void {
  const ctx = new AudioContext();
  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(an);
  const buf = new Float32Array(an.fftSize);
  let raf = 0;
  const tick = () => {
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const db = 20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-9);
    const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
    meter.peak = Math.max(meter.peak, pct);
    $("mic-level").style.width = `${pct.toFixed(0)}%`;
    raf = requestAnimationFrame(tick);
  };
  tick();
  return () => {
    cancelAnimationFrame(raf);
    void ctx.close();
    $("mic-level").style.width = "0%";
  };
}

/** Fill the camera / mic lists (labels appear once a device has been opened). */
async function listDevices(): Promise<void> {
  const all = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
  for (const [id, kind, noun] of [["cam-device", "videoinput", "Camera"], ["mic-device", "audioinput", "Microphone"]] as const) {
    const sel = $<HTMLSelectElement>(id);
    const keep = sel.value;
    sel.length = 1;
    all.filter((d) => d.kind === kind && d.deviceId !== "communications").forEach((d, i) => {
      const o = document.createElement("option");
      o.value = d.deviceId || `${kind}-${i}`;
      o.textContent = d.label || `${noun} ${i + 1}`;
      sel.append(o);
    });
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }
}

/** Open / close the selected mic (level meter) and camera (preview) when the choice changes. */
async function applyDevices(): Promise<void> {
  if (state !== "idle") return;
  const micId = $<HTMLSelectElement>("mic-device").value;
  meterStop?.();
  meterStop = null;
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  $<HTMLInputElement>("mic").checked = !!micId;
  if (micId) {
    try {
      micStream = await openMic(micId);
      meterStop = startMeter(micStream);
    } catch (e) {
      setStatus(`Microphone unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const camId = $<HTMLSelectElement>("cam-device").value;
  webcamStream?.getTracks().forEach((t) => t.stop());
  webcamStream = null;
  const pv = $<HTMLVideoElement>("cam-preview");
  pv.hidden = !camId;
  if (camId) {
    try {
      webcamStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: camId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false });
      pv.srcObject = webcamStream;
      await pv.play().catch(() => undefined);
    } catch (e) {
      setStatus(`Camera unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else pv.srcObject = null;
  await listDevices();
}

function setMode(m: Mode): void {
  mode = m;
  tab = m === "window" ? "window" : "screen";
  document.querySelectorAll<HTMLButtonElement>(".mode").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
  if (selected && selected.kind !== tab) selected = sources.find((s) => s.kind === tab) ?? null;
  $("region-info").hidden = m !== "region";
  if (m === "region") $("region-info").textContent = region ? `Area ${Math.round(region.w * 100)}% x ${Math.round(region.h * 100)}% of the screen · click the screen again to redraw` : "Click a screen to drag the area to record.";
  renderSources();
}

async function drawRegion(): Promise<void> {
  const r = await lens.pickRegion(selected?.displayId);
  if (r && r.w > 0.01 && r.h > 0.01) region = r;
  setMode("region");
}

document.querySelectorAll<HTMLButtonElement>(".mode").forEach((b) => (b.onclick = () => setMode(b.dataset.mode as Mode)));
$("mic-device").onchange = () => void applyDevices();
$("cam-device").onchange = () => void applyDevices();
$("teleprompter").onclick = () => void lens.teleprompter();
navigator.mediaDevices.addEventListener?.("devicechange", () => void listDevices());
$("tab-screen").onclick = () => ((tab = "screen"), renderSources());
$("tab-window").onclick = () => ((tab = "window"), renderSources());
$("refresh").onclick = () => void loadSources();

void (async () => {
  const st = await lens.status();
  $("hotkey").textContent = st.hotkey.replace("CommandOrControl", st.platform === "darwin" ? "Cmd" : "Ctrl");
  if (!st.hook) $("hookwarn").textContent = "Click logging is off (input hook unavailable).";
  await loadSources();
  if (st.platform !== "win32") {
    // Chromium captures system audio (loopback) on Windows only
    $<HTMLSelectElement>("sys-audio").disabled = true;
    $("sys-audio-note").hidden = false;
    $("sys-audio-note").textContent = "System audio recording works on Windows.";
  }
  await listDevices();
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
  // footer shows the running version with the product name (0.1.1: "Lens v0.1.1", was "v0.1.0")
  $("version").textContent = `Lens v${u.current ?? "?"}`;
  renderUpdate(u);
});

// automation hook (e2e tests drive the recorder through it, like the editor's window.__lens)
(window as unknown as { lensRecorder: unknown }).lensRecorder = {
  start,
  stop,
  setMode,
  setRegion: (r: typeof region) => ((region = r), setMode("region")),
  devices: () => ({ mode, region, cams: [...$<HTMLSelectElement>("cam-device").options].map((o) => o.value), mics: [...$<HTMLSelectElement>("mic-device").options].map((o) => o.value), micPeak: meter.peak, webcamOpen: !!webcamStream, micOpen: !!micStream }),
  state: () => ({ state, capture, selected: selected?.id ?? null, sources: sources.map((s) => ({ id: s.id, kind: s.kind, name: s.name })), camera: camera?.state ?? null,
    zooms: camera?.zoomSegments(liveT) ?? [], liveT, liveLog, lastResult, lastError, update }),
};
