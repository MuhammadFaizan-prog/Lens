"""Steps export (demand #7): one recording -> an interactive click-through demo and a step guide.

Input: the still-frame render plan and the manifest the engine builds (packages/engine/src/
demoExport.ts). Each step's still is the plan frame just before its click, drawn by the same
compositor as the video (so crop, layout, backdrop, privacy masks and brand watermark are exactly
the export's); nothing is drawn on the stills except, in the guide, the highlight box.

Outputs (see docs/InteractiveDemo.md):
  demo:  <out>/index.html  one self-contained file (stills as data: URIs, inline CSS / JS, brand font
                           inlined, a CSP that forbids every network request), plus demo.json (the
                           manifest with hotspots in image px and each still's source->image map)
                           and images/step-NN.jpg (the same stills, for tools and the editor)
  guide: <out>/guide.md + images/guide-NN.png, guide.html (self-contained), guide.pdf (A4, a cover
         page then one page per step; written here, no PDF library)

Clean-room: the page layout, hotspot, tooltip, colours and wording are Lens's own design.
"""
from __future__ import annotations

import base64
import html
import json
import math
import re
import sys
import zlib
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw

from . import annotations as ann
from .render import RenderOptions, render

ROOT = Path(__file__).resolve().parents[2]

# --------------------------------------------------------------------------- geometry


@dataclass
class Affine:
    """source px -> image px: X = ax + kx * x, Y = ay + ky * y."""
    ax: float
    kx: float
    ay: float
    ky: float

    def map(self, x: float, y: float) -> tuple[float, float]:
        return self.ax + self.kx * x, self.ay + self.ky * y

    def inv(self, X: float, Y: float) -> tuple[float, float]:
        return (X - self.ax) / self.kx, (Y - self.ay) / self.ky

    def scaled(self, s: float) -> "Affine":
        """After resizing the image by s (pixel centres: X' = (X + 0.5) s - 0.5)."""
        return Affine(self.ax * s + 0.5 * s - 0.5, self.kx * s, self.ay * s + 0.5 * s - 0.5, self.ky * s)

    def shifted(self, dx: float, dy: float) -> "Affine":
        return Affine(self.ax - dx, self.kx, self.ay - dy, self.ky)

    def as_list(self) -> list[float]:
        return [round(self.ax, 4), round(self.kx, 6), round(self.ay, 4), round(self.ky, 6)]


def frame_affine(plan: dict, f: dict) -> Affine:
    """Source px -> output px for one plan frame, exactly as render.py draws the screen: the source
    crop, then the virtual camera (viewport warp), then the layout's screen rect (rounded to whole
    px as the renderer rounds it)."""
    crop_x, crop_y, src_w, src_h = (float(v) for v in plan["source"]["crop"])
    sx, sy, sw, sh = (int(round(v)) for v in f["layout"]["screen"])
    sw, sh = max(2, sw), max(2, sh)
    cx, cy, s = f["cam"]
    vw, vh = src_w / s, src_h / s
    x0, y0 = cx - vw / 2, cy - vh / 2
    kx, ky = sw / vw, sh / vh
    return Affine(sx - (crop_x + x0) * kx, kx, sy - (crop_y + y0) * ky, ky)


# --------------------------------------------------------------------------- text privacy

_REDACT = None


def redact_text(s: str) -> str:
    """Replace anything the privacy classifiers flag (emails, keys, tokens, cards...) with •••.
    Labels come from OCR around the click, so a click on an email address would otherwise put it in
    a tooltip."""
    global _REDACT
    if _REDACT is None:
        try:
            sys.path.insert(0, str(ROOT / "redact"))
            from lens_redact.classify import classify_text  # noqa: PLC0415

            _REDACT = classify_text
        except Exception:  # pragma: no cover - redact package missing
            _REDACT = False
    if not _REDACT or not s:
        return s
    spans = sorted((f.start, f.end) for f in _REDACT(s))
    if not spans:
        return s
    out, i = [], 0
    for a, b in spans:
        if b <= i:
            continue
        a = max(a, i)
        out.append(s[i:a])
        out.append("•••")
        i = b
    out.append(s[i:])
    return "".join(out)


# --------------------------------------------------------------------------- stills


def render_stills(plan_path: str, screen: str, asset_dir: str | None) -> tuple[dict, list[np.ndarray]]:
    plan = json.loads(Path(plan_path).read_text())
    frames: list[np.ndarray] = []
    render(plan_path, screen, str(Path(plan_path).with_suffix(".unused.mp4")), None,
           RenderOptions(frame_sink=lambda i, fr: frames.append(fr.copy()), audio=False, asset_dir=asset_dir))
    return plan, frames


def _jpeg(img: np.ndarray, q: int) -> bytes:
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, int(q), cv2.IMWRITE_JPEG_OPTIMIZE, 1])
    assert ok
    return buf.tobytes()


def _png(img: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".png", img)
    assert ok
    return buf.tobytes()


def _data_uri(mime: str, b: bytes) -> str:
    return f"data:{mime};base64,{base64.b64encode(b).decode()}"


def _hex(c: str) -> tuple[int, int, int]:
    c = c.lstrip("#")
    return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)


def _font_face(manifest: dict, asset_dir: str | None) -> str:
    ff = manifest["brand"].get("fontFiles")
    if not ff:
        return ""
    out = []
    for weight, ref in (("400", ff["regular"]), ("700", ff["bold"])):
        p = ann.resolve_asset(ref, asset_dir)
        if p.exists() and p.stat().st_size < 3_000_000:
            mime = "font/otf" if p.suffix.lower() == ".otf" else "font/ttf"
            out.append(f"@font-face{{font-family:'LensBrand';font-weight:{weight};font-style:normal;"
                       f"src:url({_data_uri(mime, p.read_bytes())});}}")
    return "\n".join(out)


def _logo_uri(manifest: dict, asset_dir: str | None) -> str | None:
    lg = manifest["brand"].get("logo")
    if not lg:
        return None
    p = Path(lg["path"])
    p = p if p.is_absolute() else Path(asset_dir or ".") / p
    if not p.exists():
        return None
    ext = p.suffix.lower()
    mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}.get(ext)
    if not mime:  # svg etc. are not inlined (scripts inside svg)
        return None
    return _data_uri(mime, p.read_bytes())


# --------------------------------------------------------------------------- demo


def build_demo(manifest: dict, plan: dict, frames: list[np.ndarray], out: Path, asset_dir: str | None) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    (out / "images").mkdir(exist_ok=True)
    H0, W0 = frames[0].shape[:2]
    s = min(1.0, manifest["still"]["maxWidth"] / W0)
    W, H = int(round(W0 * s)), int(round(H0 * s))
    q = manifest["still"]["quality"]
    steps_out = []
    for st in manifest["steps"]:
        f = plan["frames"][st["frame"]]
        A = frame_affine(plan, f)
        img = frames[st["frame"]]
        if s < 1:
            img = cv2.resize(img, (W, H), interpolation=cv2.INTER_AREA)
        As = A.scaled(s) if s < 1 else A
        hx, hy = As.map(st["x"], st["y"])
        inside = 0 <= hx <= W - 1 and 0 <= hy <= H - 1
        hx, hy = min(max(hx, 0.0), W - 1.0), min(max(hy, 0.0), H - 1.0)
        jpg = _jpeg(img, q)
        name = f"images/step-{st['n']:02d}.jpg"
        (out / name).write_bytes(jpg)
        steps_out.append({
            "n": st["n"], "stepId": st["stepId"], "label": redact_text(st["label"]), "clickMs": st["clickMs"], "stillMs": st["stillMs"],
            "image": name, "width": W, "height": H,
            "hotspot": {"x": round(hx, 2), "y": round(hy, 2), "fx": round(hx / W, 6), "fy": round(hy / H, 6), "insideImage": inside},
            "source": {"x": st["x"], "y": st["y"]}, "map": As.as_list(),
            "_uri": _data_uri("image/jpeg", jpg),
        })
    cta = dict(manifest["cta"])
    cta["title"], cta["text"] = redact_text(cta["title"]), redact_text(cta["text"])
    data = {
        "version": 1, "title": redact_text(manifest["title"]), "description": redact_text(manifest.get("description", "")),
        "cta": cta, "brand": {k: manifest["brand"][k] for k in ("name", "primary", "accent", "background", "text", "font")},
        "image": {"width": W, "height": H},
        "steps": [{k: v for k, v in x.items() if k != "_uri"} for x in steps_out],
    }
    page = demo_html(data, [x["_uri"] for x in steps_out], _font_face(manifest, asset_dir), _logo_uri(manifest, asset_dir))
    (out / "index.html").write_text(page, encoding="utf-8")
    (out / "demo.json").write_text(json.dumps(data, indent=1))
    return data


def _json_for_script(obj) -> str:
    # safe inside <script type="application/json">: no "</" sequence, no U+2028/9 surprises
    return json.dumps(obj, ensure_ascii=False).replace("</", "<\\/").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def _bg_css(bg: dict) -> str:
    cols = bg.get("colors") or ["#111111"]
    if bg.get("kind") == "solid" or len(cols) == 1:
        return cols[0]
    return f"linear-gradient({bg.get('angle', 135)}deg, {', '.join(cols)})"


DEMO_CSS = r"""
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{font-family:%FONT%;background:%BG%;color:%TEXT%;display:flex;flex-direction:column;min-height:100vh;-webkit-font-smoothing:antialiased}
.ld-top{display:flex;align-items:center;gap:12px;padding:10px clamp(10px,3vw,28px);min-height:52px}
.ld-top img{height:28px;width:auto}
.ld-title{font-weight:700;font-size:clamp(14px,2.2vw,18px);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ld-count{font-variant-numeric:tabular-nums;font-size:13px;opacity:.85;white-space:nowrap}
.ld-progress{height:4px;background:color-mix(in srgb,%TEXT% 18%,transparent);margin:0 clamp(10px,3vw,28px);border-radius:2px;overflow:hidden}
.ld-progress>i{display:block;height:100%;width:0;background:%PRIMARY%;transition:width .35s ease}
.ld-main{flex:1;display:flex;align-items:center;justify-content:center;padding:clamp(8px,2.5vw,28px);min-height:0}
.ld-stage{position:relative;width:min(100%, calc((100vh - 140px) * %ASPECT%));aspect-ratio:%ASPECT%;border-radius:12px;overflow:visible;box-shadow:0 18px 50px rgba(0,0,0,.35)}
.ld-stage>img{position:absolute;inset:0;width:100%;height:100%;display:block;border-radius:12px;user-select:none;-webkit-user-drag:none}
.ld-hot{--hs:clamp(20px,2.6vw,32px);position:absolute;width:var(--hs);height:var(--hs);transform:translate(-50%,-50%);border-radius:50%;border:3px solid %PRIMARY%;padding:0;cursor:pointer;background:color-mix(in srgb,%PRIMARY% 28%,transparent);box-shadow:0 0 0 2px #fff,0 2px 10px rgba(0,0,0,.45);z-index:2}
.ld-hot::before,.ld-hot::after{content:"";position:absolute;inset:-3px;border-radius:50%;border:3px solid %PRIMARY%;animation:ld-pulse 1.8s ease-out infinite;pointer-events:none}
.ld-hot::after{animation-delay:.9s}
.ld-hot:focus-visible{outline:3px solid %ACCENT%;outline-offset:6px}
@keyframes ld-pulse{0%{transform:scale(1);opacity:.85}100%{transform:scale(2.6);opacity:0}}
@media (prefers-reduced-motion:reduce){.ld-hot::before,.ld-hot::after{animation:none;opacity:.5;transform:scale(1.6)}.ld-progress>i{transition:none}}
.ld-tip{position:absolute;z-index:3;width:max-content;max-width:min(320px,70%);background:#fff;color:#16181d;border-radius:10px;padding:12px 14px 10px;box-shadow:0 10px 30px rgba(0,0,0,.35);font-size:15px;line-height:1.35}
.ld-tip::before{content:"";position:absolute;width:12px;height:12px;background:#fff;transform:rotate(45deg)}
.ld-tip[data-side=right]::before{left:-6px;top:var(--ay,18px)}
.ld-tip[data-side=left]::before{right:-6px;top:var(--ay,18px)}
.ld-tip[data-side=below]::before{top:-6px;left:var(--ax,18px)}
.ld-tip[data-side=above]::before{bottom:-6px;left:var(--ax,18px)}
.ld-tip .ld-step{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:%PRIMARY%;margin-bottom:4px}
.ld-tip .ld-label{font-weight:700;margin:0 0 10px;word-wrap:break-word}
.ld-tip .ld-desc{margin:-4px 0 10px;font-size:13px;color:#4a4f5a}
.ld-nav{display:flex;gap:8px;justify-content:flex-end}
.ld-btn{font:inherit;font-size:13px;font-weight:600;border-radius:7px;padding:6px 12px;cursor:pointer;border:1px solid #d5d8de;background:#fff;color:#16181d}
.ld-btn.pri{background:%PRIMARY%;border-color:%PRIMARY%;color:%ONPRIMARY%}
.ld-btn[disabled]{opacity:.4;cursor:default}
.ld-cta{position:absolute;inset:0;border-radius:12px;display:none;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:14px;padding:6%;background:color-mix(in srgb,%BG0% 84%,transparent);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);color:%TEXT%;z-index:4}
.ld-cta.on{display:flex}
.ld-cta img{max-height:56px;max-width:40%}
.ld-cta h2{margin:0;font-size:clamp(20px,4vw,40px)}
.ld-cta p{margin:0;max-width:40em;font-size:clamp(14px,1.8vw,18px);opacity:.9}
.ld-cta .ld-row{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
.ld-cta a.ld-btn{text-decoration:none;font-size:16px;padding:10px 20px}
.ld-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media (max-width:640px){
 .ld-stage{width:100%}
 .ld-main{align-items:flex-start;padding-top:16px}
 .ld-tip{position:fixed;left:8px!important;right:8px;top:auto!important;bottom:8px;max-width:none;width:auto}
 .ld-tip::before{display:none}
}
"""

DEMO_JS = r"""
(function(){
"use strict";
var D=JSON.parse(document.getElementById("lens-demo-data").textContent);
var IM=JSON.parse(document.getElementById("lens-demo-images").textContent);
var N=D.steps.length,i=0;
var $=function(id){return document.getElementById(id)};
var stage=$("ld-stage"),img=$("ld-img"),hot=$("ld-hot"),tip=$("ld-tip"),cta=$("ld-cta"),bar=$("ld-bar"),cnt=$("ld-count"),live=$("ld-live");
var back=$("ld-back"),next=$("ld-next");
function place(){
  if(i>=N)return;
  var s=D.steps[i],r=stage.getBoundingClientRect();
  var x=s.hotspot.fx*r.width,y=s.hotspot.fy*r.height;
  hot.style.left=(s.hotspot.fx*100)+"%";hot.style.top=(s.hotspot.fy*100)+"%";
  if(window.matchMedia("(max-width:640px)").matches){tip.removeAttribute("data-side");return;}
  var tw=tip.offsetWidth,th=tip.offsetHeight,g=28,side,L,T;
  if(x+g+tw<=r.width){side="right";L=x+g;T=y-22;}
  else if(x-g-tw>=0){side="left";L=x-g-tw;T=y-22;}
  else if(y+g+th<=r.height){side="below";L=x-tw/2;T=y+g;}
  else {side="above";L=x-tw/2;T=y-g-th;}
  L=Math.max(4,Math.min(L,r.width-tw-4));T=Math.max(4,Math.min(T,r.height-th-4));
  tip.setAttribute("data-side",side);tip.style.left=L+"px";tip.style.top=T+"px";
  tip.style.setProperty("--ay",Math.max(10,Math.min(th-22,y-T-6))+"px");
  tip.style.setProperty("--ax",Math.max(10,Math.min(tw-22,x-L-6))+"px");
}
function show(k,focus){
  i=Math.max(0,Math.min(N,k));
  var done=i>=N;
  bar.style.width=(100*Math.min(i+1,N+1)/(N+1))+"%";
  bar.parentNode.setAttribute("aria-valuenow",String(Math.min(i+1,N+1)));
  cta.classList.toggle("on",done);
  hot.hidden=done;tip.hidden=done;
  cnt.textContent=done?"Done":("Step "+(i+1)+" of "+N);
  if(done){live.textContent=D.cta.title||"Done";if(focus){var a=cta.querySelector("a,button");if(a)a.focus();}}
  else{
    var s=D.steps[i];
    img.src=IM[i];img.alt="Step "+(i+1)+": "+s.label;
    $("ld-stepno").textContent="Step "+(i+1)+" of "+N;
    $("ld-label").textContent=s.label;
    $("ld-desc").hidden=!(i===0&&D.description);$("ld-desc").textContent=D.description||"";
    hot.setAttribute("aria-label","Step "+(i+1)+" of "+N+": "+s.label+" (go to next step)");
    back.disabled=i===0;next.textContent=i===N-1?"Finish":"Next";
    live.textContent="Step "+(i+1)+" of "+N+": "+s.label;
    place();
    if(focus)hot.focus({preventScroll:true});
  }
  if(location.hash!=="#"+(done?"end":"step-"+(i+1)))history.replaceState(null,"",done?"#end":"#step-"+(i+1));
  if(window.parent!==window)try{window.parent.postMessage({type:"lens-demo:step",index:i,total:N},"*")}catch(e){}
}
hot.addEventListener("click",function(){show(i+1,true)});
next.addEventListener("click",function(){show(i+1,true)});
back.addEventListener("click",function(){show(i-1,true)});
$("ld-restart").addEventListener("click",function(){show(0,true)});
document.addEventListener("keydown",function(e){
  if(e.altKey||e.ctrlKey||e.metaKey)return;
  var k=e.key;
  if(k==="ArrowRight"||k==="PageDown"||(k===" "&&e.target===document.body)){e.preventDefault();show(i+1,true);}
  else if(k==="ArrowLeft"||k==="PageUp"){e.preventDefault();show(i-1,true);}
  else if(k==="Home"){e.preventDefault();show(0,true);}
  else if(k==="End"){e.preventDefault();show(N,true);}
});
window.addEventListener("resize",place);
if(window.ResizeObserver)new ResizeObserver(place).observe(stage);
// editor preview: the hotspot editor moves hotspots / edits tooltips live (only with #lens-preview)
if(/lens-preview/.test(location.hash)&&window.parent!==window){
  window.addEventListener("message",function(e){
    var m=e.data||{};
    if(m.type==="lens-demo:set"&&Array.isArray(m.steps)){
      m.steps.forEach(function(u,k){var s=D.steps[k];if(!s||!u)return;
        if(typeof u.fx==="number"&&typeof u.fy==="number"){s.hotspot.fx=Math.max(0,Math.min(1,u.fx));s.hotspot.fy=Math.max(0,Math.min(1,u.fy));}
        if(typeof u.label==="string")s.label=u.label;});
      show(i,false);
    } else if(m.type==="lens-demo:go"&&typeof m.index==="number"){show(m.index,false);}
  });
}
var h=/^#step-(\d+)/.exec(location.hash);
show(h?Number(h[1])-1:(location.hash==="#end"?N:0),false);
})();
"""


def demo_html(data: dict, uris: list[str], font_face: str, logo: str | None) -> str:
    b = data["brand"]
    pr = _hex(b["primary"])
    on_primary = "#ffffff" if (0.299 * pr[0] + 0.587 * pr[1] + 0.114 * pr[2]) < 160 else "#111111"
    font = ("'LensBrand', " if font_face else "") + "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    W, H = data["image"]["width"], data["image"]["height"]
    css = (DEMO_CSS.replace("%FONT%", font).replace("%BG%", _bg_css(b["background"])).replace("%TEXT%", b["text"])
           .replace("%PRIMARY%", b["primary"]).replace("%ACCENT%", b["accent"]).replace("%ONPRIMARY%", on_primary)
           .replace("%ASPECT%", f"{W} / {H}").replace("%BG0%", (b["background"].get("colors") or ["#111111"])[0]))
    e = html.escape
    cta = data["cta"]
    url = cta.get("url") or ""
    safe_url = url if re.match(r"^(https?://|mailto:)[^\s\"'<>`]+$", url, re.I) else ""
    logo_tag = f'<img src="{logo}" alt="{e(b["name"] or "logo")}">' if logo else ""
    n = len(data["steps"])
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<meta name="generator" content="Lens steps export">
<title>{e(data["title"])}</title>
<style>{font_face}
{css}</style>
</head>
<body>
<header class="ld-top">{logo_tag}<div class="ld-title">{e(data["title"])}</div><div class="ld-count" id="ld-count"></div></header>
<div class="ld-progress" role="progressbar" aria-label="Progress" aria-valuemin="1" aria-valuemax="{n + 1}" aria-valuenow="1"><i id="ld-bar"></i></div>
<main class="ld-main">
 <div class="ld-stage" id="ld-stage" data-testid="stage">
  <img id="ld-img" alt="" draggable="false" width="{W}" height="{H}">
  <button class="ld-hot" id="ld-hot" type="button" data-testid="hotspot"></button>
  <div class="ld-tip" id="ld-tip" role="dialog" aria-labelledby="ld-label" data-testid="tooltip">
   <span class="ld-step" id="ld-stepno"></span>
   <p class="ld-label" id="ld-label"></p>
   <p class="ld-desc" id="ld-desc" hidden></p>
   <div class="ld-nav"><button class="ld-btn" id="ld-back" type="button">Back</button><button class="ld-btn pri" id="ld-next" type="button">Next</button></div>
  </div>
  <section class="ld-cta" id="ld-cta" data-testid="cta" aria-label="{e(cta.get("title") or "Done")}">
   {logo_tag}
   <h2>{e(cta.get("title") or "")}</h2>
   {f'<p>{e(cta["text"])}</p>' if cta.get("text") else ""}
   <div class="ld-row">{f'<a class="ld-btn pri" data-testid="cta-link" href="{e(safe_url)}" target="_blank" rel="noopener noreferrer">{e(cta.get("buttonLabel") or "Open")}</a>' if (safe_url and cta.get("enabled", True)) else ""}<button class="ld-btn" id="ld-restart" type="button">Restart</button></div>
  </section>
 </div>
</main>
<div class="ld-sr" aria-live="polite" id="ld-live"></div>
<script type="application/json" id="lens-demo-data">{_json_for_script(data)}</script>
<script type="application/json" id="lens-demo-images">{_json_for_script(uris)}</script>
<script>{DEMO_JS}</script>
</body>
</html>
"""


# --------------------------------------------------------------------------- guide

DEFAULT_BOX = (120.0, 44.0)  # source px, when the step labeller found no control box


def guide_images(manifest: dict, plan: dict, frames: list[np.ndarray]) -> list[dict]:
    """Per step: the full-resolution still cropped around the click (guide.zoom times closer than
    the whole frame), with a highlight box drawn around the clicked control in the primary colour."""
    zoom = float(manifest["guide"]["zoom"])
    pad = float(manifest["guide"]["boxPadding"])
    col = _hex(manifest["brand"]["primary"])
    out = []
    for st in manifest["steps"]:
        f = plan["frames"][st["frame"]]
        A = frame_affine(plan, f)
        img = frames[st["frame"]]
        H0, W0 = img.shape[:2]
        cw, ch = int(round(W0 / zoom)), int(round(H0 / zoom))
        hx, hy = A.map(st["x"], st["y"])
        x0 = int(round(min(max(hx - cw / 2, 0), W0 - cw)))
        y0 = int(round(min(max(hy - ch / 2, 0), H0 - ch)))
        crop = np.ascontiguousarray(img[y0:y0 + ch, x0:x0 + cw])
        Ac = A.shifted(x0, y0)
        if st.get("box"):
            bx, by, bw, bh = st["box"]["x"], st["box"]["y"], st["box"]["w"], st["box"]["h"]
            # a box from the labeller is for the click point; follow the hotspot if it was moved
            bx += st["x"] - st["clickX"]
            by += st["y"] - st["clickY"]
        else:
            bw, bh = DEFAULT_BOX
            bx, by = st["x"] - bw / 2, st["y"] - bh / 2
        p0 = Ac.map(bx - pad, by - pad)
        p1 = Ac.map(bx + bw + pad, by + bh + pad)
        sw = max(3, int(round(min(cw, ch) / 180)))
        rect = [min(max(p0[0], 0), cw - 1), min(max(p0[1], 0), ch - 1), min(max(p1[0], 0), cw - 1), min(max(p1[1], 0), ch - 1)]
        pil = Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
        d = ImageDraw.Draw(pil)
        rad = max(4, sw * 2)
        # white halo so the box reads on any background, then the box itself
        d.rounded_rectangle([rect[0] - sw, rect[1] - sw, rect[2] + sw, rect[3] + sw], radius=rad + sw, outline=(255, 255, 255), width=max(1, sw // 2 + 1))
        d.rounded_rectangle(rect, radius=rad, outline=col, width=sw)
        rgb = np.asarray(pil)
        out.append({"n": st["n"], "label": redact_text(st["label"]), "rgb": rgb, "box": [round(v, 2) for v in rect], "stroke": sw,
                    "crop": [x0, y0, cw, ch], "map": Ac.as_list()})
    return out


def build_guide(manifest: dict, plan: dict, frames: list[np.ndarray], out: Path, asset_dir: str | None) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    (out / "images").mkdir(exist_ok=True)
    imgs = guide_images(manifest, plan, frames)
    title = redact_text(manifest["title"])
    desc = redact_text(manifest.get("description", ""))
    cta = manifest["cta"]
    n = len(imgs)
    files = []
    for g in imgs:
        name = f"images/guide-{g['n']:02d}.png"
        (out / name).write_bytes(_png(cv2.cvtColor(g["rgb"], cv2.COLOR_RGB2BGR)))
        files.append(name)
    # Markdown
    md = [f"# {title}", ""]
    if desc:
        md += [desc, ""]
    md += [f"{n} step{'s' if n != 1 else ''}.", ""]
    for g, name in zip(imgs, files):
        md += [f"## Step {g['n']} of {n}: {_md_escape(g['label'])}", "", f"![Step {g['n']}: {_md_alt(g['label'])}]({name})", ""]
    cta_url = cta.get("url") or ""
    if cta.get("enabled", True) and (cta.get("title") or cta_url):
        line = f"**{_md_escape(redact_text(cta.get('title') or ''))}**"
        if cta.get("text"):
            line += " " + _md_escape(redact_text(cta["text"]))
        if cta_url:
            line += f" [{_md_escape(cta.get('buttonLabel') or cta_url)}]({cta_url})"
        md += ["---", "", line, ""]
    (out / "guide.md").write_text("\n".join(md), encoding="utf-8")
    # HTML
    (out / "guide.html").write_text(guide_html(manifest, title, desc, imgs, _font_face(manifest, asset_dir), _logo_uri(manifest, asset_dir)), encoding="utf-8")
    # PDF
    pages = write_pdf(out / "guide.pdf", manifest, title, desc, imgs)
    info = {"steps": [{"n": g["n"], "label": g["label"], "image": name, "box": g["box"], "stroke": g["stroke"], "crop": g["crop"], "map": g["map"],
                       "width": int(g["rgb"].shape[1]), "height": int(g["rgb"].shape[0])} for g, name in zip(imgs, files)],
            "pdfPages": pages, "title": title}
    (out / "guide.json").write_text(json.dumps(info, indent=1))
    return info


def _md_escape(s: str) -> str:
    return re.sub(r"([\\`*_\[\]<>#|])", r"\\\1", s)


def _md_alt(s: str) -> str:
    return re.sub(r"[\[\]\n]", " ", s)


def guide_html(manifest: dict, title: str, desc: str, imgs: list[dict], font_face: str, logo: str | None) -> str:
    e = html.escape
    b = manifest["brand"]
    font = ("'LensBrand', " if font_face else "") + "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    steps = []
    for g in imgs:
        ok, buf = cv2.imencode(".png", cv2.cvtColor(g["rgb"], cv2.COLOR_RGB2BGR))
        steps.append(f"""<li class="lg-step"><h2><span class="lg-n">{g['n']}</span>{e(g['label'])}</h2>
<img src="{_data_uri('image/png', buf.tobytes())}" alt="Step {g['n']}: {e(g['label'])}" width="{g['rgb'].shape[1]}" height="{g['rgb'].shape[0]}"></li>""")
    cta = manifest["cta"]
    url = cta.get("url") or ""
    safe_url = url if re.match(r"^(https?://|mailto:)[^\s\"'<>`]+$", url, re.I) else ""
    cta_html = ""
    if cta.get("enabled", True) and (cta.get("title") or safe_url):
        cta_html = (f'<footer class="lg-cta"><strong>{e(redact_text(cta.get("title") or ""))}</strong> {e(redact_text(cta.get("text") or ""))} '
                    + (f'<a href="{e(safe_url)}" rel="noopener noreferrer">{e(cta.get("buttonLabel") or safe_url)}</a>' if safe_url else "") + "</footer>")
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'">
<title>{e(title)}</title>
<style>{font_face}
*{{box-sizing:border-box}} body{{margin:0;font-family:{font};color:#16181d;background:#f5f6f8;line-height:1.45}}
.lg-head{{background:{_bg_css(b['background'])};color:{b['text']};padding:28px clamp(16px,5vw,56px)}}
.lg-head img{{height:36px;display:block;margin-bottom:12px}} .lg-head h1{{margin:0;font-size:clamp(22px,4vw,34px)}} .lg-head p{{margin:8px 0 0;opacity:.9}}
ol{{list-style:none;margin:0 auto;padding:24px clamp(12px,4vw,40px);max-width:1040px}}
.lg-step{{background:#fff;border-radius:12px;padding:18px;margin:0 0 22px;box-shadow:0 2px 10px rgba(0,0,0,.08);break-inside:avoid;page-break-inside:avoid}}
.lg-step h2{{font-size:18px;margin:0 0 12px;display:flex;align-items:center;gap:10px}}
.lg-n{{flex:none;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;background:{b['primary']};color:#fff;font-size:15px}}
.lg-step img{{width:100%;height:auto;border-radius:8px;display:block;border:1px solid #e3e5e9}}
.lg-cta{{max-width:1040px;margin:0 auto 40px;padding:0 clamp(12px,4vw,40px)}} .lg-cta a{{color:{b['primary']}}}
@media print{{body{{background:#fff}} .lg-step{{box-shadow:none;border:1px solid #ddd;page-break-after:always}}}}
</style></head><body>
<header class="lg-head">{f'<img src="{logo}" alt="">' if logo else ""}<h1>{e(title)}</h1>{f"<p>{e(desc)}</p>" if desc else ""}<p>{len(imgs)} step{"s" if len(imgs) != 1 else ""}</p></header>
<ol>
{chr(10).join(steps)}
</ol>
{cta_html}
</body></html>
"""


# --------------------------------------------------------------------------- PDF (hand-written, no library)

A4 = (595.28, 841.89)
# Helvetica advance widths (per 1000 em) for ASCII 32..126, from the standard Type 1 font metrics
# (Adobe's Core14 AFM tables; font metrics are not copyrightable data). Used only to wrap text.
_HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
         278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667,
         611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833,
         556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584]


def _w(s: str, size: float, bold: bool = False) -> float:
    k = 1.07 if bold else 1.0  # Helvetica-Bold is ~7% wider on average; wrapping only
    return sum((_HELV[ord(c) - 32] if 32 <= ord(c) <= 126 else 600) for c in s) * size / 1000 * k


def _wrap(s: str, size: float, width: float, bold: bool = False) -> list[str]:
    lines, cur = [], ""
    for word in s.split():
        t = (cur + " " + word).strip()
        if _w(t, size, bold) <= width or not cur:
            cur = t
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines or [""]


def _pdf_str(s: str) -> str:
    # WinAnsi text string: characters outside it become "?"; escape (, ), backslash
    b = s.replace("•", "*").encode("cp1252", errors="replace").decode("cp1252")
    return "(" + b.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") + ")"


def _rgb(c: tuple[int, int, int]) -> str:
    return " ".join(f"{v / 255:.4f}" for v in c)


def write_pdf(path: Path, manifest: dict, title: str, desc: str, imgs: list[dict]) -> int:
    """A4 portrait: page 1 = title, description, step list (and the call to action); then one page
    per step: 'Step n of N', the label, the screenshot (FlateDecode RGB, lossless). Fonts:
    Helvetica / Helvetica-Bold (standard 14, not embedded). Returns the page count."""
    PW, PH = A4
    M = 48.0
    prim = _hex(manifest["brand"]["primary"])
    dark = (22, 24, 29)
    grey = (90, 96, 108)
    objs: list[bytes] = []

    def add(b: bytes) -> int:
        objs.append(b)
        return len(objs)

    f1 = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    f2 = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")
    pages_id = add(b"")  # placeholder, filled at the end
    page_ids: list[int] = []

    def text(x, y, s, size, bold=False, color=dark):
        return f"BT /{'F2' if bold else 'F1'} {size:.1f} Tf {_rgb(color)} rg {x:.2f} {y:.2f} Td {_pdf_str(s)} Tj ET\n"

    def page(content: str, xobjs: dict[str, int]):
        cid = add(b"<< /Length %d >>\nstream\n" % len(content.encode("latin-1")) + content.encode("latin-1") + b"\nendstream")
        xo = " ".join(f"/{k} {v} 0 R" for k, v in xobjs.items())
        pid = add((f"<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 {PW:.2f} {PH:.2f}] "
                   f"/Resources << /Font << /F1 {f1} 0 R /F2 {f2} 0 R >> /XObject << {xo} >> >> /Contents {cid} 0 R >>").encode())
        page_ids.append(pid)

    n = len(imgs)
    # cover
    c = f"{_rgb(prim)} rg 0 {PH - 14:.2f} {PW:.2f} 14 re f\n"
    y = PH - 110
    for ln in _wrap(title, 28, PW - 2 * M, True):
        c += text(M, y, ln, 28, True)
        y -= 34
    if desc:
        y -= 4
        for ln in _wrap(desc, 13, PW - 2 * M):
            c += text(M, y, ln, 13, color=grey)
            y -= 18
    y -= 14
    c += text(M, y, f"{n} step{'s' if n != 1 else ''}", 13, True, prim)
    y -= 26
    for g in imgs:
        if y < M + 60:
            c += text(M, y, "...", 12, color=grey)
            break
        lab = _wrap(g["label"], 12, PW - 2 * M - 28)[0]
        c += text(M, y, f"{g['n']}.", 12, True, prim) + text(M + 28, y, lab, 12)
        y -= 18
    cta = manifest["cta"]
    if cta.get("enabled", True) and (cta.get("title") or cta.get("url")):
        cy = M + 20
        line = redact_text(cta.get("title") or "")
        if cta.get("url"):
            line = (line + "  " if line else "") + cta["url"]
        c += text(M, cy, _wrap(line, 11, PW - 2 * M)[0], 11, False, grey)
    page(c, {})
    # one page per step
    for g in imgs:
        h, w = g["rgb"].shape[:2]
        data = zlib.compress(np.ascontiguousarray(g["rgb"]).tobytes(), 6)
        im = add(f"<< /Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length {len(data)} >>\nstream\n".encode()
                 + data + b"\nendstream")
        c = f"{_rgb(prim)} rg 0 {PH - 14:.2f} {PW:.2f} 14 re f\n"
        c += text(M, PH - 58, f"Step {g['n']} of {n}", 11, True, prim)
        y = PH - 84
        for ln in _wrap(g["label"], 20, PW - 2 * M, True)[:4]:
            c += text(M, y, ln, 20, True)
            y -= 25
        y -= 8
        iw = PW - 2 * M
        ih = iw * h / w
        maxh = y - M
        if ih > maxh:
            ih = maxh
            iw = ih * w / h
        c += f"q {iw:.2f} 0 0 {ih:.2f} {M:.2f} {y - ih:.2f} cm /Im{g['n']} Do Q\n"
        c += text(M, M - 24, title[:90], 9, False, grey)
        page(c, {f"Im{g['n']}": im})
    kids = " ".join(f"{p} 0 R" for p in page_ids)
    objs[pages_id - 1] = f"<< /Type /Pages /Kids [{kids}] /Count {len(page_ids)} >>".encode()
    cat = add(f"<< /Type /Catalog /Pages {pages_id} 0 R >>".encode())
    info = add(b"<< /Producer (Lens steps export) /Title " + _pdf_str(title).encode("latin-1", errors="replace") + b" >>")
    buf = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offs = []
    for i, o in enumerate(objs, 1):
        offs.append(len(buf))
        buf += f"{i} 0 obj\n".encode() + o + b"\nendobj\n"
    xref = len(buf)
    buf += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for o in offs:
        buf += f"{o:010d} 00000 n \n".encode()
    buf += f"trailer\n<< /Size {len(objs) + 1} /Root {cat} 0 R /Info {info} 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    path.write_bytes(bytes(buf))
    return len(page_ids)


# --------------------------------------------------------------------------- entry


def export_steps(manifest_path: str, plan_path: str, screen: str, out_dir: str, kinds: list[str], asset_dir: str | None = None) -> dict:
    manifest = json.loads(Path(manifest_path).read_text())
    if not manifest.get("steps"):
        raise ValueError("no steps to export")
    plan, frames = render_stills(plan_path, screen, asset_dir)
    out = Path(out_dir)
    res: dict = {"out": str(out), "steps": len(manifest["steps"])}
    if "demo" in kinds:
        d = build_demo(manifest, plan, frames, out, asset_dir)
        res["demo"] = {"index": str(out / "index.html"), "bytes": (out / "index.html").stat().st_size, "image": d["image"],
                       "outsideImage": [s["n"] for s in d["steps"] if not s["hotspot"]["insideImage"]]}
    if "guide" in kinds:
        g = build_guide(manifest, plan, frames, out, asset_dir)
        res["guide"] = {"markdown": str(out / "guide.md"), "html": str(out / "guide.html"), "pdf": str(out / "guide.pdf"), "pages": g["pdfPages"]}
    return res
