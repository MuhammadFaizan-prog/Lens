/**
 * Frame-accurate access to a source video: every frame is decoded once by the dev server to JPEG;
 * the browser keeps the compressed bytes and a small LRU of decoded bitmaps. Indexing follows the
 * reference compositor's FrameSource.at(): frame = round(t * fps / 1000), clamped to the last frame.
 */
import { pyRound } from "../render/renderer";

export class FrameStore {
  private blobs = new Map<number, Promise<Blob>>();
  private bitmaps = new Map<number, ImageBitmap>();
  private decoding = new Map<number, Promise<ImageBitmap>>();

  constructor(
    readonly track: "screen" | "cam",
    readonly count: number,
    readonly fps: number,
    private readonly query = "",
    private readonly maxBitmaps = 24,
  ) {}

  indexAt(tMs: number): number {
    return Math.min(this.count - 1, Math.max(0, pyRound((tMs * this.fps) / 1000)));
  }

  private blob(i: number): Promise<Blob> {
    let p = this.blobs.get(i);
    if (!p) {
      p = fetch(`/api/frames/${this.track}/${i}.jpg${this.query}`).then((r) => {
        if (!r.ok) throw new Error(`frame ${i}: ${r.status}`);
        return r.blob();
      });
      p.catch(() => this.blobs.delete(i));
      this.blobs.set(i, p);
    }
    return p;
  }

  /** Decoded bitmap if it is ready now. */
  peek(i: number): ImageBitmap | undefined {
    const b = this.bitmaps.get(i);
    if (b) {
      this.bitmaps.delete(i);
      this.bitmaps.set(i, b); // LRU touch
    }
    return b;
  }

  load(i: number): Promise<ImageBitmap> {
    const hit = this.peek(i);
    if (hit) return Promise.resolve(hit);
    let p = this.decoding.get(i);
    if (!p) {
      p = this.blob(i)
        .then((b) => createImageBitmap(b))
        .then((bmp) => {
          this.bitmaps.set(i, bmp);
          this.decoding.delete(i);
          while (this.bitmaps.size > this.maxBitmaps) {
            const oldest = this.bitmaps.keys().next().value as number;
            this.bitmaps.get(oldest)?.close();
            this.bitmaps.delete(oldest);
          }
          return bmp;
        });
      p.catch(() => this.decoding.delete(i));
      this.decoding.set(i, p);
    }
    return p;
  }

  /** Forget frames below index `i` (compressed bytes and bitmaps): the export walks forward once. */
  releaseBelow(i: number): void {
    for (const k of [...this.blobs.keys()]) if (k < i) this.blobs.delete(k);
    for (const [k, b] of [...this.bitmaps]) if (k < i) {
      b.close();
      this.bitmaps.delete(k);
    }
  }

  /** Fetch compressed bytes for a range (cheap) and decode the first few. */
  prefetch(indices: number[], decode = 6): void {
    indices.forEach((i, n) => {
      if (i < 0 || i >= this.count) return;
      if (n < decode) void this.load(i).catch(() => undefined);
      else void this.blob(i).catch(() => undefined);
    });
  }
}
