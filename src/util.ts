import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { renameSync, rmSync } from "node:fs";

// Keep errors readable without importing any brain runtime code.
export const describe = (e: unknown): string => e instanceof Error ? e.message : String(e);

/**
 * A model's name as compared for "one per name": without case, spaces or punctuation, as the brain compares and says
 * them (brain/src/thread-models.ts), so "GPT-6.1 Sol" and "GPT-6.1-Sol" are one.
 */
export const modelKey = (name: string): string => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** 128 random bits as 32 hex digits: a token, a secret or a nonce. */
export const randomHex = () => randomBytes(16).toString("hex");

/**
 * What a local server answers a client's nonce with to show it knows the secret in the user's private files, which a
 * pipe's name can't show: on Windows another account can take a pipe's name once it's free. HMAC-SHA256, so the
 * secret itself is never sent.
 */
export const proof = (secret: string, nonce: string) => createHmac("sha256", secret).update(nonce).digest("hex");

/** Whether `answer` is that proof, compared in constant time. */
export function proves(answer: string, secret: string, nonce: string): boolean {
  const got = Buffer.from(answer), want = Buffer.from(proof(secret, nonce));
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Moves a freshly written file over `path`. On Windows that fails while another program (antivirus, the search
 * indexer, an editor) briefly has the old file open, so it's tried again for about a second; the temporary file is
 * removed if it still can't be moved.
 */
export function replaceFile(tmp: string, path: string): void {
  for (let attempt = 0; ; attempt++) {
    try { renameSync(tmp, path); return; }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") || attempt >= 10) {
        rmSync(tmp, { force: true });
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
}
