#!/usr/bin/env node
// one-number-check: does your app hand one user another user's data?
// Zero dependencies. Node 18+. Read-only unless you pass --writes.
// Only run it against an app you own or have written permission to test.
//
//   node one-number-check.mjs --config my-app.json [--writes] [--i-own-this-app] [--json report.json]
//
// Results: FAIL = a hole, with the request and response as proof. PASS = blocked.
//          UNSURE = couldn't tell (error, setup problem, not enough test data). INFO = worth knowing.

import { readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";

// ---------- args + config ----------
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
if (flag("--help") || !opt("--config")) {
  console.log("usage: node one-number-check.mjs --config my-app.json [--writes] [--i-own-this-app] [--json report.json] [--delay 300]");
  process.exit(flag("--help") ? 0 : 2);
}
// "${NAME}" in the config is replaced with the environment variable NAME, so passwords stay out of files.
const raw = readFileSync(opt("--config"), "utf8").replace(/\$\{([A-Z0-9_]+)\}/g, (_, n) => {
  if (process.env[n] === undefined) { console.error(`config needs the environment variable ${n}`); process.exit(2); }
  return JSON.stringify(process.env[n]).slice(1, -1);
});
const cfg = JSON.parse(raw);
const die = (msg) => { console.error(msg); process.exit(2); };
let BASE_URL; try { BASE_URL = new URL(cfg.baseUrl); } catch { die("config: baseUrl must be a full address like http://localhost:3000"); }
const BASE = BASE_URL.origin;
const WRITES = flag("--writes");
const OWN = flag("--i-own-this-app");
const DELAY = +opt("--delay", cfg.delayMs ?? 300);
const MAX_REQ = cfg.maxRequests ?? 400;
const PUBLIC_TABLES = new Set(cfg.supabase?.publicTables || []);

// ---------- safety gate ----------
// Without --i-own-this-app, only local and private-network addresses are allowed. Every request is
// checked against the allowed origins right before it is sent, so a route can't point somewhere else.
function isLocal(host) {
  host = host.replace(/^\[|\]$/g, "");
  if (host === "localhost" || /\.(localhost|test|local)$/.test(host)) return true;
  if (isIP(host) === 6) return host === "::1";
  if (isIP(host) !== 4) return false; // a name like 127.example.com is NOT local
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0$)/.test(host);
}
const allowed = new Set();
function allowOrigin(u, why) {
  const url = new URL(u);
  if (!["http:", "https:"].includes(url.protocol)) die(`${why}: only http and https addresses.`);
  if (!isLocal(url.hostname) && !OWN) die(`Refusing to test ${url.hostname} (${why}): not a local address.\nIf this is YOUR app (or you have written permission), run again with --i-own-this-app.\nBest: test a local or staging copy with throwaway test accounts, never real customer data.`);
  allowed.add(url.origin);
}
allowOrigin(BASE, "baseUrl");
if (cfg.supabase?.url) allowOrigin(cfg.supabase.url, "supabase.url");
function routeUrl(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) die(`config: route "${path}" must start with a single "/"`);
  const u = new URL(path, BASE + "/");
  if (u.origin !== BASE) die(`config: route "${path}" leaves ${BASE}`);
  return u.href;
}

// ---------- hiding secrets in everything we print or save ----------
const mask = (s) => (s.length <= 12 ? "****" : `${s.slice(0, 6)}…${s.slice(-4)}`);
const SECRET_KEYS = /(token|secret|password|passwd|api_?key|apikey|authorization|cookie|session|private|refresh)/i;
const KNOWN_SECRETS = new Set(); // filled with tokens from the page and the test accounts' own tokens/passwords
const randomLooking = (v) => v.length >= 24 && /[A-Za-z]/.test(v) && /\d/.test(v) && !/^\d{4}-\d\d-\d\d/.test(v) && !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v);
function redact(text) {
  let out = String(text);
  for (const k of KNOWN_SECRETS) if (k && k.length >= 6) out = out.split(k).join(mask(k));
  return out
    .replace(/[A-Za-z0-9_\-+/=.]{24,}/g, (m) => (randomLooking(m) && !m.includes("…") ? mask(m) : m))
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, (m) => mask(m))
    .replace(/\b(sk_(?:live|test)_|rk_(?:live|test)_|sk-ant-|sk-proj-|sk-|gh[pousr]_|xox[abpr]-|AKIA|AIza|SG\.|re_)[A-Za-z0-9_.-]{6,}/g, (m) => mask(m))
    .replace(/("([A-Za-z0-9_]*)"\s*:\s*")([^"]{6,})(")/g, (m, a, k, v, z) => (SECRET_KEYS.test(k) ? `${a}${mask(v)}${z}` : m))
    .replace(/([?&][A-Za-z0-9_]*(?:token|key|secret|password|session)[A-Za-z0-9_]*=)([^&\s]{6,})/gi, (m, a, v) => a + mask(v));
}

// ---------- polite HTTP: allowed origins only, one at a time, a pause between, a hard cap ----------
let sent = 0, last = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function http(method, url, headers = {}, body) {
  if (!allowed.has(new URL(url).origin)) throw new Error(`blocked: ${new URL(url).origin} is not an allowed target`);
  if (++sent > MAX_REQ) throw new Error(`stopped at maxRequests (${MAX_REQ})`);
  const wait = last + DELAY - Date.now(); if (wait > 0) await sleep(wait);
  last = Date.now();
  try {
    const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: "manual" });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: r.status, text, json };
  } catch (e) { return { status: 0, text: String(e.message || e), json: undefined }; }
}
const ok2xx = (r) => r.status >= 200 && r.status < 300;
const denied = (r) => [401, 403, 404].includes(r.status);
const isEmpty = (r) => r.text.trim() === "" || ["[]", "{}", "null"].includes(r.text.trim());
const errorShaped = (j) => j && typeof j === "object" && !Array.isArray(j) && Object.keys(j).length > 0 && Object.keys(j).every((k) => /^(error|errors|message|msg|code|detail|hint|status|statusCode)$/i.test(k));
const hasData = (r) => ok2xx(r) && !isEmpty(r) && !errorShaped(r.json);
const statusWord = (r) => (ok2xx(r) ? `${r.status}, empty` : String(r.status || "no answer"));
const short = (s, n = 240) => (s.length > n ? s.slice(0, n) + "…" : s);
function jwtClaims(t) { try { return JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()); } catch { return null; } }

// ---------- results ----------
const results = [];
function report(verdict, check, what, proof = []) {
  proof = proof.map(redact); what = redact(what);
  results.push({ verdict, check, what, proof });
  console.log(`\n${verdict.padEnd(6)} ${check}: ${what}`);
  for (const p of proof) console.log(`       ${p}`);
}
const proofOf = (who, method, url, r) => [`> ${method} ${url}  (${who})`, `< ${r.status} ${short(r.text.replace(/\s+/g, " "))}`];

// ---------- 1. secrets in the page code ----------
const THIRD_PARTY = [
  ["Stripe secret key", /\b(sk_live_[0-9A-Za-z]{10,})/g, "FAIL"],
  ["Stripe test secret key", /\b(sk_test_[0-9A-Za-z]{10,})/g, "FAIL"],
  ["Stripe restricted key", /\b(rk_(?:live|test)_[0-9A-Za-z]{10,})/g, "FAIL"],
  ["Anthropic key", /\b(sk-ant-[A-Za-z0-9_-]{20,})/g, "FAIL"],
  ["OpenAI key", /\b(sk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,})/g, "FAIL"],
  ["AWS access key", /\b(AKIA[0-9A-Z]{16})\b/g, "FAIL"],
  ["GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{30,})/g, "FAIL"],
  ["Slack token", /\b(xox[abpr]-[A-Za-z0-9-]{10,})/g, "FAIL"],
  ["Resend key", /\b(re_[A-Za-z0-9]{8,}_[A-Za-z0-9]{10,})/g, "FAIL"],
  ["SendGrid key", /\b(SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})/g, "FAIL"],
  ["Private key", /(-----BEGIN [A-Z ]*PRIVATE KEY-----)/g, "FAIL"],
  ["Google API key", /\b(AIza[0-9A-Za-z_-]{35})\b/g, "INFO"],
];
const NAMED = /\b([A-Za-z0-9_]*(?:secret|token|password|passwd|private|admin|api_?key)[A-Za-z0-9_]*)\s*[:=]\s*['"`]([^'"`\s]{12,})['"`]/gi;

async function fetchBundle() {
  const files = new Map();
  const queue = [BASE + "/", ...(cfg.bundle?.extra || []).map(routeUrl)];
  while (queue.length && files.size < (cfg.bundle?.maxFiles ?? 40)) {
    const url = queue.shift(); if (files.has(url)) continue;
    try { if (new URL(url).origin !== BASE) continue; } catch { continue; }
    const r = await http("GET", url); if (!ok2xx(r)) continue;
    files.set(url, r.text);
    const refs = [...r.text.matchAll(/<script[^>]+src=["']([^"']+)["']/g), ...r.text.matchAll(/<link[^>]+href=["']([^"']+\.m?js[^"']*)["']/g),
      ...r.text.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)["']([^"']+\.m?js)["']/g), ...r.text.matchAll(/["'](\/[^"'\s]+\.m?js)["']/g)].map((m) => m[1]);
    for (const ref of refs) { try { queue.push(new URL(ref, url).href); } catch {} }
  }
  return files;
}

async function scanSecrets(files) {
  const found = { appTokens: [], anonKey: null, supabaseUrl: null };
  for (const [url, text] of files) {
    for (const m of text.matchAll(/["'](https:\/\/[a-z0-9]{20}\.supabase\.co)["']/g)) found.supabaseUrl ??= m[1];
    for (const m of text.matchAll(/\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g)) {
      const c = jwtClaims(m[1]);
      if (c?.role === "anon") { found.anonKey ??= m[1]; continue; }
      if (c?.role === "service_role") report("FAIL", "secret in page code", `Supabase service_role key in ${url}. It skips every database rule. Rotate it now and keep it on the server only.`);
    }
    for (const [name, re, verdict] of THIRD_PARTY) for (const m of text.matchAll(re))
      report(verdict, "secret in page code", verdict === "INFO" ? `${name} ${mask(m[1])} in ${url}. Fine only if it's restricted to your domain in its console.` : `${name} ${mask(m[1])} in ${url}. Anyone who opens your site can copy it. Rotate it and move it to the server. (Reported only, never used.)`);
    for (const m of text.matchAll(NAMED)) {
      const [, name, val] = m;
      if (THIRD_PARTY.some(([, re]) => new RegExp(re.source).test(val)) || /^eyJ/.test(val) || /^(your|xxx|change|example|placeholder)/i.test(val)) continue;
      found.appTokens.push({ name, val, url }); KNOWN_SECRETS.add(val);
      report("FAIL", "secret in page code", `${name} (${mask(val)}) is shipped to every visitor in ${url}.`);
    }
  }
  return found;
}

// ---------- accounts ----------
let ANON = cfg.supabase?.anonKey || null;
let SB = cfg.supabase?.url ? new URL(cfg.supabase.url).origin : null;
const accounts = {};
async function signIn(label, a) {
  if (!a) return null;
  for (const v of [a.password, a.token]) if (v) KNOWN_SECRETS.add(v);
  const bearer = (h) => (h?.authorization || h?.Authorization || "").replace(/^Bearer\s+/i, "") || null;
  if (a.token) return { label, token: a.token, uid: a.userId || jwtClaims(a.token)?.sub, headers: { ...(a.headers || {}), authorization: `Bearer ${a.token}` } };
  if (a.headers) { const t = bearer(a.headers); return { label, token: t, uid: a.userId || (t && jwtClaims(t)?.sub), headers: a.headers }; }
  if (a.email && SB && ANON) {
    const r = await http("POST", `${SB}/auth/v1/token?grant_type=password`, { apikey: ANON, "content-type": "application/json" }, { email: a.email, password: a.password });
    if (!r.json?.access_token) { report("UNSURE", "login", `couldn't sign in test account ${label} (${r.status}). Check the email and password in your config.`); return null; }
    KNOWN_SECRETS.add(r.json.access_token); if (r.json.refresh_token) KNOWN_SECRETS.add(r.json.refresh_token);
    return { label, token: r.json.access_token, uid: r.json.user?.id || jwtClaims(r.json.access_token)?.sub, headers: { authorization: `Bearer ${r.json.access_token}` } };
  }
  report("UNSURE", "login", `account ${label}: give "token", "headers", or email+password with a Supabase project.`);
  return null;
}
const sbHeaders = (acct) => ({ apikey: ANON, authorization: `Bearer ${acct?.token || ANON}`, "content-type": "application/json", prefer: "return=representation" });
const routeHeaders = (acct) => ({ ...(SB && ANON ? { apikey: ANON } : {}), ...(cfg.extraHeaders || {}), ...(acct?.headers || {}) });

// ---------- 2. cross-account routes you list ----------
function overlap(r, base) {
  if (r.text.trim() === base.text.trim()) return 1;
  if (r.json === undefined || base.json === undefined) {
    // plain text or HTML: share of the owner's distinctive words that show up in the other answer
    const words = (t) => new Set((t.match(/[A-Za-z0-9@._-]{5,}/g) || []).map((w) => w.toLowerCase()));
    const wb = words(base.text), wr = words(r.text); if (!wb.size) return null; // nothing distinctive to compare
    let hit = 0; for (const w of wb) if (wr.has(w)) hit++;
    return hit / wb.size;
  }
  const leaves = (j, out = new Set()) => { if (j && typeof j === "object") Object.values(j).forEach((v) => leaves(v, out)); else if (j !== null && j !== undefined && String(j).length > 3) out.add(String(j)); return out; };
  const la = leaves(r.json), lb = leaves(base.json); if (!lb.size) return null;
  let hit = 0; for (const v of lb) if (la.has(v)) hit++;
  return hit / lb.size;
}
async function checkRoutes() {
  for (const rt of cfg.routes || []) {
    const owner = accounts[rt.ownedBy || "b"], other = accounts[rt.ownedBy === "a" ? "b" : "a"];
    const method = (rt.method || "GET").toUpperCase();
    if (method !== "GET") { report("INFO", "route", `${rt.path}: only GET routes are replayed. Test ${method} by hand.`); continue; }
    const path = rt.path.replace("{id}", encodeURIComponent(rt.id)), url = routeUrl(path);
    if (!owner || !other) { report("UNSURE", "route", `${path}: needs both test accounts signed in.`); continue; }
    const base = await http(method, url, routeHeaders(owner));
    if (!hasData(base)) { report("UNSURE", "route", `${path}: the owner (${owner.label}) didn't get the record back, so there's nothing to compare. Check the id and route.`, proofOf(`as ${owner.label}, the owner`, method, url, base)); continue; }
    for (const [who, acct] of [[`as ${other.label}, not the owner`, other], ["logged out", null]]) {
      const r = await http(method, url, routeHeaders(acct));
      const o = hasData(r) ? overlap(r, base) : 0;
      if (o === null) report("UNSURE", "cross-account", `${who} gets an answer at ${path}, and ${owner.label}'s record is too short to compare automatically. Check by hand.`, proofOf(who, method, url, r));
      else if (o >= 0.5) report("FAIL", "cross-account", `${who} gets ${owner.label}'s record at ${path}.`, proofOf(who, method, url, r));
      else if (o > 0) report("UNSURE", "cross-account", `${who} gets part of ${owner.label}'s record at ${path} (${Math.round(o * 100)}% of its values). Check by hand.`, proofOf(who, method, url, r));
      else if (denied(r) || (ok2xx(r) && (isEmpty(r) || errorShaped(r.json)))) report("PASS", "cross-account", `${who} can't get ${owner.label}'s record at ${path} (${statusWord(r)}).`);
      else if (hasData(r)) report("PASS", "cross-account", `${who} gets an answer at ${path}, but none of ${owner.label}'s data is in it (${r.status}).`);
      else report("UNSURE", "cross-account", `${who} at ${path}: got ${statusWord(r)}. An error isn't proof either way.`, proofOf(who, method, url, r));
    }
  }
}

// ---------- 3. admin-only routes ----------
function judgeAdmin(who, p, url, r) {
  if (hasData(r)) report("FAIL", "admin route", `${who} gets data from ${p}.`, proofOf(who, "GET", url, r));
  else if (denied(r) || (ok2xx(r) && (isEmpty(r) || errorShaped(r.json)))) report("PASS", "admin route", `${who} is blocked at ${p} (${statusWord(r)}).`);
  else report("UNSURE", "admin route", `${who} at ${p}: got ${statusWord(r)}. An error isn't proof either way.`, proofOf(who, "GET", url, r));
}
async function checkAdminRoutes(found) {
  for (const p of cfg.adminRoutes || []) {
    const url = routeUrl(p);
    if (accounts.a) judgeAdmin(`as ${accounts.a.label}, a normal user`, p, url, await http("GET", url, routeHeaders(accounts.a)));
    judgeAdmin("logged out", p, url, await http("GET", url, routeHeaders(null)));
    // Your OWN app's tokens found in the page code: do they open this route? Third-party keys are never sent.
    for (const t of found.appTokens) {
      for (const h of ["authorization", "x-api-key", "x-admin-token", "x-access-token", "api-key"]) {
        const r = await http("GET", url, { [h]: h === "authorization" ? `Bearer ${t.val}` : t.val });
        if (hasData(r)) { report("FAIL", "leaked token", `${t.name} from your page code opens ${p} with no login (sent as ${h}).`, proofOf(`token from page code in ${h}, no login`, "GET", url, r)); break; }
      }
    }
  }
}

// ---------- 4. Supabase: who can read and change each table ----------
const OWNER_COLS = ["owner_id", "user_id", "created_by", "author_id", "profile_id", "account_id", "uid"];
const ESCALATE = { role: "admin", is_admin: true, admin: true, is_superuser: true, is_staff: true };
async function supabaseTables() {
  if (cfg.supabase?.tables?.length) return cfg.supabase.tables.map((t) => ({ name: t, pk: null }));
  const r = await http("GET", `${SB}/rest/v1/`, { apikey: ANON, authorization: `Bearer ${ANON}` });
  if (!r.json?.paths) { report("UNSURE", "supabase", `couldn't list tables (${r.status}). Add "tables": [...] under "supabase" in your config.`); return []; }
  return Object.keys(r.json.paths).filter((p) => /^\/[A-Za-z0-9_]+$/.test(p)).map((p) => {
    const name = p.slice(1), props = r.json.definitions?.[name]?.properties || {};
    return { name, pk: Object.keys(props).find((k) => /<pk\/>/.test(props[k].description || "")) || null };
  });
}
const rows = (r) => (Array.isArray(r.json) ? r.json : []);
const q = (t, s) => `${SB}/rest/v1/${t}?${s}`;

async function checkSupabase() {
  const A = accounts.a, Bacct = accounts.b;
  for (const t of await supabaseTables()) {
    // What do A and B see of their own? (Used to find the owner column and to know the table has data.)
    const ra = A ? await http("GET", q(t.name, "select=*&limit=20"), sbHeaders(A)) : null;
    const rb = Bacct ? await http("GET", q(t.name, "select=*&limit=20"), sbHeaders(Bacct)) : null;
    const seen = [...(ra ? rows(ra) : []), ...(rb ? rows(rb) : [])];
    const uids = [A?.uid, Bacct?.uid].filter(Boolean);
    const col = OWNER_COLS.find((c) => seen.some((r) => c in r)) ?? (seen.some((r) => uids.includes(r.id)) ? "id" : null);

    // 4a. no login, just the public key
    const anonUrl = q(t.name, "select=*&limit=5");
    const anon = await http("GET", anonUrl, sbHeaders(null));
    const anonOpen = rows(anon).length > 0;
    if (anonOpen && PUBLIC_TABLES.has(t.name)) report("INFO", "open table", `"${t.name}" is readable by anyone, and your config says that's on purpose.`);
    else if (anonOpen) report("FAIL", "open table", `anyone with your public key can read "${t.name}" (no login). Turn on RLS and add owner policies, or list it under supabase.publicTables if it's meant to be public.`, proofOf("public key only, no login", "GET", anonUrl, anon));
    else if (!ok2xx(anon) && !denied(anon)) report("UNSURE", "open table", `"${t.name}" with the public key: got ${statusWord(anon)}.`);
    else if (seen.length) report("PASS", "open table", `"${t.name}" has rows, and none show up with just the public key (${statusWord(anon)}).`);
    else report("UNSURE", "open table", `"${t.name}": no test account sees any rows, so an empty answer proves nothing. Add a test row.`);

    if (!A || !Bacct || !col) {
      if (A && Bacct && !col && seen.length) report("INFO", "cross-account", `"${t.name}": no owner column found (owner_id, user_id…). If rows here belong to one user, check it by hand.`);
      // --writes, no owner column: can someone with only the public key change a row they can read?
      const anyRow = rows(anon)[0], ppk = t.pk || (anyRow && "id" in anyRow ? "id" : null);
      if (WRITES && anyRow && ppk) {
        const field = Object.keys(anyRow).find((k) => k !== ppk && !/(_at|updated|created)$/.test(k));
        if (field) {
          const wurl = q(t.name, `${ppk}=eq.${encodeURIComponent(anyRow[ppk])}`);
          const wa = await http("PATCH", wurl, sbHeaders(null), { [field]: anyRow[field] });
          if (rows(wa).length) report("FAIL", "open table write", `anyone with your public key can change rows in "${t.name}" (wrote the same value back into "${field}").`, proofOf("public key only, no login", "PATCH", wurl, wa));
          else if (ok2xx(wa) || denied(wa)) report("PASS", "open table write", `the public key can't change rows in "${t.name}" (${statusWord(wa)}).`);
          else report("UNSURE", "open table write", `"${t.name}" write with the public key: got ${statusWord(wa)}.`);
        }
      }
      continue;
    }
    // 4b. As A, ask directly for rows that are NOT A's. As B, confirm B really has some.
    const foreignUrl = q(t.name, `select=*&${col}=neq.${encodeURIComponent(A.uid)}&limit=5`);
    const foreign = await http("GET", foreignUrl, sbHeaders(A));
    const bHas = await http("GET", q(t.name, `select=*&${col}=eq.${encodeURIComponent(Bacct.uid)}&limit=1`), sbHeaders(Bacct));
    const bRow = rows(bHas)[0];
    if (!anonOpen && !PUBLIC_TABLES.has(t.name)) {
      if (rows(foreign).length) report("FAIL", "cross-account", `${A.label} can read rows in "${t.name}" that belong to someone else (${col} isn't ${A.label}).`, proofOf(`as ${A.label}`, "GET", foreignUrl, foreign));
      else if (!ok2xx(foreign)) report("UNSURE", "cross-account", `"${t.name}" as ${A.label}: got ${statusWord(foreign)}.`);
      else if (bRow) report("PASS", "cross-account", `${A.label} can't see ${Bacct.label}'s rows in "${t.name}" (asked for them directly, got none).`);
      else report("UNSURE", "cross-account", `"${t.name}": ${Bacct.label} has no rows here, so there's nothing to try to read. Add one test row as ${Bacct.label}.`);
    }
    if (!WRITES) continue;
    const pk = t.pk || (bRow && "id" in bRow ? "id" : null);

    // 4c. --writes: can A change B's row? Writes the row's current value back into one column.
    if (bRow && pk) {
      const field = Object.keys(bRow).find((k) => k !== pk && k !== col && !/(_at|updated|created)$/.test(k));
      if (field) {
        const wurl = q(t.name, `${pk}=eq.${encodeURIComponent(bRow[pk])}`);
        const w = await http("PATCH", wurl, sbHeaders(A), { [field]: bRow[field] });
        if (rows(w).length && PUBLIC_TABLES.has(t.name)) report("FAIL", "cross-account write", `${A.label} can edit ${Bacct.label}'s row in "${t.name}". It's listed as public to READ, but other users shouldn't be able to change it (wrote the same value back into "${field}").`, proofOf(`as ${A.label}`, "PATCH", wurl, w));
        else if (rows(w).length) report("FAIL", "cross-account write", `${A.label} can edit ${Bacct.label}'s row in "${t.name}" (wrote the same value back into "${field}").`, proofOf(`as ${A.label}`, "PATCH", wurl, w));
        else if (ok2xx(w) || denied(w)) report("PASS", "cross-account write", `${A.label} can't edit ${Bacct.label}'s rows in "${t.name}" (${statusWord(w)}).`);
        else report("UNSURE", "cross-account write", `"${t.name}" write as ${A.label}: got ${statusWord(w)}.`);
        if (anonOpen || PUBLIC_TABLES.has(t.name)) {
          const wa = await http("PATCH", wurl, sbHeaders(null), { [field]: bRow[field] });
          if (rows(wa).length) report("FAIL", "open table write", `anyone with your public key can change rows in "${t.name}" (wrote the same value back into "${field}").`, proofOf("public key only, no login", "PATCH", wurl, wa));
        }
      }
    }
    // 4d. --writes: can A promote themselves? Tries it, ALWAYS sends the old value back, then reads it to confirm.
    const aRes = await http("GET", q(t.name, `select=*&${col}=eq.${encodeURIComponent(A.uid)}&limit=1`), sbHeaders(A));
    const aRow = rows(aRes)[0];
    const esc = aRow && Object.keys(ESCALATE).find((k) => k in aRow && aRow[k] !== ESCALATE[k]);
    const apk = t.pk || (aRow && col);
    if (esc && apk) {
      const wurl = q(t.name, `${apk}=eq.${encodeURIComponent(aRow[apk])}`);
      const readUrl = q(t.name, `select=${esc}&${apk}=eq.${encodeURIComponent(aRow[apk])}`);
      const w = await http("PATCH", wurl, sbHeaders(A), { [esc]: ESCALATE[esc] });
      const mid = await http("GET", readUrl, sbHeaders(A));
      const changed = rows(w)[0]?.[esc] === ESCALATE[esc] || rows(mid)[0]?.[esc] === ESCALATE[esc];
      await http("PATCH", wurl, sbHeaders(A), { [esc]: aRow[esc] });
      const after = await http("GET", readUrl, sbHeaders(A));
      const restored = rows(after)[0]?.[esc] === aRow[esc];
      const putBack = restored ? ` Old value put back and checked (${JSON.stringify(aRow[esc])}).` : ` COULD NOT CONFIRM IT'S BACK: set ${t.name}.${esc} to ${JSON.stringify(aRow[esc])} for ${A.label} yourself.`;
      if (changed) report("FAIL", "self-promotion", `${A.label} can set their own "${esc}" to ${JSON.stringify(ESCALATE[esc])} in "${t.name}".${putBack}`, proofOf(`as ${A.label}`, "PATCH", wurl, w));
      else if (ok2xx(w) || denied(w)) report(restored ? "PASS" : "UNSURE", "self-promotion", `${A.label} can't change their own "${esc}" in "${t.name}" (${statusWord(w)}).${restored ? "" : putBack}`);
      else report("UNSURE", "self-promotion", `"${t.name}" role write: got ${statusWord(w)}.${putBack}`);
    }
  }
}

// ---------- run ----------
console.log(`one-number-check on ${BASE}${WRITES ? "  (write tests ON: test data only)" : "  (read-only)"}`);
const files = await fetchBundle();
console.log(`read ${files.size} page/script file(s)`);
const found = await scanSecrets(files);
if (!ANON && found.anonKey) ANON = found.anonKey;
if (!SB && ANON) SB = found.supabaseUrl || null;
if (SB && !allowed.has(SB)) allowOrigin(SB, "Supabase project found in your page");
accounts.a = await signIn("A", cfg.accounts?.a);
accounts.b = await signIn("B", cfg.accounts?.b);
await checkRoutes();
await checkAdminRoutes(found);
if (SB && ANON) await checkSupabase(); else report("INFO", "supabase", "no Supabase project found (set supabase.url and supabase.anonKey if the app uses one).");
if (!WRITES && SB) report("INFO", "write tests", "skipped. Re-run with --writes on test data to check edits and self-promotion to admin.");

const count = (v) => results.filter((r) => r.verdict === v).length;
console.log(`\n${count("FAIL")} hole(s) found, ${count("PASS")} checks passed, ${count("UNSURE")} unsure. ${sent} requests sent.`);
if (count("FAIL")) console.log("Paste the FAIL lines into Claude, Cursor or Lovable with the fix prompt from the README, then run this again.\nRecognised keys and tokens are hidden. Not every secret can be recognised, and your test accounts' data is shown, so read it first and use test data only.");
if (opt("--json")) writeFileSync(opt("--json"), JSON.stringify({ target: BASE, writes: WRITES, results }, null, 2));
process.exit(count("FAIL") ? 1 : 0);
