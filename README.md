# one-number-check

In the video I changed one number in a link and got a stranger's bank statement. This kit checks your own app for that bug and the ones that usually come with it, and gives you proof and a fix.

Yusuf | VXSec · vaultxsec.com · @vaultxsec

This is the free check. Want the full test done for you, with proof, fixes and retests? Join the waitlist: [vaultxsec.com/hack-my-app](https://vaultxsec.com/hack-my-app)

It's three things:

- **`one-number-check.mjs`**: a script that logs in as two test users and tries to get one user's data as the other. It also checks which Supabase tables anyone can read, whether a normal user can reach admin routes, and whether your page code ships secrets. Node 18+, nothing to install.
- **A Claude Code skill** (`.claude/skills/one-number-check/`): drop it in your project and ask Claude to check your app. It reads your code, follows every ID, runs the script, and reports only what it proved.
- **The guide** (`guide/one-number-hack.pdf`): the bug in one line, "Let Claude do it" in one paste, "Do it yourself" in five minutes, and the fix prompt for Claude, Cursor or Lovable.

**Only test apps you own or have written permission to test.** Use a local or staging copy and throwaway accounts, never real customer data. The script only talks to local and private-network addresses unless you pass `--i-own-this-app`, and every request is checked against the addresses in your config before it goes out.

## 5 minutes

1. Run your app locally (or on staging). Sign up two test accounts, A and B. As B, create something private: an invoice, a note, an upload. Copy its ID.
2. Copy the example config and fill it in:

   ```
   cp examples/my-app.json my-app.local.json
   ```

   Put your app's address in `baseUrl`, the two test logins under `accounts`, and B's ID under `routes`. List routes that should be admin-only under `adminRoutes`. On Supabase the script finds your project and public key in the page by itself.
3. Run it:

   ```
   APP_A_PASSWORD=... APP_B_PASSWORD=... node one-number-check.mjs --config my-app.local.json
   ```

4. Read the result. Every **FAIL** comes with the request that got in and the start of what came back (first 240 characters):

   ```
   FAIL   cross-account: as A, not the owner gets B's record at /rest/v1/invoices?id=eq.3.
          > GET http://127.0.0.1:8787/rest/v1/invoices?id=eq.3  (as A, not the owner)
          < 200 [{"id":3,"owner_id":"2222…","customer":"Bob Client Fake","amount_cents":99000,...}]
   ```

   **PASS** means it was blocked. **UNSURE** means the test couldn't decide (a server error, wrong ID, B has no rows in that table, login failed). An error is never counted as a pass. Fix the setup and run it again.

   Keys and tokens it recognises are hidden in the output and in `--json` reports: known key formats, secret-named fields, tokens found in your page, your test accounts' own logins, and long random-looking strings. It can't recognise every secret, and your test accounts' data is shown as proof, so use test data only and read the output before you paste it anywhere.
5. On test data, run it again with `--writes` to check whether A can edit B's rows and whether A can make themselves admin. The edit test writes a row's current value back into it. That leaves the data as it was, but it can still set off database triggers or webhooks, so use test data. The admin test changes A's own role, always sends the old value back, then reads it again to confirm. If it can't confirm, it tells you exactly what to restore.

The exit code is 1 when there's a hole, so you can put it in CI against staging.

## What it checks

| Check | How |
|---|---|
| One user reads another's record | Loads B's record as B, then as A, then logged out, and compares |
| Normal user on admin routes | Calls each admin route as A and logged out |
| Secrets in the page code | Reads your page and its scripts. Flags Supabase service_role keys, Stripe, OpenAI, Anthropic, AWS, GitHub, Slack, email keys, private keys, and named tokens or secrets. Your own app's tokens are tried against your admin routes to show what they open. Third-party keys are never used. |
| Supabase tables open to anyone | Reads every table with just the public anon key. Tables meant to be public go under `supabase.publicTables` |
| A sees B's rows (Supabase) | Asks for rows not owned by A, as A, and checks B really has rows there |
| A edits B's rows (`--writes`) | Writes a row's current value back into one of B's rows as A |
| A promotes themselves (`--writes`) | Sets A's own `role` / `is_admin`, puts it back, reads it to confirm |

It goes slowly on purpose: one request at a time, 300 ms apart, at most 400 requests. Change that with `--delay` and `maxRequests`.

What it doesn't do: test POST, PUT and DELETE routes, file downloads, GraphQL, or team-to-team access. Test those by hand the same way: A's session, B's ID, change only the ID. The skill walks Claude through it.

## Fix it

Paste the FAIL lines into Claude, Cursor or Lovable with this (read them first: recognised keys are hidden, not every secret is):

```
Go through every route, API endpoint, server action and database query in this app
that takes an ID or record key from the user (URL, query string, body, headers).
For each one, make sure the server checks that the logged-in user owns that record
(or is allowed to see it) before reading, updating or deleting it. Never trust an
ID or user id sent from the browser. If this app uses Supabase, enable Row Level
Security on every table, drop or rewrite every existing policy that allows all rows
(for example using (true)), since policies combine with OR, and make select, insert,
update and delete policies tied to auth.uid(). List every place you changed and
every place you couldn't confirm.
Then write a test that logs in as user A and tries to read, edit and delete
user B's records, and make it pass.
```

Then run the script again. Don't take the AI's word for it.

The short version, for you or for Claude, is in `guide/one-number-hack.pdf`.

## Use it with Claude Code

Copy `.claude/skills/one-number-check/` into your project's `.claude/skills/` and ask: "check this app for the one-number hack". Claude reads your routes and database rules, sets up the config with you, runs the script, and gives you proven findings with fixes. It won't deploy or change your database rules without asking.

## Tests

`npm test` runs the script against a small fake app set up correctly (expects zero holes, with and without `--writes`) and a leaky copy of it (expects the holes, no tokens in the output, and the role put back). It also checks that a server error never counts as a pass and that public addresses and routes that leave your app are refused. Before release it was also run against a deliberately broken app with five planted holes and one correctly set-up table: it caught all five and left the good table alone.

## Want someone to test it for you?

vaultxsec.com

MIT license.
