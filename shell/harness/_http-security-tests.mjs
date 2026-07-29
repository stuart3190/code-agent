import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  BODY_LIMITS, allowedOrigins, applyCors, createRateLimiter, parseJson, readBody, staticCacheControl,
} from "../server/lib/httpSecurity.mjs";

class Request extends EventEmitter {
  constructor(headers = {}) { super(); this.headers = headers; }
  resume() {}
}
class Response {
  headers = new Map();
  setHeader(name, value) { this.headers.set(name, value); }
}

assert.deepEqual(parseJson(Buffer.from('{"ok":true}')), { ok: true });
assert.throws(() => parseJson(Buffer.from("{")), /valid JSON/);

const request = new Request();
const pending = readBody(request, 4);
request.emit("data", Buffer.from("123"));
request.emit("data", Buffer.from("45"));
request.emit("end");
await assert.rejects(pending, (e) => e.status === 413);

await assert.rejects(readBody(new Request({ "content-length": String(BODY_LIMITS.standard + 1) })),
  (e) => e.code === "request_too_large");

const origins = allowedOrigins("https://buildr101.com");
const allowed = new Response();
assert.equal(applyCors(allowed, "https://buildr101.com", origins), true);
assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), "https://buildr101.com");
assert.equal(applyCors(new Response(), "https://evil.example", origins), false);

let time = 1_000;
const consume = createRateLimiter({ now: () => time });
assert.equal(consume("ip:route", 2, 1_000).allowed, true);
assert.equal(consume("ip:route", 2, 1_000).allowed, true);
assert.equal(consume("ip:route", 2, 1_000).allowed, false);
time += 1_001;
assert.equal(consume("ip:route", 2, 1_000).allowed, true);

assert.match(staticCacheControl("/assets/app-abc.js"), /immutable/);
assert.equal(staticCacheControl("/index.html"), "no-cache");

console.log("http security: pass");
