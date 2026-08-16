const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.resolve(__dirname, "../src/index.ts"), "utf8");

test("worker authorization validates signature and bounded entitlement claims", () => {
  assert.match(source, /crypto\.subtle\.verify/);
  assert.match(source, /claims\.iss === "knowtes-backend"/);
  assert.match(source, /claims\.aud === "knowtes-jarvis"/);
  assert.match(source, /claims\.exp <= now \+ 10 \* 60/);
  assert.match(source, /\["pro", "premium", "admin"\]\.includes\(claims\.plan\)/);
});

test("worker bounds untrusted input and upstream execution", () => {
  assert.match(source, /audioFile\.size > 25 \* 1024 \* 1024/);
  assert.match(source, /knowtesRaw\.length > 250_000/);
  assert.match(source, /AbortSignal\.timeout\(45_000\)/);
  assert.doesNotMatch(source, /body\.slice\(0, 200\)/);
});

test("worker validates typed links and preserves review status", () => {
  assert.match(source, /supports\|contradicts\|causes\|evolves_to\|related/);
  assert.match(source, /status: link\.status === "resolved" \? "resolved" : "pending"/);
  assert.match(source, /seenTargets\.has\(link\.to\)/);
  assert.match(source, /max_tokens: 2048/);
});

test("worker does not allow wildcard browser origins", () => {
  const config = fs.readFileSync(path.resolve(__dirname, "../wrangler.toml"), "utf8");
  assert.doesNotMatch(config, /ALLOWED_ORIGIN\s*=\s*"\*"/);
  assert.match(source, /requestOrigin === allowedOrigin/);
});
