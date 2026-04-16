# aistudio-auto-login

Batch-login Google accounts into AI Studio and export each one as a Playwright
`storageState` JSON (cookies + localStorage for `aistudio.google.com` and
`gemini.google.com`).

Built on a record-and-replay engine: you record one happy-path login by hand,
then the replayer drives every account in a CSV through the same flow,
auto-routing per page and prompting you to take over only on pages it has
never seen before.

## Requirements

- Node.js >= 18
- ~300 MB disk for the bundled Chromium (downloaded by `npm install`)

## Install

```bash
npm install
```

The `postinstall` hook downloads Chromium via `patchright install chromium`.
If it fails (network), run it manually:

```bash
npx patchright install chromium
```

## Files

| Path | Purpose |
|---|---|
| `record.js` | Records a login flow into `flows/login.json`. Run once. |
| `replay.js` | Drives every CSV row through the recorded flow. |
| `flows/login.json` | The recorded flow (main steps + named branches). Editable JSON. |
| `users.csv` | Your account list. Format: `email,password,recovery_email` per line. |
| `auth/auth-N.json` | Output: one Playwright storage state per successful login. |
| `failed.csv` | Output: accounts that could not be logged in, with reason. |
| `.browser-profile/` | Persistent Chromium profile used by the recorder only. |

## Quick start

1. Copy the example CSV and fill in your accounts:
   ```bash
   cp users.csv.example users.csv
   ```
2. Drop your accounts in. Each line: `email,password,recovery_email`. The
   parser finds the first column containing `@` and uses the next two columns
   as password and recovery email. Recovery email is optional but required
   for any account that hits the "confirm recovery email" challenge.

3. Run replay:
   ```bash
   node replay.js
   ```

   Optional args: `node replay.js [csvPath] [flowName]`

## Recording a new flow (only needed if the bundled flow stops working)

```bash
rm -rf .browser-profile        # start clean so Google shows the login page
node record.js
```

The browser opens. Walk through one full login by hand, including any
challenge pages you want to teach the replayer. When you reach
`prompts/new_chat`, return to the terminal and press `Ctrl+C`. The recording
is saved to `flows/login.json`.

The recorder masks emails to `__EMAIL__` and passwords to `__PASSWORD__` in
the saved file, so the flow JSON is safe to share or commit.

## How replay works

Each account gets a fresh, throwaway Chromium profile (no shared cookies).
The replayer enters a state machine:

1. **Branch match (DOM/URL)** — pre-defined branches handle special pages
   like the "confirm recovery email" page or the AI Studio agreements modal.
2. **Success URL** — `aistudio.google.com/...` (excluding `/welcome`) →
   extract `auth-N.json` and the account is done.
3. **Recorded segment** — the linear `main` flow is split by URL into
   segments. The replayer picks the segment whose entry URL matches the
   current page and runs it.
4. **Manual takeover** — if no segment or branch matches, the browser shows
   a red "MANUAL TAKEOVER" banner and the terminal prompts:
   - `s` skip this account (records the URL as a skip-branch — future
     accounts hitting the same URL will be skipped automatically with the
     reason you supply)
   - `b` record a branch (operate the browser, press Enter when done — the
     events become a new branch and are auto-applied to future accounts)
   - `c` continue once (operate, no save)
   - `q` quit replay

## Built-in branches

The bundled `flows/login.json` already handles:

- `challenge_iap_phone_only` — phone-only verification → skip account
- `aistudio_agreements` — AI Studio "I acknowledge" modal → tick + Continue

Add your own by running replay and pressing `b` when something new appears.

## Click resolution strategy

The replayer tries multiple strategies for every recorded click, in order:

1. Recorded selector + `filter({hasText: '...'})` (most specific)
2. Recorded selector only (with `force:true` fallback for hidden Material
   checkbox inputs)
3. `getByRole('button'|'link', { name: text })` (handles dynamic jsname
   attributes and a/b tests)
4. `getByText`

Each strategy probes whether the locator is attached for 1.5s before clicking,
so missed selectors fall through fast instead of burning the full timeout.

## Caveats

- **Locale**: the bundled flow was recorded with a Chinese-locale Google
  login. Buttons named "下一步", "Save", "Skip" etc are baked into the click
  fallback. If your accounts default to English, button text fallbacks like
  `下一步` will miss — the recorded selectors should still work, but you may
  want to re-record once.
- **`users.csv` and `auth/` contain credentials** — keep them off disk
  backups, off git, off shared drives.
- **Phone verification**: accounts that only support phone (no recovery
  email option) are auto-skipped via the `challenge_iap_phone_only` branch
  and logged in `failed.csv`.
- **Headed only**: the recorder requires a headed browser. The replayer is
  also headed by default so you can manually take over when needed.
