/**
 * The static viewer page uploaded next to a shared export (demand #13): one self-contained HTML file
 * (inline CSS + a few lines of script for chapter seeking, no external requests), with the video,
 * its poster, the title and the chapter list when the project has chapters.
 */

export interface ViewerChapter {
  /** Start on the output clock, seconds. */
  t: number;
  title: string;
}

export interface ViewerInput {
  title: string;
  /** URL of the MP4 (relative "video.mp4" for a public bucket, or a presigned URL). */
  videoUrl: string;
  posterUrl: string;
  width: number;
  height: number;
  durationSec: number;
  chapters: ViewerChapter[];
  /** ISO time the link was made. */
  createdAt: string;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function viewerHtml(v: ViewerInput): string {
  const title = escapeHtml(v.title.trim() || "Lens recording");
  const chapters = v.chapters
    .filter((c) => Number.isFinite(c.t) && c.t >= 0 && c.t < Math.max(v.durationSec, 0.001) && c.title.trim())
    .sort((a, b) => a.t - b.t);
  const list = chapters.length
    ? `<section class="chapters" aria-label="Chapters"><h2>Chapters</h2><ol>${chapters
        .map((c) => `<li><button type="button" data-t="${c.t.toFixed(3)}"><span class="t">${clock(c.t)}</span><span class="n">${escapeHtml(c.title.trim())}</span></button></li>`)
        .join("")}</ol></section>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src * data: blob:; img-src * data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<meta property="og:title" content="${title}">
<meta property="og:type" content="video.other">
<style>
:root{color-scheme:dark;--bg:#0d0f12;--fg:#e8eaed;--mut:#9aa0a6;--acc:#7ab8a6}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:22px;margin:0 0 14px;font-weight:650;overflow-wrap:anywhere}
.player{background:#000;border-radius:12px;overflow:hidden;aspect-ratio:${v.width} / ${v.height};max-height:78vh;margin:0 auto}
video{display:block;width:100%;height:100%;background:#000}
.meta{color:var(--mut);font-size:13px;margin:10px 0 0}
.chapters h2{font-size:15px;margin:22px 0 8px}
.chapters ol{list-style:none;margin:0;padding:0}
.chapters button{all:unset;cursor:pointer;display:flex;gap:12px;width:100%;padding:7px 10px;border-radius:8px}
.chapters button:hover,.chapters button:focus-visible,.chapters button.on{background:#1b1f24}
.chapters .t{color:var(--acc);font-variant-numeric:tabular-nums;min-width:52px}
footer{color:var(--mut);font-size:12px;margin-top:28px}
</style>
</head>
<body>
<main>
<h1>${title}</h1>
<div class="player"><video id="v" controls playsinline preload="metadata" poster="${escapeHtml(v.posterUrl)}" src="${escapeHtml(v.videoUrl)}"></video></div>
<p class="meta">${clock(v.durationSec)} · ${v.width}×${v.height}</p>
${list}
<footer>Shared with Lens</footer>
</main>
<script>
(function(){var v=document.getElementById("v"),b=[].slice.call(document.querySelectorAll(".chapters button"));
b.forEach(function(x){x.addEventListener("click",function(){v.currentTime=parseFloat(x.getAttribute("data-t"));v.play&&v.play().catch(function(){});});});
function mark(){var t=v.currentTime,cur=null;b.forEach(function(x){if(parseFloat(x.getAttribute("data-t"))<=t+0.05)cur=x;});b.forEach(function(x){x.classList.toggle("on",x===cur);});}
v.addEventListener("timeupdate",mark);
var m=/[#&]t=(\\d+(?:\\.\\d+)?)/.exec(location.hash);if(m)v.addEventListener("loadedmetadata",function(){v.currentTime=parseFloat(m[1]);},{once:true});})();
</script>
</body>
</html>
`;
}
