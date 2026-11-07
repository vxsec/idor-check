# idor-check

**Instructions and a test script that let your AI coding agent check your app for IDOR and fix it.** Paste this into an agent that can run commands (for example Claude Code, Cursor or Codex) inside your project:

```
Read https://github.com/Yxsuf1/idor-check and follow its AGENTS.md to check this app for IDOR. Show me proof for anything you find, and fix it after I say yes.
```

IDOR is when one user can read or change another user's data by changing an ID. Every app checks access differently, so there is no one-size scanner for it. This repo gives your agent a procedure that starts from your code instead:

1. **Map access.** The agent reads how login works, your database rules, and every route, server action and query that takes an ID, and writes down who should see what. It asks you when a rule is unclear, because shared-by-design is not a bug.
2. **Prove it.** It runs `idor-check.mjs` with two throwaway test accounts on your local or staging copy: signed in as user A, it asks for user B's records, and does the same logged out. Routes the script can't replay (POST, downloads, GraphQL) it tests by hand the same way.
3. **Report.** Proven holes come with the request that got in and what came back. What it saw in the code but couldn't run, and what it couldn't decide, are listed separately.
4. **Ask, fix, re-test.** It changes nothing until you say yes. Then it fixes the code or database rules, adds a test where A tries B's records, and re-runs the same checks to show each hole now refused.

It never deploys. The procedure is in [AGENTS.md](AGENTS.md), the shared instructions file many coding agents read; `CLAUDE.md` points there too. Tested with Claude Code.

> [!IMPORTANT]
> Only test apps you own or have written permission to test. Use a local or staging copy with throwaway test accounts, never real customer data.

### Install as a Claude Code skill

Optional. To keep it in a project, copy the skill folder; it fetches the script itself when it runs:

```bash
git clone https://github.com/Yxsuf1/idor-check
cp -r idor-check/.claude/skills/idor-check your-project/.claude/skills/
```

Then ask Claude Code to "check this app for IDOR".

### Testing by hand

No coding agent? [How to test your app for IDOR](https://vaultxsec.com/guides/how-to-test-for-idor/) walks through a five-minute two-account test, a Supabase RLS check, and a fix prompt you can give any AI coding tool.

## The helper script

`idor-check.mjs` is what the agent runs in step 2. You can also run it yourself. It's one file, Node 18+, no dependencies, read-only unless you pass `--writes`, and it exits with code 1 when it finds a hole, so it can run in CI against staging.

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

## Development

```bash
npm test
```

The tests run idor-check against a small correctly-secured app (expects zero holes, with and without `--writes`) and a leaky copy (expects every hole, no tokens in the output, and the role restored). They also check that a server error is never a pass, and that public, mixed and metadata addresses and off-host routes are refused.

## License

MIT

Built by VXSec · [vaultxsec.com](https://vaultxsec.com)
