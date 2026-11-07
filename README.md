# idor-check

**Test a web app for IDOR with two test accounts.** idor-check signs in as user A and user B, then asks for B's records as A and as a logged-out visitor. If the server hands them over, you get the exact request and response as proof.

It also checks admin-only routes, Supabase tables that the public anon key can read or write, users promoting themselves to admin, and secrets shipped in the front-end bundle.

- One file, no dependencies, Node 18+
- Read-only by default; write tests only with `--writes`
- Talks only to local or private addresses unless you pass `--i-own-this-app`
- Exit code 1 when it finds a hole, so it can run in CI against staging

> [!IMPORTANT]
> Only test apps you own or have written permission to test. Use a local or staging copy with throwaway test accounts, never real customer data.

## Quick start

```bash
git clone https://github.com/Yxsuf1/idor-check
cd idor-check
cp examples/my-app.json my-app.local.json   # git-ignored
```

1. Run your app locally or on staging. Sign up two test accounts, A and B, with passwords of 12+ characters.
2. As B, create something private (an invoice, a note, an upload) and copy its ID.
3. In `my-app.local.json`, set `baseUrl`, the two logins under `accounts`, and B's ID under `routes`.
4. Run it:

```bash
APP_A_PASSWORD=... APP_B_PASSWORD=... node idor-check.mjs --config my-app.local.json
```

On test data, add `--writes` to also test whether A can edit B's rows or make themselves admin.

## Example output

From a run against a deliberately vulnerable Supabase test app:

```
idor-check on http://127.0.0.1:8787  (write tests ON: test data only)

FAIL   cross-account: as A, not the owner gets B's record at /rest/v1/invoices?id=eq.3.
       > GET http://127.0.0.1:8787/rest/v1/invoices?id=eq.3  (as A, not the owner)
       < 200 [{"id":3,"owner_id":"2222…","customer":"Bob Client Fake","amount_cents":99000,...}]

PASS   cross-account: logged out can't get B's record at /rest/v1/invoices?id=eq.3 (200, empty).

FAIL   self-promotion: A can set their own "role" to "admin" in "members". Old value put back and checked ("user").
       > PATCH http://127.0.0.1:8787/rest/v1/members?user_i…1111  (as A)
       < 200 [{"user_id":"1111…","role":"admin"}]

PASS   cross-account: A can't see B's rows in "notes" (asked for them directly, got none).

11 hole(s) found, 11 checks passed, 0 unsure. 54 requests sent.
```

| Result | Meaning |
|---|---|
| `FAIL` | A hole, shown with the request that got in and the first 240 characters of the response |
| `PASS` | Blocked |
| `UNSURE` | No verdict: server error, login failed, wrong ID, B has no rows there, or A got data that doesn't match B's. Never counted as a pass |
| `INFO` | Worth knowing, not a finding |

## What it checks

| Check | How |
|---|---|
| Cross-account reads | Loads each configured record as B (the owner), then as A, then logged out, and compares |
| Admin routes | Calls each route in `adminRoutes` as A and logged out |
| Secrets in the bundle | Reads the page and its scripts. Flags Supabase `service_role` keys, Stripe, OpenAI, Anthropic, AWS, GitHub, Slack and email-provider keys, private keys, and named tokens. The app's own tokens are tried against the admin routes; third-party keys are reported, never used |
| Open Supabase tables | Reads each table the Supabase API lists (or `supabase.tables`) with only the anon key. Tables that are public on purpose go in `supabase.publicTables` |
| Supabase cross-account reads | Asks for rows A doesn't own, as A, after confirming B has rows there |
| Cross-account writes (`--writes`) | Writes a row's current value back into one of B's rows, as A |
| Self-promotion (`--writes`) | Sets A's own `role` / `is_admin`, restores it, reads it back to confirm |

## Configuration

```json
{
  "baseUrl": "http://localhost:3000",
  "accounts": {
    "a": { "email": "test-a@example.com", "password": "${APP_A_PASSWORD}" },
    "b": { "email": "test-b@example.com", "password": "${APP_B_PASSWORD}" }
  },
  "routes": [
    { "path": "/api/invoices/{id}", "id": "B'S-RECORD-ID", "ownedBy": "b" }
  ],
  "adminRoutes": ["/api/admin/users"],
  "supabase": {}
}
```

| Field | |
|---|---|
| `baseUrl` | Your app's local or staging address |
| `accounts.a`, `accounts.b` | `email` + `password` (Supabase sign-in), a `token`, or raw `headers`. `${NAME}` is read from the environment |
| `routes` | Routes that take an ID, with one of B's real IDs. Paths must stay on `baseUrl` |
| `adminRoutes` | Routes only admins should reach |
| `supabase.url`, `supabase.anonKey` | Optional. Found in the page automatically when the project is local; a hosted project must be listed here |
| `supabase.publicTables` | Tables meant to be readable by anyone |
| `maxRequests`, `delayMs` | Request cap (default 400) and pause between requests (default 300 ms) |

`examples/supabase-two-accounts.json` is a full Supabase example.

## Options

```
node idor-check.mjs --config <file> [--writes] [--i-own-this-app] [--json <report.json>] [--delay <ms>]
```

| Flag | |
|---|---|
| `--config` | Config file (required) |
| `--writes` | Run the write and self-promotion tests. Test data only |
| `--i-own-this-app` | Allow targets that resolve to public addresses |
| `--json` | Also write the results as JSON |
| `--delay` | Milliseconds between requests |

## Safety

- **Targets.** Every hostname is resolved, and all of its addresses must be loopback or private (127/8, 10/8, 172.16/12, 192.168/16, 0.0.0.0, ::1, fc00::/7) unless you pass `--i-own-this-app`. Cloud metadata addresses (169.254/16) are never treated as private. The checked addresses are pinned and reused for every request, so DNS can't change in between.
- **One origin per consent.** Each request is checked against the configured origins before it is sent. A Supabase project found only in the page is used only if it is local; a hosted one must be in your config.
- **Pace.** One request at a time, 300 ms apart, at most 400 requests.
- **Writes.** Off by default. The edit test writes a row's current value back, so data stays the same, but database triggers and webhooks can still fire. The admin test restores the old role and confirms it; if it can't, it prints exactly what to restore.
- **Redaction.** Recognised keys, tokens and your test passwords are masked in the output and the JSON report. Use 12+ character test passwords so they mask reliably. Not every secret can be recognised, and your test accounts' data is shown as proof, so read the output before sharing it.

## Limitations

idor-check tests GET routes and Supabase tables. It does not test POST, PUT or DELETE routes, file downloads, GraphQL, or team-to-team access. Test those by hand the same way: A's session, B's ID, change only the ID, then check both the response and what was saved.

A clean run means these checks passed, not that the app is secure.

## Fixing findings

The fix is the same everywhere: the server takes the user from the verified session, and checks that the user may read or change that specific record before doing it.

- Never trust a user ID, team ID or role sent from the browser.
- For updates, put the ownership check in the query itself (`where id = ? and owner_id = ?`).
- Supabase: enable RLS on every table, drop `using (true)` policies on private tables (policies combine with OR), add select, insert, update and delete policies tied to `auth.uid()`, use `with check` on updates, and keep `service_role` on the server.

Then add a test that signs in as A and tries B's records, and run idor-check again.

A step-by-step walkthrough, including manual testing in the browser: [How to test your app for IDOR](https://vaultxsec.com/guides/how-to-test-for-idor/).

## Claude Code skill

`.claude/skills/idor-check/SKILL.md` is a Claude Code skill. Copy it into your project's `.claude/skills/` and ask Claude Code to check the app for IDOR. It maps who should see what from your code, follows every ID through the handlers and database rules, runs idor-check with two test accounts, and reports only what it proved. It does not deploy or change database rules without asking.

## Development

```bash
npm test
```

The tests run idor-check against a small correctly-secured app (expects zero holes, with and without `--writes`) and a leaky copy (expects every hole, no tokens in the output, and the role restored). They also check that a server error is never a pass, and that public, mixed and metadata addresses and off-host routes are refused.

## License

MIT

Built by VXSec · [vaultxsec.com](https://vaultxsec.com)
