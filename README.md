# idor-check

**A Claude Code skill that tests your app for IDOR.** Every app stores and checks access differently, so the skill starts from your code: Claude finds the routes and database queries that take an ID, works out who should see what, and then proves each hole with two test accounts. It reports only what it proved, with the request that got in and a fix.

The skill comes with a small helper script, `idor-check.mjs`, that does the proving: it signs in as user A and user B and asks for B's records as A and as a logged-out visitor. It also checks admin routes, Supabase tables open to the public key, users promoting themselves to admin, and secrets shipped in the front-end bundle.

> [!IMPORTANT]
> Only test apps you own or have written permission to test. Use a local or staging copy with throwaway test accounts, never real customer data.

## Use it

Open Claude Code inside your project and paste:

```
Clone https://github.com/Yxsuf1/idor-check and follow the skill in .claude/skills/idor-check/SKILL.md to check this project for IDOR. Use two test accounts on my local or staging copy, show me proof for every hole you find, and only fix things after I say yes.
```

Or install the skill once and ask for it by name:

```bash
git clone https://github.com/Yxsuf1/idor-check
cp -r idor-check/.claude/skills/idor-check your-project/.claude/skills/
```

### What the skill does

1. **Maps access.** Reads how login works, the database rules, and every entry point, then writes down who should see what. It asks you when a rule is unclear, because shared-by-design is not a bug.
2. **Follows every ID** through URL paths, query strings, bodies, server actions and Supabase queries, for reads, edits, deletes, downloads and bulk actions.
3. **Proves it.** Fills in the helper script's config with the routes it found and your two test accounts, runs it read-only, then with write tests on test data if you agree. Routes the script can't replay (POST, file downloads, GraphQL) it tests by hand the same way.
4. **Reports** what it proved, what it saw in the code but didn't run, and what it couldn't decide, each with file, line, evidence and fix.
5. **Fixes only after you say yes**, adds a test where A tries B's records, and runs the check again.

It doesn't deploy or change database rules without asking.

## The helper script

You can also run the script yourself. It's one file, Node 18+, no dependencies, read-only unless you pass `--writes`, and it exits with code 1 when it finds a hole, so it can run in CI against staging.

```bash
cp examples/my-app.json my-app.local.json   # git-ignored; set baseUrl, the two logins and B's record ID
APP_A_PASSWORD=... APP_B_PASSWORD=... node idor-check.mjs --config my-app.local.json
```

Use test passwords of 12+ characters. Add `--writes` on test data to check whether A can edit B's rows or make themselves admin.

### Example output

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

### What it checks

| Check | How |
|---|---|
| Cross-account reads | Loads each configured record as B (the owner), then as A, then logged out, and compares |
| Admin routes | Calls each route in `adminRoutes` as A and logged out |
| Secrets in the bundle | Reads the page and its scripts. Flags Supabase `service_role` keys, Stripe, OpenAI, Anthropic, AWS, GitHub, Slack and email-provider keys, private keys, and named tokens. The app's own tokens are tried against the admin routes; third-party keys are reported, never used |
| Open Supabase tables | Reads each table the Supabase API lists (or `supabase.tables`) with only the anon key. Tables that are public on purpose go in `supabase.publicTables` |
| Supabase cross-account reads | Asks for rows A doesn't own, as A, after confirming B has rows there |
| Cross-account writes (`--writes`) | Writes a row's current value back into one of B's rows, as A |
| Self-promotion (`--writes`) | Sets A's own `role` / `is_admin`, restores it, reads it back to confirm |

### Configuration

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

### Options

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

### Safety

- **Targets.** Every hostname is resolved, and all of its addresses must be loopback or private (127/8, 10/8, 172.16/12, 192.168/16, 0.0.0.0, ::1, fc00::/7) unless you pass `--i-own-this-app`. Cloud metadata addresses (169.254/16) are never treated as private. The checked addresses are pinned and reused for every request, so DNS can't change in between.
- **One origin per consent.** Each request is checked against the configured origins before it is sent. A Supabase project found only in the page is used only if it is local; a hosted one must be in your config.
- **Pace.** One request at a time, 300 ms apart, at most 400 requests.
- **Writes.** Off by default. The edit test writes a row's current value back, so data stays the same, but database triggers and webhooks can still fire. The admin test restores the old role and confirms it; if it can't, it prints exactly what to restore.
- **Redaction.** Recognised keys, tokens and your test passwords are masked in the output and the JSON report. Use 12+ character test passwords so they mask reliably. Not every secret can be recognised, and your test accounts' data is shown as proof, so read the output before sharing it.

### Limitations

The script tests GET routes and Supabase tables. It does not test POST, PUT or DELETE routes, file downloads, GraphQL, or team-to-team access. Test those by hand the same way: A's session, B's ID, change only the ID, then check both the response and what was saved.

A clean run means these checks passed, not that the app is secure.

## Fixing findings

The fix is the same everywhere: the server takes the user from the verified session, and checks that the user may read or change that specific record before doing it.

- Never trust a user ID, team ID or role sent from the browser.
- For updates, put the ownership check in the query itself (`where id = ? and owner_id = ?`).
- Supabase: enable RLS on every table, drop `using (true)` policies on private tables (policies combine with OR), add select, insert, update and delete policies tied to `auth.uid()`, use `with check` on updates, and keep `service_role` on the server.

Then add a test that signs in as A and tries B's records, and run the check again.

A step-by-step walkthrough, including manual testing in the browser: [How to test your app for IDOR](https://vaultxsec.com/guides/how-to-test-for-idor/).

## Development

```bash
npm test
```

The tests run idor-check against a small correctly-secured app (expects zero holes, with and without `--writes`) and a leaky copy (expects every hole, no tokens in the output, and the role restored). They also check that a server error is never a pass, and that public, mixed and metadata addresses and off-host routes are refused.

## License

MIT

Built by VXSec · [vaultxsec.com](https://vaultxsec.com)
