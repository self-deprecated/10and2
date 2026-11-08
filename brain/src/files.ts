// The brain's files (session recordings, read-aloud audio, flags, the phone's logs) on either home: a directory on
// Lattice, an R2 bucket under the user's own prefix in the cloud. Paths are relative and use "/".
import { createWriteStream, mkdirSync } from "node:fs";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";

export type FileInfo = { path: string; size: number; at: number };

export interface Files {
  /** Null when there's no such file. */
  read(path: string): Promise<Uint8Array | null>;
  /** Creates or replaces the file. */
  write(path: string, data: Uint8Array | string): Promise<void>;
  /** The files directly under `dir`, with their size and when they were last written. */
  list(dir: string): Promise<FileInfo[]>;
  remove(path: string): Promise<void>;
  /** A stream that appends to the file (a session's recording): line by line on disk; in R2, the whole so far every 15 s and when it ends. */
  writer(path: string): Writable;
  /** Where a person reviewing a flag finds the file: a path on Lattice, an R2 key in the cloud. */
  where(path: string): string;
}

/** A directory only the brain's user can read: directories 0700, files 0600. */
export function dirFiles(root: string): Files {
  const full = (p: string) => join(root, p);
  return {
    async read(p) {
      try {
        return await readFile(full(p));
      } catch (e: any) {
        if (e?.code === "ENOENT") return null;
        throw e;
      }
    },
    async write(p, data) {
      await mkdir(dirname(full(p)), { recursive: true, mode: 0o700 });
      await writeFile(full(p), data, { mode: 0o600 });
    },
    async list(dir) {
      const names = await readdir(full(dir)).catch((e) => (e?.code === "ENOENT" ? [] : Promise.reject(e)));
      const out: FileInfo[] = [];
      for (const name of names) {
        const s = await stat(full(join(dir, name))).catch(() => null);
        if (s?.isFile()) out.push({ path: join(dir, name), size: s.size, at: s.mtimeMs });
      }
      return out;
    },
    async remove(p) {
      await unlink(full(p)).catch((e) => (e?.code === "ENOENT" ? undefined : Promise.reject(e)));
    },
    writer(p) {
      mkdirSync(dirname(full(p)), { recursive: true, mode: 0o700 });
      return createWriteStream(full(p), { flags: "a", mode: 0o600 });
    },
    where: (p) => full(p),
  };
}

/** The subset of an R2 bucket binding used here (`@cloudflare/workers-types`' `R2Bucket`). */
export type Bucket = {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(key: string, value: Uint8Array | string): Promise<unknown>;
  delete(key: string): Promise<void>;
  list(opts: { prefix: string; delimiter?: string; cursor?: string }): Promise<{
    objects: { key: string; size: number; uploaded: Date }[];
    truncated: boolean;
    cursor?: string;
  }>;
};

/** One user's files in the bucket, every key under `prefix` (`users/<Clerk user id>/`), so no path can leave it. */
export function bucketFiles(bucket: Bucket, prefix: string, saveEveryMs = 15_000): Files {
  const key = (p: string) => {
    if (p.split("/").some((part) => part === ".." || part === "")) throw new Error(`bad path ${p}`);
    return prefix + p;
  };
  return {
    async read(p) {
      const o = await bucket.get(key(p));
      return o ? new Uint8Array(await o.arrayBuffer()) : null;
    },
    async write(p, data) {
      await bucket.put(key(p), data);
    },
    async list(dir) {
      const out: FileInfo[] = [];
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix: `${key(dir)}/`, delimiter: "/", cursor });
        for (const o of page.objects) out.push({ path: o.key.slice(prefix.length), size: o.size, at: o.uploaded.getTime() });
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return out;
    },
    remove: (p) => bucket.delete(key(p)),
    writer(p) {
      const k = key(p);
      let parts: Buffer[] = [];
      let savedAt = -Infinity;
      // Puts one after another, so an older copy never lands after a newer one.
      let saving: Promise<unknown> = Promise.resolve();
      const save = () => {
        const body = Buffer.concat(parts);
        parts = [body];
        saving = saving.then(() => bucket.put(k, body)).catch(() => {});
        return saving;
      };
      return new Writable({
        write(chunk, _enc, done) {
          parts.push(Buffer.from(chunk));
          // Saved as it goes, not only at the end: on 5 November Cloudflare reset a brain 11 minutes into a call and its
          // recording, held only in memory until the call ended, was lost with it.
          if (Date.now() - savedAt >= saveEveryMs) {
            savedAt = Date.now();
            void save();
          }
          done();
        },
        final(done) {
          const body = Buffer.concat(parts);
          saving.then(() => bucket.put(k, body)).then(() => done(), done);
        },
      });
    },
    where: (p) => `r2://${key(p)}`,
  };
}
