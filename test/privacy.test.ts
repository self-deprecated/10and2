import { test } from "node:test";
import assert from "node:assert/strict";
import { blockedFolders, forgetPrivacy, privacyRefusal, protectedFolder } from "../src/privacy.ts";

const home = "/Users/me";

test("the folders macOS asks about, and only on macOS", () => {
  assert.deepEqual(protectedFolder("/Users/me/Documents/app", home, "darwin"), { root: "/Users/me/Documents", name: "Documents Folder" });
  assert.equal(protectedFolder("/Users/me/Desktop", home, "darwin")?.name, "Desktop Folder");
  assert.equal(protectedFolder("/Users/me/Library/Mobile Documents/com~apple~CloudDocs/app", home, "darwin")?.name, "iCloud Drive");
  assert.equal(protectedFolder("/Users/me/Development/app", home, "darwin"), null);
  assert.equal(protectedFolder("/Users/me/Documents-old/app", home, "darwin"), null);
  assert.equal(protectedFolder("/Users/me/Documents/app", home, "linux"), null);
});

test("work in a folder macOS keeps closed is refused with what to allow; an OK counts within 30 s", async () => {
  forgetPrivacy();
  let allowed = false, asked = 0;
  const opts = (now: number) => ({ home, platform: "darwin" as const, program: "node", now, opens: async (dir: string) => { asked++; assert.equal(dir, "/Users/me/Documents"); return allowed; } });
  const why = await privacyRefusal("/Users/me/Documents/app", opts(0));
  assert.match(why ?? "", /^macOS hasn't let 10 & 2 into your Documents folder on this Mac\. .*Files & Folders, and turn on Documents Folder under “node”\.$/);
  assert.deepEqual(blockedFolders(), ["Documents Folder"]);
  // Asked once per folder for 30 s, whichever project in it.
  assert.equal(await privacyRefusal("/Users/me/Documents/other", opts(10_000)), why);
  assert.equal(asked, 1);
  allowed = true;
  assert.equal(await privacyRefusal("/Users/me/Documents/app", opts(30_000)), null);
  assert.deepEqual(blockedFolders(), []);
  // Nothing to ask about elsewhere, or with no folder.
  assert.equal(await privacyRefusal("/Users/me/Development/app", opts(40_000)), null);
  assert.equal(await privacyRefusal(null, opts(40_000)), null);
  assert.equal(asked, 2);
});
