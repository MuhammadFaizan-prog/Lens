/**
 * Preview noise reduction: RNNoise (xiph/rnnoise, BSD-3-Clause) compiled to WebAssembly, run in an
 * AudioWorklet (@sapphi-red/web-noise-suppressor, MIT). The wasm and the worklet are bundled by Vite
 * (no network). The context must run at 48 kHz (RNNoise's frame rate).
 */
import { loadRnnoise, RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";
import workletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import wasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import simdUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";

let wasm: Promise<ArrayBuffer> | null = null;
const loaded = new WeakSet<BaseAudioContext>();

export async function createRnnoise(ctx: BaseAudioContext): Promise<AudioNode> {
  wasm ??= loadRnnoise({ url: wasmUrl, simdUrl });
  const bin = await wasm;
  if (!loaded.has(ctx)) {
    await ctx.audioWorklet.addModule(workletUrl);
    loaded.add(ctx);
  }
  return new RnnoiseWorkletNode(ctx as AudioContext, { wasmBinary: bin, maxChannels: 2 });
}
