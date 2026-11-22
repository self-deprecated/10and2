import { test } from "node:test";
import assert from "node:assert/strict";
import { redactText, redactOutbound } from "../src/redact.ts";

test("common API credentials, JWTs, private keys and assignments are redacted", () => {
  for (const secret of ["sk-proj-abcdefghijklmnop", "ghp_abcdefghijklmnop", "xoxb-1234567890-abcdefgh", "AKIAABCDEFGHIJKLMNOP", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.signature123", "-----BEGIN " + "RSA PRIVATE KEY-----\nprivate material\n-----END RSA PRIVATE KEY-----", "-----BEGIN " + "PRIVATE KEY-----\ntruncated private material"]) {
    assert.doesNotMatch(redactText(`Before ${secret}`), /abcdefghijklmnop|ABCDEFGHIJKLMNOP|eyJ|private material/);
    assert.match(redactText(secret), /REDACTED/);
  }
  assert.equal(redactText('password=secret token="two words" TOKEN=another; password=\'quoted words\''), 'password=[REDACTED] token=[REDACTED] TOKEN=[REDACTED]; password=[REDACTED]');
  assert.equal(redactText("Authorization: Bearer super_secret_token_123"), "Authorization: Bearer [REDACTED]");
  assert.equal(redactText("api_key: raw_secret_value_456"), "api_key: [REDACTED]");
  assert.equal(redactText("postgres://admin:hunter2@db.internal:5432/app"), "postgres://admin:[REDACTED]@db.internal:5432/app");
  assert.equal(redactText("Ordinary prompt, progress and reply."), "Ordinary prompt, progress and reply.");
  // A variable set to a secret as a command starts (Fable's nit on stage 4's fix4): its literal value; a variable's stays.
  assert.equal(redactText(`PGPASSWORD=hunter2 dropdb shop && AWS_SECRET_ACCESS_KEY='a/b+c' DB_TOKEN="x y" terraform apply`), "PGPASSWORD=[REDACTED] dropdb shop && AWS_SECRET_ACCESS_KEY=[REDACTED] DB_TOKEN=[REDACTED] terraform apply");
  assert.equal(redactText(`NPM_TOKEN=$NPM_TOKEN npm publish; PGPASSWORD="$PW" dropdb shop`), `NPM_TOKEN=$NPM_TOKEN npm publish; PGPASSWORD="$PW" dropdb shop`);
  // A value in quotes keeps its closing quote shown: only the value is masked.
  assert.equal(redactText(`terraform apply -var "token=abc"`), `terraform apply -var "token=[REDACTED]"`);
  // The mask of a name for a secret stops at `$`, so what runs after it is shown (the skeptic's nit on fix4).
  assert.equal(redactText("MY_TOKEN=abc$(x) terraform apply"), "MY_TOKEN=[REDACTED]$(x) terraform apply");
  // npm's `_authToken=`, and lower case after an underscore (the skeptic's and Fable's nits on fix4); a key only when it's
  // a secret's, so a bucket's key or an environment's name is shown.
  assert.equal(redactText("npm publish --//registry.npmjs.org/:_authToken=abc123"), "npm publish --//registry.npmjs.org/:_authToken=[REDACTED]");
  assert.equal(redactText(`terraform apply -var "db_password=hunter2" -var "api_token=zzz" -var aws_secret_access_key=k`), `terraform apply -var "db_password=[REDACTED]" -var "api_token=[REDACTED]" -var aws_secret_access_key=[REDACTED]`);
  assert.equal(redactText("OPENAI_API_KEY=a API_KEY=b STRIPE_SECRET_KEY=c PRIVATE_KEY=d SECRET=e x"), "OPENAI_API_KEY=[REDACTED] API_KEY=[REDACTED] STRIPE_SECRET_KEY=[REDACTED] PRIVATE_KEY=[REDACTED] SECRET=[REDACTED] x");
  assert.equal(redactText("S3_BUCKET_KEY=prod/terraform.tfstate terraform apply -var ENV_KEY=production"), "S3_BUCKET_KEY=prod/terraform.tfstate terraform apply -var ENV_KEY=production");
  // In a URL a value ends at its `@`, so the host and the repository stay shown (the skeptic's nit on fix4).
  assert.equal(redactText(`git push "https://user:token=abc@github.com/x" --force`), `git push "https://user:token=[REDACTED]@github.com/x" --force`);
  assert.equal(redactText("password=p@ss"), "password=[REDACTED]", "not in a URL: all of it");
  // An empty one too, so the host is still shown (the skeptic's nit on fix5).
  assert.equal(redactText("git push https://token=@evil.example/x --force"), "git push https://token=[REDACTED]@evil.example/x --force");
  // A value from a variable is no secret, as a name's isn't (both reviews' should on fix5).
  assert.equal(redactText(`terraform apply -var token=$TF_TOKEN -var "password=\${PW}" -var token="$T" -var password=$(cat p)`), `terraform apply -var token=$TF_TOKEN -var "password=\${PW}" -var token="$T" -var password=$(cat p)`);
  // A literal written after `$` is masked whole, in both rules (both reviews' nits on fix6): bash's $'…' and $"…", a
  // default inside ${…:-…}, a variable with a literal after it, and '$T' in single quotes, which the shell never expands.
  assert.equal(redactText(`terraform apply -var token=$'hunter2' -var password=$"hunter2" -var token=\${TF_TOKEN:-hunter2} -var token=$T/x -var token='$T'`),
    "terraform apply -var token=[REDACTED] -var password=[REDACTED] -var token=[REDACTED] -var token=[REDACTED] -var token=[REDACTED]");
  assert.equal(redactText(`PGPASSWORD=$'hunter2' DB_TOKEN=\${T:=hunter2} API_KEY=$"k" NPM_TOKEN=$NPM_TOKEN npm publish`), "PGPASSWORD=[REDACTED] DB_TOKEN=[REDACTED] API_KEY=[REDACTED] NPM_TOKEN=$NPM_TOKEN npm publish");
  // A name for a secret in any case, after any name (the skeptic's should and nit, Fable's nit on fix5): Terraform's
  // TF_VAR_, camelCase, run together, bare lower case; lower-case passwd; still a key only when it's a secret's.
  assert.equal(redactText("TF_VAR_token=a TF_VAR_db_password=b terraform apply -var=dbPassword=c -var=dbpassword=d -var=apiKey=e -var api_key=f -var apikey=g -var secret=h -var secret_key=i -var access_key=j -var db_passwd=k"),
    "TF_VAR_token=[REDACTED] TF_VAR_db_password=[REDACTED] terraform apply -var=dbPassword=[REDACTED] -var=dbpassword=[REDACTED] -var=apiKey=[REDACTED] -var api_key=[REDACTED] -var apikey=[REDACTED] -var secret=[REDACTED] -var secret_key=[REDACTED] -var access_key=[REDACTED] -var db_passwd=[REDACTED]");
  assert.equal(redactText("terraform apply -var max_tokens=4000 -var bucket_key=x -var monkey=y"), "terraform apply -var max_tokens=4000 -var bucket_key=x -var monkey=y");
});

test("display fields are filtered without changing routing and reply references", () => {
  const secret = "sk-abcdefghijklmnop";
  const frame = { type: "res", id: secret, ok: true, value: { text: secret, prompt: secret, headings: [`Key ${secret}`], reply: { runId: secret, messageId: secret, at: "today" } } };
  assert.deepEqual(redactOutbound(frame), { ...frame, value: { ...frame.value, text: "[REDACTED]", prompt: "[REDACTED]", headings: ["Key [REDACTED]"] } });
  assert.equal(frame.value.text, secret, "redaction never alters the local projection or ledger");
});

test("Stripe, Google, GitLab, npm and Hugging Face keys, and passwords in database and service addresses, are redacted", () => {
  // Built at run time: a whole key's shape in the file would be one (scripts/lint-secrets.mjs, push protection).
  const tail = "a1B2c3D4e5F6g7H8i9J0k1L2";
  const keys = [`sk_${"live"}_${tail}`, `sk_${"test"}_${tail}`, `rk_${"live"}_${tail}`, `rk_${"test"}_${tail}`, `AIza${"Sy0123456789abcdefghijklmnopqrstuvw"}`, `glpat-${tail}`, `npm_${tail}`, `hf_${tail}`];
  for (const key of keys) {
    assert.equal(redactText(`deploy with ${key} now`), "deploy with [REDACTED] now", key);
    assert.doesNotMatch(JSON.stringify(redactOutbound({ text: key })), new RegExp(tail));
  }
  // Short or ordinary words that only start like one are shown.
  assert.equal(redactText("npm_config_if_present hf_hub sk_test_fake glpat-short"), "npm_config_if_present hf_hub sk_test_fake glpat-short");
  for (const scheme of ["postgres", "postgresql", "mysql", "redis", "rediss", "mongodb", "mongodb+srv", "amqp"]) {
    assert.equal(redactText(`DATABASE_URL is ${scheme}://app:s3cr3t-pa55@db.internal:5432/shop`), `DATABASE_URL is ${scheme}://app:[REDACTED]@db.internal:5432/shop`, scheme);
  }
  // An address without a password, or another scheme's, is shown as it is.
  assert.equal(redactText("postgres://app@db.internal/shop and https://user:x@example.com"), "postgres://app@db.internal/shop and https://user:x@example.com");
});
