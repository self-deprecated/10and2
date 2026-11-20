// The reading voice's audio as the phones play and keep it (AAC-LC in ADTS frames, mono): the replacement engine sends
// 24 kHz 16-bit PCM, encoded here as it arrives by the Fraunhofer FDK AAC encoder built to aac.wasm (build.sh). The
// module is given, not loaded: the cloud imports it (Workers can't compile WebAssembly from bytes), Lattice reads it.

type Exports = {
  memory: WebAssembly.Memory;
  _initialize(): void;
  aac_open(rate: number, bitrate: number): number;
  aac_input(enc: number, n: number): number;
  aac_encode(enc: number, n: number): number;
  aac_output(enc: number): number;
  aac_taken(enc: number): void;
  aac_close(enc: number): void;
};

export type AacEncoder = {
  /** More little-endian 16-bit mono PCM, any length (an odd byte waits for the next). */
  push(pcm: Uint8Array): void;
  /** The whole stream's ADTS frames; the encoder can't be used after. */
  finish(): Uint8Array;
  /** Gives the encoder up without its frames (a take that failed); nothing after. Safe to call again. */
  close(): void;
};

/**
 * One instance per module, for every stream: an instance's memory starts at 4 MB and is freed only by garbage
 * collection, so one per segment piled up in a Durable Object's isolate (128 MB). Each stream is a handle in it of about
 * 300 KB. Every call is synchronous, so streams interleaved between events never see each other's state.
 */
const instances = new WeakMap<WebAssembly.Module, Exports>();
const instanceOf = (module: WebAssembly.Module) => {
  let x = instances.get(module);
  if (!x) {
    x = new WebAssembly.Instance(module, { env: { emscripten_notify_memory_growth() {} } }).exports as unknown as Exports;
    x._initialize();
    instances.set(module, x);
  }
  return x;
};

/** One stream's encoder. */
export function aacEncoder(module: WebAssembly.Module, rate = 24_000, bitrate = 64_000): AacEncoder {
  const x = instanceOf(module);
  const enc = x.aac_open(rate, bitrate);
  if (!enc) throw new Error("couldn't start the AAC encoder");
  const out: Uint8Array[] = [];
  let odd: number | null = null;
  let done = false;
  // The output so far, copied out of the module's memory (which may have grown, so its buffer is read again).
  const drain = (pending: number) => {
    if (pending < 0) throw new Error(`AAC encoder error ${-pending}`);
    if (pending) out.push(new Uint8Array(x.memory.buffer, x.aac_output(enc), pending).slice());
    x.aac_taken(enc);
  };
  return {
    push(pcm) {
      if (done) throw new Error("the AAC encoder has finished");
      let bytes = pcm;
      if (odd !== null) {
        bytes = new Uint8Array(pcm.length + 1);
        bytes[0] = odd;
        bytes.set(pcm, 1);
        odd = null;
      }
      if (bytes.length % 2) {
        odd = bytes[bytes.length - 1];
        bytes = bytes.subarray(0, bytes.length - 1);
      }
      const n = bytes.length / 2;
      if (!n) return;
      const at = x.aac_input(enc, n);
      if (!at) throw new Error("the AAC encoder ran out of memory");
      new Uint8Array(x.memory.buffer, at, bytes.length).set(bytes);
      drain(x.aac_encode(enc, n));
    },
    close() {
      if (done) return;
      done = true;
      x.aac_close(enc);
    },
    finish() {
      if (done) throw new Error("the AAC encoder has finished");
      done = true;
      try {
        drain(x.aac_encode(enc, -1));
      } finally {
        x.aac_close(enc);
      }
      const all = new Uint8Array(out.reduce((n, b) => n + b.length, 0));
      let i = 0;
      for (const b of out) {
        all.set(b, i);
        i += b.length;
      }
      return all;
    },
  };
}
