import { test } from "node:test";
import assert from "node:assert/strict";
import { redactText, redactOutbound } from "../src/redact.ts";

test("common API credentials, JWTs, private keys and assignments are redacted", () => {
  for (const secret of ["sk-proj-abcdefghijklmnop", "ghp_abcdefghijklmnop", "xoxb-1234567890-abcdefgh", "AKIAABCDEFGHIJKLMNOP", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.signature123", "-----BEGIN " + "RSA PRIVATE KEY-----\nprivate material\n-----END RSA PRIVATE KEY-----", "-----BEGIN " + "PRIVATE KEY-----\ntruncated private material"]) {
    assert.doesNotMatch(redactText(`Before ${secret}`), /abcdefghijklmnop|ABCDEFGHIJKLMNOP|eyJ|private material/);
    assert.match(redactText(secret), /REDACTED/);
  }
  assert.equal(redactText('password=secret token="two words" TOKEN=another; password=\'quoted words\''), 'password=[REDACTED] token=[REDACTED] TOKEN=[REDACTED]; password=[REDACTED]');
  assert.equal(redactText("Ordinary prompt, progress and reply."), "Ordinary prompt, progress and reply.");
});

test("display fields are filtered without changing routing and reply references", () => {
  const secret = "sk-abcdefghijklmnop";
  const frame = { type: "res", id: secret, ok: true, value: { text: secret, prompt: secret, reply: { runId: secret, messageId: secret, at: "today" } } };
  assert.deepEqual(redactOutbound(frame), { ...frame, value: { ...frame.value, text: "[REDACTED]", prompt: "[REDACTED]" } });
  assert.equal(frame.value.text, secret, "redaction never alters the local projection or ledger");
});
