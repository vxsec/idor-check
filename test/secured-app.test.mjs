// A small fake app that is set up CORRECTLY (owner-only rows, role-checked admin route, only the
// public anon key in the page). The checker must report zero holes against it, with and without --writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.c2lnbmF0dXJlLWZha2UtZm9yLXRlc3Rz`;
const ANON = jwt({ role: "anon", iss: "test" });
const USERS = { a: { id: "aaaaaaaa-0000-0000-0000-000000000001", email: "a@x.test", pw: "pw-a", role: "user" }, b: { id: "bbbbbbbb-0000-0000-0000-000000000002", email: "b@x.test", pw: "pw-b", role: "user" } };
const TOK = Object.fromEntries(Object.values(USERS).map((u) => [jwt({ sub: u.id, role: "authenticated" }), u]));
let notes, members, board;
const reset = () => { notes = [{ id: 1, owner_id: USERS.a.id, body: "alpha note 1001" }, { id: 2, owner_id: USERS.b.id, body: "bravo private memo" }]; members = Object.values(USERS).map((u) => ({ user_id: u.id, role: u.role })); board = [{ id: 1, text: "welcome" }]; };

function serve(leaky = false, opts = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x"); const send = (c, o, t = "application/json") => { res.writeHead(c, { "content-type": t }); res.end(typeof o === "string" ? o : JSON.stringify(o)); };
    const body = await new Promise((r) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => r(s ? JSON.parse(s) : null)); });
    const user = TOK[(req.headers.authorization || "").replace("Bearer ", "")];
    if (url.pathname === "/") return send(200, '<script type="module" src="/app.js"></script>', "text/html");
    if (url.pathname === "/app.js") return send(200, `import { KEY } from "./config.js"; export const SUPABASE_ANON_KEY = '${ANON}';${opts.remoteSb ? ` const SB = "https://abcdefghijabcdefghij.supabase.co";` : ""}`, "text/javascript");
    if (url.pathname === "/api/echo-pw") return user ? send(200, { note: `your password is pw-a` }) : send(401, { error: "login" });
    if (url.pathname === "/config.js") return send(200, `export const KEY = '${ANON}';${leaky ? " export const ADMIN_TOKEN = 'adm_secret_abc';" : ""}`, "text/javascript");
    if (url.pathname === "/auth/v1/token") { const u = Object.values(USERS).find((x) => x.email === body.email && x.pw === body.password); return u ? send(200, { access_token: Object.keys(TOK).find((k) => TOK[k] === u), user: { id: u.id } }) : send(400, { error: "bad login" }); }
    if (url.pathname === "/rest/v1/board") { if (req.method === "GET") return send(200, board); if (req.method === "PATCH") return leaky ? send(200, board) : send(401, { message: "permission denied" }); }
    if (url.pathname === "/api/pin/2") { const can = user?.id === USERS.b.id || (leaky && user); return can ? send(200, user.id === USERS.b.id ? "PIN: 1234" : "Your PIN is 1234", "text/plain") : send(404, "nope", "text/plain"); }
    if (url.pathname === "/rest/v1/") return send(200, { paths: { "/notes": {}, "/members": {}, "/board": {} }, definitions: { notes: { properties: { id: { description: "Note:\nThis is a Primary Key.<pk/>" } } }, members: { properties: { user_id: { description: "Note:\nThis is a Primary Key.<pk/>" } } } } });
    const m = url.pathname.match(/^\/rest\/v1\/(notes|members)$/);
    if (m) {
      const rows = m[1] === "notes" ? notes : members, col = m[1] === "notes" ? "owner_id" : "user_id";
      let visible = user ? (leaky && m[1] === "notes" ? rows : rows.filter((r) => r[col] === user.id)) : [];
      for (const [k, v] of url.searchParams) {
        if (v.startsWith("eq.")) visible = visible.filter((r) => String(r[k]) === v.slice(3));
        if (v.startsWith("neq.")) visible = visible.filter((r) => String(r[k]) !== v.slice(4));
      }
      if (req.method === "GET") return send(200, visible);
      if (req.method === "PATCH") { if (!leaky && m[1] === "members" && body && "role" in body) return send(403, { message: "permission denied for column role" }); visible.forEach((r) => Object.assign(r, body)); return send(200, visible); }
    }
    if (url.pathname === "/api/admin/users") return user?.role === "admin" ? send(200, Object.values(USERS)) : send(403, { error: "admins only" });
    if (url.pathname === "/api/notes/2") return user?.id === USERS.b.id || (leaky && user) ? send(200, { ...notes[1], session_token: "tok_SUPERSECRET_1234567890" }) : send(404, { error: "not found" });
    if (url.pathname === "/api/echo") return user ? send(200, { value: "adm_secret_abc", other: "plain" }) : send(401, { error: "login" });
    if (url.pathname === "/api/notes-text/2") { const can = user?.id === USERS.b.id || (leaky && user); res.writeHead(can ? 200 : 404, { "content-type": "text/plain" }); return res.end(can ? (user.id === USERS.b.id ? notes[1].body : `Here you go: ${notes[1].body} (shared view)`) : "not found"); }
    if (url.pathname === "/api/boom") return send(500, { error: "crash" });
    send(404, { error: "not found" });
  });
}

for (const writes of [false, true]) test(`secured app: no false alarms${writes ? " (with --writes)" : ""}`, async () => {
  reset(); const srv = serve(); await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), "idor-check-")); const cfgPath = join(dir, "c.json");
  writeFileSync(cfgPath, JSON.stringify({ baseUrl: base, supabase: { url: base, publicTables: ["board"] }, accounts: { a: { email: "a@x.test", password: "pw-a" }, b: { email: "b@x.test", password: "pw-b" } }, routes: [{ path: "/api/notes/{id}", id: "2", ownedBy: "b" }], adminRoutes: ["/api/admin/users"] }));
  const out = await new Promise((resolve) => {
    const c = spawn(process.execPath, ["idor-check.mjs", "--config", cfgPath, "--delay", "0", "--json", join(dir, "r.json"), ...(writes ? ["--writes"] : [])]);
    let stdout = "", stderr = ""; c.stdout.on("data", (d) => (stdout += d)); c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  srv.close();
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /0 hole\(s\) found/);
  assert.doesNotMatch(out.stdout, /^FAIL/m);
  assert.equal(members.find((r) => r.user_id === USERS.a.id).role, "user");
});

test("refuses a public host without --i-own-this-app", () => {
  const dir = mkdtempSync(join(tmpdir(), "idor-check-")); const cfgPath = join(dir, "c.json");
  writeFileSync(cfgPath, JSON.stringify({ baseUrl: "https://example.com" }));
  const out = spawnSync(process.execPath, ["idor-check.mjs", "--config", cfgPath], { encoding: "utf8", env: { ...process.env, IDOR_CHECK_TEST_DNS: JSON.stringify({ "example.com": ["93.184.216.34"] }) } });
  assert.equal(out.status, 2); assert.match(out.stderr, /Refusing to test example\.com/);
});

async function runAgainst(leaky, extraArgs = [], cfgExtra = {}, opts = {}) {
  reset(); const srv = serve(leaky, opts); await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://${opts.host || "127.0.0.1"}:${srv.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), "idor-check-")); const cfgPath = join(dir, "c.json"), json = join(dir, "r.json");
  writeFileSync(cfgPath, JSON.stringify({ baseUrl: base, supabase: { url: base }, accounts: { a: { email: "a@x.test", password: "pw-a" }, b: { email: "b@x.test", password: "pw-b" } }, routes: [{ path: "/api/notes/{id}", id: "2", ownedBy: "b" }], adminRoutes: ["/api/admin/users"], ...cfgExtra, supabase: opts.noSupabaseUrl ? {} : { ...(cfgExtra.supabase || {}), url: base } }));
  const out = await new Promise((resolve) => {
    const c = spawn(process.execPath, ["idor-check.mjs", "--config", cfgPath, "--delay", "0", "--json", json, ...extraArgs], { env: { ...process.env, ...(opts.dns ? { IDOR_CHECK_TEST_DNS: JSON.stringify(opts.dns) } : {}) } });
    let stdout = "", stderr = ""; c.stdout.on("data", (d) => (stdout += d)); c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  srv.close(); out.json = (() => { try { return readFileSync(json, "utf8"); } catch { return ""; } })(); return out;
}

test("leaky app: holes caught, tokens hidden, self-promotion put back and checked", async () => {
  const out = await runAgainst(true, ["--writes"]);
  assert.equal(out.status, 1, out.stderr);
  assert.match(out.stdout, /FAIL\s+cross-account: as A, not the owner gets B's record at \/api\/notes\/2/);
  assert.match(out.stdout, /FAIL\s+cross-account: A can read rows in "notes"/);
  assert.match(out.stdout, /FAIL\s+self-promotion: A can set their own "role".*put back and checked/);
  assert.equal(members.find((r) => r.user_id === USERS.a.id).role, "user");
  for (const text of [out.stdout, out.json]) { assert.doesNotMatch(text, /SUPERSECRET/); assert.doesNotMatch(text, /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/); }
});

test("a server error is UNSURE, never PASS", async () => {
  const out = await runAgainst(false, [], { adminRoutes: ["/api/boom"] });
  assert.match(out.stdout, /UNSURE admin route: as A, a normal user at \/api\/boom: got 500/);
});

test("ownership gate: no staging shortcut, no route escaping the host", () => {
  const dir = mkdtempSync(join(tmpdir(), "idor-check-"));
  const DNS = { "staging.example.com": ["93.184.216.34"], "127.example.com": ["93.184.216.34"], "10.0.0.1.nip.io": ["93.184.216.34"], "abc.supabase.co": ["104.18.38.10"], "evil.test": ["93.184.216.34"], "mixed.local": ["127.0.0.1", "93.184.216.34"], "meta.test": ["169.254.169.254"] };
  const run = (cfg, extra = []) => { const p = join(dir, Math.random() + ".json"); writeFileSync(p, JSON.stringify(cfg)); return spawnSync(process.execPath, ["idor-check.mjs", "--config", p, ...extra], { encoding: "utf8", env: { ...process.env, IDOR_CHECK_TEST_DNS: JSON.stringify(DNS) } }); };
  let r = run({ baseUrl: "https://staging.example.com" });
  assert.equal(r.status, 2); assert.match(r.stderr, /Refusing to test staging\.example\.com/);
  r = run({ baseUrl: "http://127.0.0.1:9", routes: [{ path: "@example.com/", id: "1" }], accounts: {} });
  assert.equal(r.status, 2); assert.match(r.stderr, /must start with a single/);
  r = run({ baseUrl: "http://127.0.0.1:9", adminRoutes: ["//example.com/x"] });
  assert.equal(r.status, 2); assert.match(r.stderr, /must start with a single/);
  r = run({ baseUrl: "http://127.example.com" });
  assert.equal(r.status, 2); assert.match(r.stderr, /Refusing to test 127\.example\.com/);
  r = run({ baseUrl: "http://10.0.0.1.nip.io" });
  assert.equal(r.status, 2); assert.match(r.stderr, /Refusing/);
  for (const host of ["evil.test", "mixed.local", "meta.test"]) {
    r = run({ baseUrl: `http://${host}` });
    assert.equal(r.status, 2, host); assert.match(r.stderr, new RegExp(`Refusing to test ${host.replace(".", "\\.")}`), host);
  }
  r = run({ baseUrl: "http://169.254.169.254" });
  assert.equal(r.status, 2); assert.match(r.stderr, /Refusing/);
  r = run({ baseUrl: "http://127.0.0.1:9", supabase: { url: "https://abc.supabase.co" } });
  assert.equal(r.status, 2); assert.match(r.stderr, /Refusing to test abc\.supabase\.co/);
});

test("leaky app: plain-text leak caught, token in an ordinary field hidden, public table still gets write checks", async () => {
  const out = await runAgainst(true, ["--writes"], {
    routes: [{ path: "/api/notes-text/{id}", id: "2", ownedBy: "b" }],
    adminRoutes: ["/api/echo"],
    supabase: { publicTables: ["notes"] },
  });
  assert.match(out.stdout, /FAIL\s+cross-account: as A, not the owner gets B's record at \/api\/notes-text\/2/);
  assert.match(out.stdout, /FAIL\s+cross-account write: A can edit B's row in "notes". It's listed as public to READ/);
  for (const text of [out.stdout, out.json]) assert.doesNotMatch(text, /adm_secret_abc/);
});

test("short plain-text answers are UNSURE, not PASS; public table with no owner column still gets a write check", async () => {
  const out = await runAgainst(true, ["--writes"], { routes: [{ path: "/api/pin/{id}", id: "2", ownedBy: "b" }], supabase: { publicTables: ["board"] } });
  assert.match(out.stdout, /UNSURE cross-account: as A, not the owner gets an answer at \/api\/pin\/2, and B's record is too short/);
  assert.doesNotMatch(out.stdout, /PASS\s+cross-account: as A, not the owner .*\/api\/pin/);
  assert.match(out.stdout, /FAIL\s+open table write: anyone with your public key can change rows in "board"/);
  const safe = await runAgainst(false, ["--writes"], { supabase: { publicTables: ["board"] } });
  assert.match(safe.stdout, /PASS\s+open table write: the public key can't change rows in "board"/);
  assert.match(safe.stdout, /0 hole\(s\) found/);
});

test("pinning: a made-up name pinned to the local server works end to end", async () => {
  const out = await runAgainst(false, [], { supabase: { publicTables: ["board"] } }, { host: "myapp.test", dns: { "myapp.test": ["127.0.0.1"] } });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /target: http:\/\/myapp\.test:\d+ \(127\.0\.0\.1\)/);
  assert.match(out.stdout, /0 hole\(s\) found/);
});

test("a Supabase project found only in the page is not tested unless it's in the config", async () => {
  const out = await runAgainst(false, [], {}, { remoteSb: true, noSupabaseUrl: true, dns: { "abcdefghijabcdefghij.supabase.co": ["104.18.38.10"] } });
  assert.match(out.stdout, /UNSURE supabase: your page talks to https:\/\/abcdefghijabcdefghij\.supabase\.co, which isn't in your config/);
  assert.doesNotMatch(out.stdout, /target: https:\/\/abcdefghij/);
  const own = await runAgainst(false, ["--i-own-this-app"], {}, { remoteSb: true, noSupabaseUrl: true, dns: { "abcdefghijabcdefghij.supabase.co": ["104.18.38.10"] } });
  assert.match(own.stdout, /isn't in your config/);
});

test("a short test password echoed back is hidden", async () => {
  const out = await runAgainst(true, [], { adminRoutes: ["/api/echo-pw"] });
  assert.match(out.stdout, /FAIL\s+admin route: as A, a normal user gets data from \/api\/echo-pw/);
  assert.match(out.stdout, /password is short/);
  for (const text of [out.stdout, out.json]) assert.doesNotMatch(text, /pw-a/);
});
