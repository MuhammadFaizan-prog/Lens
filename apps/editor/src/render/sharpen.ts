/**
 * Sharper text in zooms (demand #22): a WebGL2 pass used by the preview and the export worker alike
 * (no Python, no server). When the camera is zoomed in past 1.5x, the screen is resampled from the
 * source frame with a Lanczos-3 filter instead of the canvas's bilinear upscale, then an unsharp mask
 * restores edge contrast. Both steps are edge-aware so they cannot ring:
 *  - the Lanczos result is clamped to the range of the 2 x 2 source pixels around each sample
 *    (Lanczos' own overshoot next to hard edges never leaves the data);
 *  - the unsharp result is clamped to the 3 x 3 neighbourhood range of the resampled image (it can
 *    steepen an edge, never paint a halo beside it).
 * The amount ramps in with the zoom (0 at 1.5x, full at 1.75x), so nothing pops at the threshold.
 * While the camera moves fast enough for motion blur, the blurred screen is only unsharp-masked.
 */

export const SHARPEN_MIN_SCALE = 1.5;
export const SHARPEN_FULL_SCALE = 1.75;

/** Effective amount at a zoom scale (smoothstep ramp from 1.5x to 1.75x). */
export function sharpenAmountAt(amount: number, scale: number): number {
  const u = Math.min(1, Math.max(0, (scale - SHARPEN_MIN_SCALE) / (SHARPEN_FULL_SCALE - SHARPEN_MIN_SCALE)));
  return amount * u * u * (3 - 2 * u);
}

/** Lanczos-3 kernel. */
export function lanczos3(x: number): number {
  const a = Math.abs(x);
  if (a < 1e-6) return 1;
  if (a >= 3) return 0;
  const px = Math.PI * x;
  return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
}

const VS = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

// Pass 1: Lanczos-3 resample of the source region into the view (sw x sh), anti-ringing clamp.
// Output pixel (j, i) (top-left origin) samples source pixel-centre coordinate uOrig + (j + 0.5) / uK - 0.5.
const FS_LANCZOS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uOrig;   // source x/y (edge coords) of the view's top-left
uniform vec2 uK;      // view px per source px (x, y)
uniform vec2 uView;   // view size
out vec4 o;
float L(float x) {
  float a = abs(x);
  if (a < 1e-5) return 1.0;
  if (a >= 3.0) return 0.0;
  float p = 3.14159265358979 * x;
  return 3.0 * sin(p) * sin(p / 3.0) / (p * p);
}
void main() {
  ivec2 sz = textureSize(uSrc, 0);
  vec2 d = vec2(gl_FragCoord.x, uView.y - gl_FragCoord.y);   // top-left origin, pixel centre at +0.5
  vec2 s = uOrig + d / uK - 0.5;                            // source pixel-centre space
  vec2 f = floor(s);
  vec2 t = s - f;
  float wx[6]; float wy[6];
  float sx = 0.0; float sy = 0.0;
  for (int k = 0; k < 6; k++) { wx[k] = L(t.x - float(k - 2)); sx += wx[k]; wy[k] = L(t.y - float(k - 2)); sy += wy[k]; }
  vec3 acc = vec3(0.0);
  vec3 lo = vec3(1.0); vec3 hi = vec3(0.0);
  for (int j = 0; j < 6; j++) {
    int yy = clamp(int(f.y) + j - 2, 0, sz.y - 1);
    vec3 row = vec3(0.0);
    for (int k = 0; k < 6; k++) {
      int xx = clamp(int(f.x) + k - 2, 0, sz.x - 1);
      vec3 c = texelFetch(uSrc, ivec2(xx, yy), 0).rgb;
      row += c * wx[k];
      if ((j == 2 || j == 3) && (k == 2 || k == 3)) { lo = min(lo, c); hi = max(hi, c); }
    }
    acc += row * wy[j];
  }
  vec3 c = acc / (sx * sy);
  o = vec4(clamp(c, lo, hi), 1.0);
}`;

// Pass 2: unsharp mask (3x3 binomial blur) clamped to the 3x3 range: no halos.
const FS_UNSHARP = `#version 300 es
precision highp float;
uniform sampler2D uImg;
uniform float uAmount;
uniform int uFlip;     // 1 when uImg is a canvas upload (top row first), 0 for our own framebuffer
out vec4 o;
void main() {
  ivec2 sz = textureSize(uImg, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (uFlip == 1) p.y = sz.y - 1 - p.y;
  vec3 blur = vec3(0.0); vec3 lo = vec3(1.0); vec3 hi = vec3(0.0); vec3 c0 = vec3(0.0);
  for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
    vec3 c = texelFetch(uImg, clamp(p + ivec2(dx, dy), ivec2(0), sz - 1), 0).rgb;
    float w = (dx == 0 ? 2.0 : 1.0) * (dy == 0 ? 2.0 : 1.0);
    blur += c * w;
    lo = min(lo, c); hi = max(hi, c);
    if (dx == 0 && dy == 0) c0 = c;
  }
  blur /= 16.0;
  vec3 c = c0 + uAmount * (c0 - blur);
  o = vec4(clamp(c, lo, hi), 1.0);
}`;

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

export class SharpenPass {
  private canvas: AnyCanvas;
  private gl: WebGL2RenderingContext;
  private progL: WebGLProgram;
  private progU: WebGLProgram;
  private src: WebGLTexture;
  private mid: WebGLTexture;
  private fbo: WebGLFramebuffer;
  private buf: WebGLBuffer;
  private lastSrc: unknown = null;
  private midSize = [0, 0];

  constructor() {
    this.canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(2, 2) : Object.assign(document.createElement("canvas"), { width: 2, height: 2 });
    const gl = (this.canvas as OffscreenCanvas).getContext("webgl2", { alpha: false, premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`sharpen shader: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const prog = (fs: string) => {
      const p = gl.createProgram()!;
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`sharpen link: ${gl.getProgramInfoLog(p)}`);
      return p;
    };
    this.progL = prog(FS_LANCZOS);
    this.progU = prog(FS_UNSHARP);
    const tex = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.src = tex();
    this.mid = tex();
    this.fbo = gl.createFramebuffer()!;
    this.buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  }

  private quad(p: WebGLProgram): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const a = gl.getAttribLocation(p, "aPos");
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private size(w: number, h: number): void {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private upload(img: TexImageSource | AnyCanvas, flipY: boolean): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipY);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img as TexImageSource);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  /**
   * Lanczos-3 resample of source rect (ax, ay, w, h) (edge coords, the same rect drawImage would use)
   * into sw x sh, then unsharp(amount). Returns the canvas holding the result (draw it at 0, 0).
   */
  resample(img: TexImageSource, ax: number, ay: number, w: number, h: number, sw: number, sh: number, amount: number): AnyCanvas {
    const gl = this.gl;
    this.size(sw, sh);
    if (img !== this.lastSrc) {
      this.upload(img, false);
      this.lastSrc = img;
    }
    // pass 1 into the mid texture (framebuffer rows: bottom first; pass 1 writes gl_FragCoord.y = sh - row)
    gl.bindTexture(gl.TEXTURE_2D, this.mid);
    if (this.midSize[0] !== sw || this.midSize[1] !== sh) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, sw, sh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this.midSize = [sw, sh];
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.mid, 0);
    gl.viewport(0, 0, sw, sh);
    gl.useProgram(this.progL);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.uniform1i(gl.getUniformLocation(this.progL, "uSrc"), 0);
    gl.uniform2f(gl.getUniformLocation(this.progL, "uOrig"), ax, ay);
    gl.uniform2f(gl.getUniformLocation(this.progL, "uK"), sw / w, sh / h);
    gl.uniform2f(gl.getUniformLocation(this.progL, "uView"), sw, sh);
    gl.disable(gl.BLEND);
    this.quad(this.progL);
    // pass 2 to the canvas
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, sw, sh);
    gl.useProgram(this.progU);
    gl.bindTexture(gl.TEXTURE_2D, this.mid);
    gl.uniform1i(gl.getUniformLocation(this.progU, "uImg"), 0);
    gl.uniform1f(gl.getUniformLocation(this.progU, "uAmount"), amount);
    gl.uniform1i(gl.getUniformLocation(this.progU, "uFlip"), 0);
    this.quad(this.progU);
    return this.canvas;
  }

  /** Unsharp mask only (motion-blurred view): img is the sw x sh view canvas. */
  unsharp(view: AnyCanvas, sw: number, sh: number, amount: number): AnyCanvas {
    const gl = this.gl;
    this.size(sw, sh);
    this.upload(view, false);
    this.lastSrc = null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, sw, sh);
    gl.useProgram(this.progU);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.uniform1i(gl.getUniformLocation(this.progU, "uImg"), 0);
    gl.uniform1f(gl.getUniformLocation(this.progU, "uAmount"), amount);
    gl.uniform1i(gl.getUniformLocation(this.progU, "uFlip"), 1);
    gl.disable(gl.BLEND);
    this.quad(this.progU);
    return this.canvas;
  }
}
