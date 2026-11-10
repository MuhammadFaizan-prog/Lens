/**
 * WebGL2 perspective pass for 3D motion (feat/motion-3d).
 *
 * Canvas2D only has affine transforms, so the 3D-transformed screen card is drawn here: the card
 * (screen through the camera + masks + clicks + screen annotations + cursor, rounded, at the
 * card's opacity) arrives as a canvas with a transparent border, is uploaded as a mipmapped
 * texture and drawn onto its projected quad. Every fragment maps back to the texture through the
 * inverse homography of the quad (exactly what compositor/lens_compositor/motion3d.py does with
 * cv2.warpPerspective), so the mapping is projectively correct; the transparent border gives
 * anti-aliased edges through bilinear filtering, mipmaps keep foreshortened areas from aliasing.
 *
 * The same code runs in the export worker (OffscreenCanvas WebGL2). No WebGL2: a thrown error with
 * a clear message, never a silent flat fallback.
 */
import { BACK_COLOR, project3d, type Motion3DFrame } from "@lens/engine";

/** Transparent border around the card texture, px. */
export const CARD_PAD = 2;

export type Mat3 = [number, number, number, number, number, number, number, number, number];

/**
 * Homography mapping the rectangle (0,0)-(w,h) onto quad TL, TR, BR, BL (8 numbers), row-major:
 * [x', y', s]^T = H [u, v, 1]^T. Closed form for square -> quad (Heckbert 1989), then scaled.
 */
export function homographyRectToQuad(w: number, h: number, q: ArrayLike<number>): Mat3 {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = [q[0]!, q[1]!, q[2]!, q[3]!, q[4]!, q[5]!, q[6]!, q[7]!];
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  let g = 0;
  let hh = 0;
  if (Math.abs(sx) > 1e-12 || Math.abs(sy) > 1e-12) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den;
    hh = (dx1 * sy - sx * dy1) / den;
  }
  // unit square (u, v) in [0,1]^2: TL(0,0) TR(1,0) BR(1,1) BL(0,1)
  const a = x1 - x0 + g * x1;
  const b = x3 - x0 + hh * x3;
  const c = x0;
  const d = y1 - y0 + g * y1;
  const e = y3 - y0 + hh * y3;
  const f = y0;
  // compose with diag(1/w, 1/h, 1)
  return [a / w, b / h, c, d / w, e / h, f, g / w, hh / h, 1];
}

export function invert3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-18) throw new Error("degenerate homography");
  const k = 1 / det;
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}

export function applyH(m: Mat3, x: number, y: number): [number, number] {
  const s = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / s, (m[3] * x + m[4] * y + m[5]) / s];
}

/** Projected quad (TL TR BR BL) of the padded card texture, relabelled like the plan's quad. */
export function paddedQuad(m: Motion3DFrame, sx: number, sy: number, sw: number, sh: number, pad = CARD_PAD): number[] {
  const x0 = sx - pad;
  const y0 = sy - pad;
  const x1 = sx + sw + pad;
  const y1 = sy + sh + pad;
  const p = [project3d(m, x0, y0), project3d(m, x1, y0), project3d(m, x1, y1), project3d(m, x0, y1)];
  let q = p.flat();
  if (m.mirrored === "x") q = [q[2]!, q[3]!, q[0]!, q[1]!, q[6]!, q[7]!, q[4]!, q[5]!];
  else if (m.mirrored === "y") q = [q[6]!, q[7]!, q[4]!, q[5]!, q[2]!, q[3]!, q[0]!, q[1]!];
  return q;
}

const VS = `#version 300 es
in vec2 aPos;
uniform vec2 uSize;
void main() {
  vec2 c = aPos / uSize * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform mat3 uInv;      // output px -> texture px
uniform vec2 uTexSize;
uniform float uH;
uniform int uBack;
uniform vec3 uBackColor;
out vec4 o;
void main() {
  vec2 p = vec2(gl_FragCoord.x, uH - gl_FragCoord.y);
  vec3 t = uInv * vec3(p, 1.0);
  vec2 uv = (t.xy / t.z) / uTexSize;
  vec4 c = texture(uTex, uv);
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) c = vec4(0.0);
  o = uBack == 1 ? vec4(uBackColor * c.a, c.a) : c;
}`;

function hexRgb01(h: string): [number, number, number] {
  const s = h.replace("#", "");
  return [parseInt(s.slice(0, 2), 16) / 255, parseInt(s.slice(2, 4), 16) / 255, parseInt(s.slice(4, 6), 16) / 255];
}

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

export class WebGL2Unavailable extends Error {
  constructor(detail: string) {
    super(`3D motion needs WebGL2, which is not available here (${detail}). Remove the 3D motion segments or use a browser / GPU with WebGL2.`);
    this.name = "WebGL2Unavailable";
  }
}

/** Is WebGL2 available in this context (window or worker)? */
export function hasWebGL2(): boolean {
  try {
    const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : document.createElement("canvas");
    return !!(c as OffscreenCanvas).getContext("webgl2");
  } catch {
    return false;
  }
}

export class Gl3dPass {
  private canvas: AnyCanvas;
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private tex: WebGLTexture;
  private buf: WebGLBuffer;
  private loc: Record<string, WebGLUniformLocation | null>;

  constructor() {
    this.canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(2, 2) : Object.assign(document.createElement("canvas"), { width: 2, height: 2 });
    const gl = (this.canvas as OffscreenCanvas).getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
    if (!gl) throw new WebGL2Unavailable("getContext('webgl2') returned null");
    this.gl = gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`gl3d shader: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`gl3d link: ${gl.getProgramInfoLog(p)}`);
    this.prog = p;
    this.loc = Object.fromEntries(["uSize", "uTex", "uInv", "uTexSize", "uH", "uBack", "uBackColor"].map((n) => [n, gl.getUniformLocation(p, n)]));
    this.buf = gl.createBuffer()!;
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /**
   * Draw the card texture (its content at (CARD_PAD, CARD_PAD), size sw x sh) onto its projected
   * quad in a W x H transparent canvas, returned for drawImage into the 2D pipeline.
   */
  render(card: AnyCanvas, m: Motion3DFrame, rect: [number, number, number, number], W: number, H: number): AnyCanvas {
    const gl = this.gl;
    const [sx, sy, sw, sh] = rect;
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    const tw = sw + 2 * CARD_PAD;
    const th = sh + 2 * CARD_PAD;
    const q = paddedQuad(m, sx, sy, sw, sh);
    const inv = invert3(homographyRectToQuad(tw, th, q));
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, card as TexImageSource);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.uniform1i(this.loc.uTex!, 0);
    gl.uniform2f(this.loc.uSize!, W, H);
    gl.uniform2f(this.loc.uTexSize!, card.width, card.height);
    gl.uniform1f(this.loc.uH!, H);
    // GLSL mat3 is column-major: pass the transpose
    gl.uniformMatrix3fv(this.loc.uInv!, true, new Float32Array(inv));
    gl.uniform1i(this.loc.uBack!, m.face === "back" ? 1 : 0);
    gl.uniform3fv(this.loc.uBackColor!, hexRgb01(BACK_COLOR));
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(q), gl.STREAM_DRAW);
    const a = gl.getAttribLocation(this.prog, "aPos");
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.BLEND);
    // a convex quad (TL TR BR BL) as a fan; drawn whichever way it winds
    gl.disable(gl.CULL_FACE);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
    return this.canvas;
  }
}
