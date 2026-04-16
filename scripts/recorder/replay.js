/*
 * Replay: takes a recorded flow JSON and runs it for every account in a CSV.
 *
 * Architecture: state-machine, not linear playback.
 *   loop:
 *     1. landed on aistudio (success) → extract auth.json, done
 *     2. current URL matches a known branch → run that branch
 *        (branch.action = "skip-account" | "events")
 *     3. main flow has a next step whose selector is in the page → execute it
 *     4. unknown state → MANUAL TAKEOVER
 *        - inject red banner into the page
 *        - install the same listener bundle as record.js
 *        - prompt the operator on the terminal:
 *            [s] skip this account (records URL as skip-branch)
 *            [b] save the manual operations as a new branch (auto-applied next time)
 *            [c] continue once (no save)
 *            [q] quit
 *
 * Flow file structure (auto-migrated from the old linear array format):
 *   {
 *     "main":     [event, event, ...],       // recorded happy-path
 *     "branches": [
 *       { "id": "challenge_recovery",
 *         "match": { "urlIncludes": "/challenge/recovery" },
 *         "action": "events",
 *         "events": [...] },
 *       { "id": "challenge_phone",
 *         "match": { "urlIncludes": "/challenge/iap" },
 *         "action": "skip-account",
 *         "reason": "phone-only verification" }
 *     ]
 *   }
 *
 * CSV format: each line `email,password[,recovery_email]`. Lines without
 * "@" are skipped (so a header or comment row is fine). The recovery column
 * fills the __RECOVERY__ placeholder; if a step needs __RECOVERY__ but the
 * account has none, the account is skipped.
 *
 * Usage:
 *   node scripts/recorder/replay.js [csvPath] [flowName]
 *   defaults: csvPath = users.csv, flowName = login
 */

const { chromium } = require("patchright");
const path = require("path");
const fs = require("fs");
const os = require("os");
const readline = require("readline");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const FLOWS_DIR = path.join(__dirname, "flows");
const AUTH_DIR = path.join(PROJECT_ROOT, "configs", "auth");
const FAILED_CSV = path.join(__dirname, "failed.csv");

const CSV_PATH = path.resolve(process.argv[2] || path.join(PROJECT_ROOT, "users.csv"));
const FLOW_NAME = process.argv[3] || "login";
const FLOW_PATH = path.join(FLOWS_DIR, `${FLOW_NAME}.json`);

const GOOGLE_DOMAIN_PATTERNS = [
    "google.com",
    "googleusercontent.com",
    "gstatic.com",
    "googleapis.com",
];

const STEP_TIMEOUT = 15_000;
const STEP_PROBE_TIMEOUT = 4_000; // shorter probe used by main-loop step selection
const MAX_LOOP_STEPS = 80;
const POLL_MS = 250;

// ---------- listener bundle (copy of record.js's INSTALL_SCRIPT) ----------

const INSTALL_SCRIPT = `
(() => {
  if (window.__rec_installed) return { already: true };
  window.__rec_installed = true;
  window.__rec_queue = [];

  const EMAIL_RE = /[\\w.+-]+@[\\w-]+\\.[\\w.-]+/;

  function getSelector(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id && !/^[0-9]/.test(el.id) && !/[\\s:]/.test(el.id)) {
      return '#' + CSS.escape(el.id);
    }
    for (const attr of ['name', 'aria-label', 'jsname', 'data-testid', 'data-id', 'role']) {
      const v = el.getAttribute(attr);
      if (v) return el.tagName.toLowerCase() + '[' + attr + '="' + CSS.escape(v) + '"]';
    }
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 6) {
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const sib = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
        if (sib.length > 1) part += ':nth-of-type(' + (sib.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  }

  function maskValue(el, value) {
    if (value == null || value === '') return value;
    if (el && el.type === 'password') return '__PASSWORD__';
    if (EMAIL_RE.test(value)) return '__EMAIL__';
    return value;
  }

  function emit(ev) {
    ev.t = Date.now();
    window.__rec_queue.push(ev);
  }

  function flushActiveValue() {
    const el = document.activeElement;
    if (!el || !('value' in el) || !el.value) return;
    emit({
      type: 'fill',
      selector: getSelector(el),
      value: maskValue(el, el.value),
      url: location.href,
    });
  }

  document.addEventListener('mousedown', (e) => {
    flushActiveValue();
    const el = e.target;
    emit({
      type: 'click',
      selector: getSelector(el),
      tag: el && el.tagName,
      text: ((el && (el.innerText || el.textContent)) || '').trim().slice(0, 80),
      url: location.href,
    });
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    flushActiveValue();
    emit({
      type: 'press',
      key: 'Enter',
      selector: getSelector(e.target),
      url: location.href,
    });
  }, true);

  // Click handler for checkboxes — mousedown on a label/wrapper does not
  // always fire on the checkbox itself. Capture explicit change too.
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el && el.type === 'checkbox') {
      emit({
        type: 'click',
        selector: getSelector(el),
        text: 'checkbox=' + el.checked,
        url: location.href,
      });
    }
  }, true);

  emit({ type: 'ready', url: location.href });
  return { ok: true };
})();
`;

const DRAIN_SCRIPT = `(() => { const q = window.__rec_queue || []; window.__rec_queue = []; return q; })()`;

// ---------- flow load/save ----------

function loadFlow(filePath) {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (Array.isArray(raw)) {
        return { main: raw, branches: [] };
    }
    return {
        main: Array.isArray(raw.main) ? raw.main : [],
        branches: Array.isArray(raw.branches) ? raw.branches : [],
    };
}

function saveFlow(filePath, flow) {
    fs.writeFileSync(filePath, JSON.stringify(flow, null, 2));
}

// ---------- CSV ----------

function parseCsv(content) {
    const out = [];
    for (const raw of content.split(/\r?\n/)) {
        if (!raw.trim()) continue;
        const cols = raw.split(",").map((c) => c.trim());
        const i = cols.findIndex((c) => c.includes("@"));
        if (i === -1) continue;
        const email = cols[i];
        const password = cols[i + 1] || "";
        const recovery = cols[i + 2] || "";
        if (email && password) out.push({ email, password, recovery });
    }
    return out;
}

// ---------- auth extraction (mirrors src/auth/ScreencastAuth.js) ----------

function nextAuthIndex() {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const used = new Set(
        fs.readdirSync(AUTH_DIR).filter((f) => /^auth-\d+\.json$/.test(f)),
    );
    let i = 0;
    while (used.has(`auth-${i}.json`)) i++;
    return i;
}

async function readPageLocalStorage(page) {
    /* eslint-disable no-undef */
    return page.evaluate(() => {
        const items = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            items.push({ name: k, value: localStorage.getItem(k) });
        }
        return items;
    });
    /* eslint-enable no-undef */
}

async function extractStorageState(context, page, accountName) {
    if (!page.url().includes("aistudio.google.com")) {
        await page.goto("https://aistudio.google.com", {
            waitUntil: "domcontentloaded",
            timeout: 30000,
        });
    }
    const aistudioLocalStorage = await readPageLocalStorage(page).catch(() => []);

    await page.goto("https://gemini.google.com", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
    });
    const geminiLocalStorage = await readPageLocalStorage(page).catch(() => []);

    const allCookies = await context.cookies();
    const googleCookies = allCookies.filter((c) => {
        const d = c.domain || "";
        return GOOGLE_DOMAIN_PATTERNS.some((p) => d.includes(p));
    });

    const state = {
        accountName,
        cookies: googleCookies,
        origins: [
            { localStorage: aistudioLocalStorage, origin: "https://aistudio.google.com" },
            { localStorage: geminiLocalStorage, origin: "https://gemini.google.com" },
        ],
    };

    const lineCount = JSON.stringify(state, null, 2).split("\n").length;
    if (lineCount <= 100) {
        throw new Error(`auth state looks incomplete (${lineCount} lines)`);
    }
    return state;
}

// ---------- branch helpers ----------

function pathKey(url) {
    try {
        const u = new URL(url);
        return u.host + u.pathname;
    } catch (_) {
        return url;
    }
}

// Split the linear main events into URL-keyed segments. Every "nav" event
// starts a new segment whose entryUrl is that nav's URL; subsequent
// click/fill/press events belong to that segment until the next nav.
//
// Adjacent navs with the same host+pathname (Google often reloads the same
// URL with new query tokens like dsh/TL/ifkv) are merged so events span the
// full visit. Segments with zero actionable events are dropped.
function splitMainIntoSegments(main) {
    const segments = [];
    let cur = { entryUrl: null, events: [] };
    for (const ev of main) {
        if (ev.type === "nav") {
            if (cur.entryUrl && pathKey(cur.entryUrl) === pathKey(ev.url)) {
                // same logical page — keep filling current segment
                continue;
            }
            if (cur.events.length || cur.entryUrl != null) segments.push(cur);
            cur = { entryUrl: ev.url, events: [] };
        } else if (ev.type !== "ready") {
            cur.events.push(ev);
        }
    }
    if (cur.events.length) segments.push(cur);
    return segments.filter((s) => s.events.length);
}

// Match a recorded segment against the current page URL. Compares host and
// the first 4 path segments — robust against query strings and trailing ids.
function findMatchingSegmentIdx(segments, currentUrl) {
    let curU;
    try {
        curU = new URL(currentUrl);
    } catch (_) {
        return -1;
    }
    const curPath = curU.pathname.split("/").filter(Boolean).slice(0, 4).join("/");
    let best = -1;
    let bestDepth = -1;
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (!seg.entryUrl) continue;
        let segU;
        try {
            segU = new URL(seg.entryUrl);
        } catch (_) {
            continue;
        }
        if (segU.host !== curU.host) continue;
        const segPath = segU.pathname.split("/").filter(Boolean).slice(0, 4).join("/");
        // exact path prefix match (current path starts with segment path)
        if (curPath === segPath || curPath.startsWith(segPath + "/")) {
            if (segPath.length > bestDepth) {
                best = i;
                bestDepth = segPath.length;
            }
        }
    }
    return best;
}

async function findMatchingBranch(page, flow, url) {
    for (const b of flow.branches) {
        const m = b.match || {};
        // url filter (optional — empty/missing means accept any URL)
        if (m.urlIncludes && !url.includes(m.urlIncludes)) continue;
        // dom filter (optional — required: element exists in the DOM).
        // Use 'attached' rather than 'visible' because Material Design hides
        // checkbox inputs via opacity:0/absolute positioning — they're in the
        // DOM but isVisible() returns false. The wrapper is what's painted.
        if (m.domSelector) {
            try {
                await page.locator(m.domSelector).first().waitFor({ state: "attached", timeout: 1500 });
            } catch (_) {
                continue;
            }
        }
        // need at least one filter to match anything
        if (!m.urlIncludes && !m.domSelector) continue;
        return b;
    }
    return null;
}

function isSuccessUrl(url) {
    try {
        const u = new URL(url);
        if (u.host !== "aistudio.google.com") return false;
        if (u.pathname.startsWith("/welcome")) return false;
        if (u.pathname.startsWith("/u/0/welcome")) return false;
        return true;
    } catch (_) {
        return false;
    }
}

function makeBranchId(url) {
    try {
        const u = new URL(url);
        const segs = u.pathname.split("/").filter(Boolean);
        const tail = segs.slice(-3).join("_") || "page";
        return tail.replace(/[^a-z0-9_]/gi, "_").slice(0, 40);
    } catch (_) {
        return "branch_" + Date.now();
    }
}

function deriveUrlMatch(url) {
    try {
        const u = new URL(url);
        // Take up to 5 path segments. Google's challenge URLs need this depth
        // to distinguish /v3/signin/challenge/pwd vs /challenge/iap vs /challenge/recoveryemail.
        const segs = u.pathname.split("/").filter(Boolean).slice(0, 5);
        return u.host + "/" + segs.join("/");
    } catch (_) {
        return url.split("?")[0];
    }
}

// ---------- step execution ----------

class RecoveryMissing extends Error {
    constructor() {
        super("__RECOVERY__ placeholder used but account has no recovery email");
        this.code = "RECOVERY_MISSING";
    }
}

function substituteValue(value, account) {
    if (value === "__EMAIL__") return account.email;
    if (value === "__PASSWORD__") return account.password;
    if (value === "__RECOVERY__") {
        if (!account.recovery) throw new RecoveryMissing();
        return account.recovery;
    }
    return value;
}

// tryClick: probe whether a locator is attached within probeMs, and if so
// click it within clickMs. Returns true on success, an Error on click failure,
// or null if the locator never showed up (so the caller can fall through to
// the next strategy quickly without burning the full click timeout).
async function tryClick(locator, probeMs, clickMs) {
    try {
        await locator.waitFor({ state: "attached", timeout: probeMs });
    } catch (_) {
        return null;
    }
    try {
        await locator.click({ timeout: clickMs });
        return true;
    } catch (e) {
        return e;
    }
}

async function clickWithFallback(page, ev, timeout) {
    const sel = ev.selector;
    const rawText = (ev.text || "").trim();
    const firstLine = rawText.split("\n")[0].trim();
    const clickMs = Math.min(5000, timeout);
    const probeMs = 1500;
    let lastErr = null;

    // Strategy 1 — recorded selector + hasText filter. The user's recorded
    // selector is the most specific locator we have. filter({hasText}) picks
    // the right element when the selector is non-unique (e.g. challenge/selection
    // page where every option uses div[jsname="fmcmS"]).
    if (sel && firstLine) {
        const r = await tryClick(
            page.locator(sel).filter({ hasText: firstLine }).first(),
            probeMs,
            clickMs,
        );
        if (r === true) return;
        if (r) lastErr = r;
    }

    // Strategy 2 — selector only. For events with no recorded text (icon
    // clicks, checkbox inputs). Try a force click as a sub-fallback to handle
    // hidden Material checkbox inputs that fail the actionability check.
    if (sel) {
        const loc = page.locator(sel).first();
        const r = await tryClick(loc, probeMs, clickMs);
        if (r === true) return;
        if (r) {
            lastErr = r;
            try {
                await loc.click({ timeout: clickMs, force: true });
                return;
            } catch (e2) {
                lastErr = e2;
            }
        }
    }

    // Strategy 3 — getByRole(button|link, name). Useful when the recorded
    // selector is completely stale but the visible label is stable. Tries
    // button first, then link (Skip is often an <a>).
    if (firstLine && firstLine.length < 60) {
        for (const role of ["button", "link"]) {
            const r = await tryClick(
                page.getByRole(role, { name: firstLine, exact: false }).first(),
                probeMs,
                clickMs,
            );
            if (r === true) return;
            if (r) lastErr = r;
        }
    }

    // Strategy 4 — getByText fallback
    if (firstLine) {
        const r = await tryClick(
            page.getByText(firstLine, { exact: false }).first(),
            probeMs,
            clickMs,
        );
        if (r === true) return;
        if (r) lastErr = r;
    }

    throw new Error(
        `click failed: selector=${sel} text='${firstLine}' lastErr=${lastErr?.message?.split("\n")[0] || "n/a"}`,
    );
}

async function executeEvent(page, ev, account, timeout) {
    const sel = ev.selector;
    if (!sel) return;
    if (ev.type === "click") {
        await clickWithFallback(page, ev, timeout);
    } else if (ev.type === "fill") {
        const value = substituteValue(ev.value, account);
        await page.locator(sel).first().fill(String(value ?? ""), { timeout });
    } else if (ev.type === "press") {
        await page.locator(sel).first().press(ev.key || "Enter", { timeout });
    }
}

async function tryExecuteStep(page, ev, account) {
    if (!ev.selector || ev.type === "nav" || ev.type === "ready") return true;
    try {
        await executeEvent(page, ev, account, STEP_PROBE_TIMEOUT);
        await page.waitForTimeout(400);
        return true;
    } catch (e) {
        if (e instanceof RecoveryMissing) throw e;
        return false;
    }
}

async function runEvents(page, events, account) {
    if (!events || !events.length) return;
    const urlBefore = page.url();
    for (const ev of events) {
        if (!ev.selector || ev.type === "nav" || ev.type === "ready") continue;
        await executeEvent(page, ev, account, STEP_TIMEOUT);
        await page.waitForTimeout(400);
    }
    // Wait for any navigation triggered by the last event to commit. Without
    // this, the next loop iteration can read the old URL and re-run the same
    // segment, only to fail because selectors now belong to the new page.
    // Modal-only segments (e.g. clicking a checkbox + Continue) won't change
    // the URL — that's fine, the timeout fires and we move on.
    try {
        await page.waitForFunction(
            (prev) => location.href !== prev,
            urlBefore,
            { timeout: 6000 },
        );
        await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    } catch (_) {
        // no navigation — ok
    }
}

// ---------- terminal prompt ----------

let rl = null;
function getRl() {
    if (!rl) {
        rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    }
    return rl;
}
function prompt(text) {
    return new Promise((resolve) => getRl().question(text, (a) => resolve(a.trim())));
}

// ---------- banner ----------

async function showBanner(page, text) {
    /* eslint-disable no-undef */
    await page
        .evaluate((t) => {
            let el = document.getElementById("__rec_banner");
            if (!el) {
                el = document.createElement("div");
                el.id = "__rec_banner";
                el.style.cssText =
                    "position:fixed;top:0;left:0;right:0;z-index:2147483647;" +
                    "background:#dc2626;color:white;padding:10px 16px;" +
                    "font:bold 14px monospace;text-align:center;" +
                    "box-shadow:0 2px 12px rgba(0,0,0,0.4);pointer-events:none";
                (document.body || document.documentElement).appendChild(el);
            }
            el.textContent = "MANUAL TAKEOVER — " + t;
        }, text)
        .catch(() => {});
    /* eslint-enable no-undef */
}

async function hideBanner(page) {
    /* eslint-disable no-undef */
    await page
        .evaluate(() => {
            const el = document.getElementById("__rec_banner");
            if (el) el.remove();
        })
        .catch(() => {});
    /* eslint-enable no-undef */
}

// ---------- recorder install (for takeover mode) ----------

async function installRecorder(page) {
    try {
        await page.evaluate(INSTALL_SCRIPT);
    } catch (_) {
        // navigation in flight
    }
}

async function drainRecorder(page) {
    try {
        const q = await page.evaluate(DRAIN_SCRIPT);
        return Array.isArray(q) ? q : [];
    } catch (_) {
        return [];
    }
}

// ---------- manual takeover ----------

async function manualTakeover(page, flow, account, contextLabel) {
    const url = page.url();
    process.stdout.write(`\n[?] ${contextLabel} @ ${url}\n`);
    process.stdout.write("    [s] skip this account (record URL as skip-branch)\n");
    process.stdout.write("    [b] record a branch (operate, then press Enter to save)\n");
    process.stdout.write("    [c] continue once (operate, no save)\n");
    process.stdout.write("    [q] quit replay\n");
    const choice = (await prompt("    choice: ")).toLowerCase();

    if (choice === "q") return { action: "quit" };

    if (choice === "s") {
        const id = makeBranchId(url);
        const suggested = deriveUrlMatch(url);
        const userMatch = (
            await prompt(`    urlIncludes pattern [${suggested}]: `)
        ).trim();
        const match = { urlIncludes: userMatch || suggested };
        const reason = (await prompt("    reason (e.g. phone-only auth): ")) || `skip via ${id}`;
        flow.branches.push({ id, match, action: "skip-account", reason });
        saveFlow(FLOW_PATH, flow);
        process.stdout.write(`    saved skip-branch '${id}' (urlIncludes='${match.urlIncludes}')\n`);
        return { action: "skip", reason };
    }

    if (choice !== "b" && choice !== "c") {
        process.stdout.write("    unknown choice, treating as continue-once\n");
    }

    // b or c: install recorder, banner, wait for Enter, drain
    const recorded = [];
    let polling = true;
    await showBanner(page, "operate the browser, return to terminal and press Enter when done");
    await installRecorder(page);

    const navHandler = (frame) => {
        if (frame !== page.mainFrame()) return;
        installRecorder(page);
        showBanner(page, "operate the browser, return to terminal and press Enter when done");
    };
    page.on("framenavigated", navHandler);

    const pollTimer = setInterval(async () => {
        if (!polling) return;
        const drained = await drainRecorder(page);
        for (const ev of drained) {
            if (ev.type === "ready") continue;
            recorded.push(ev);
            const detail =
                ev.value !== undefined ? `= ${ev.value}` : ev.key ? `(${ev.key})` : "";
            process.stdout.write(`    [rec] ${ev.type} ${ev.selector || ""} ${detail}\n`);
        }
    }, POLL_MS);

    await prompt("    ... press Enter when done: ");

    polling = false;
    clearInterval(pollTimer);
    // final drain
    const last = await drainRecorder(page);
    for (const ev of last) {
        if (ev.type === "ready") continue;
        recorded.push(ev);
    }
    page.off("framenavigated", navHandler);
    await hideBanner(page);

    const cleaned = recorded.filter((e) => e.selector);

    if (choice === "b") {
        // ask for each __EMAIL__ fill: main or recovery?
        for (const ev of cleaned) {
            if (ev.type === "fill" && ev.value === "__EMAIL__") {
                const r = (
                    await prompt(`    fill '${ev.selector}' is [m]ain email or [r]ecovery? `)
                )
                    .toLowerCase();
                if (r === "r") ev.value = "__RECOVERY__";
            }
        }
        const id = makeBranchId(url);
        const suggested = deriveUrlMatch(url);
        const userMatch = (
            await prompt(`    urlIncludes pattern [${suggested}]: `)
        ).trim();
        const match = { urlIncludes: userMatch || suggested };
        // Ask what to do if a step in this branch fails on a future account
        // (e.g. account doesn't have the recovery-email option, only phone).
        const onFailChoice = (
            await prompt("    on event failure: [s]kip-account / [t]akeover (default takeover): ")
        )
            .trim()
            .toLowerCase();
        const branchObj = { id, match, action: "events", events: cleaned };
        if (onFailChoice === "s") {
            branchObj.onFail = "skip-account";
            branchObj.skipReason =
                (await prompt("    skip reason: ")) || `branch ${id} not applicable`;
        }
        flow.branches.push(branchObj);
        saveFlow(FLOW_PATH, flow);
        process.stdout.write(
            `    saved branch '${id}' with ${cleaned.length} events (urlIncludes='${match.urlIncludes}', onFail=${branchObj.onFail || "takeover"})\n`,
        );
    }

    return { action: "continue" };
}

// ---------- per-account run ----------

async function runOne(account, flow) {
    const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), "aist-replay-"));
    const context = await chromium.launchPersistentContext(tmpProfile, {
        headless: false,
        viewport: null,
        args: ["--start-maximized"],
    });

    try {
        const page = context.pages()[0] || (await context.newPage());
        const segments = splitMainIntoSegments(flow.main);
        process.stdout.write(`       split main into ${segments.length} segments\n`);
        const firstNav = flow.main.find((e) => e.type === "nav" && e.url);
        const entryUrl = firstNav?.url || "https://aistudio.google.com";
        await page
            .goto(entryUrl, { waitUntil: "domcontentloaded", timeout: 30000 })
            .catch(() => {});

        let loops = 0;
        let lastUrl = "";
        let stuckCount = 0;

        while (loops < MAX_LOOP_STEPS) {
            loops++;
            // settle a moment so URL/dom reflect the current state
            await page.waitForLoadState("domcontentloaded").catch(() => {});
            await page.waitForTimeout(300);

            const url = page.url();
            if (url === lastUrl) stuckCount++;
            else { stuckCount = 0; lastUrl = url; }
            process.stdout.write(`       loop ${loops} stuck=${stuckCount} url=${url.slice(0, 90)}\n`);

            // 1) branch match? (run BEFORE success check so DOM-based branches
            // — like the AI Studio agreements modal — can intercept the success URL)
            const branch = await findMatchingBranch(page, flow, url);

            // 2) success URL? (only if no branch wants to handle this page)
            if (!branch && isSuccessUrl(url)) {
                await page.waitForTimeout(2000);
                const state = await extractStorageState(context, page, account.email);
                const idx = nextAuthIndex();
                const file = path.join(AUTH_DIR, `auth-${idx}.json`);
                fs.writeFileSync(file, JSON.stringify(state, null, 2));
                process.stdout.write(`[ok]   ${account.email} -> auth-${idx}.json\n`);
                return { ok: true };
            }

            if (branch) {
                process.stdout.write(`       branch '${branch.id}' matched\n`);
                if (branch.action === "skip-account") {
                    return { ok: false, error: branch.reason || `skip via ${branch.id}` };
                }
                if (branch.action === "events") {
                    try {
                        await runEvents(page, branch.events || [], account);
                    } catch (e) {
                        if (e instanceof RecoveryMissing) {
                            return { ok: false, error: "no recovery email in CSV" };
                        }
                        process.stdout.write(`       branch '${branch.id}' failed: ${e.message.split("\n")[0]}\n`);
                        // Honor declared onFail. Default = takeover (ask the operator).
                        if (branch.onFail === "skip-account") {
                            const reason = branch.skipReason || `branch ${branch.id} failed`;
                            process.stdout.write(`       branch '${branch.id}' onFail=skip-account: ${reason}\n`);
                            return { ok: false, error: reason };
                        }
                        const r = await manualTakeover(page, flow, account, `branch ${branch.id} broke`);
                        if (r.action === "quit") process.exit(0);
                        if (r.action === "skip") return { ok: false, error: r.reason };
                    }
                    continue;
                }
            }

            // 3) match a recorded main segment by URL
            const segIdx = findMatchingSegmentIdx(segments, url);
            if (segIdx >= 0 && stuckCount < 4) {
                const seg = segments[segIdx];
                process.stdout.write(
                    `       segment[${segIdx}] entry=${(seg.entryUrl || "").slice(0, 70)} (${seg.events.length} events)\n`,
                );
                try {
                    await runEvents(page, seg.events, account);
                } catch (e) {
                    if (e instanceof RecoveryMissing) {
                        return { ok: false, error: "no recovery email in CSV" };
                    }
                    process.stdout.write(`       segment failed: ${e.message.split("\n")[0]}\n`);
                    const r = await manualTakeover(page, flow, account, `segment ${segIdx} broke`);
                    if (r.action === "quit") process.exit(0);
                    if (r.action === "skip") return { ok: false, error: r.reason };
                }
                continue;
            }

            // 4) unknown state — either no segment matches, or we've been
            // stuck on the same URL too long (segment ran but didn't advance).
            const reason =
                segIdx < 0
                    ? "no recorded segment matches this URL"
                    : `stuck on segment ${segIdx} for ${stuckCount} loops`;
            const r = await manualTakeover(page, flow, account, reason);
            if (r.action === "quit") process.exit(0);
            if (r.action === "skip") return { ok: false, error: r.reason };
            // continue loop — reset stuck since user took action
            stuckCount = 0;
            lastUrl = "";
        }

        return { ok: false, error: `hit step limit (${MAX_LOOP_STEPS})` };
    } catch (e) {
        return { ok: false, error: e.message.split("\n")[0] };
    } finally {
        await context.close().catch(() => {});
        fs.rmSync(tmpProfile, { recursive: true, force: true });
    }
}

// ---------- main ----------

(async () => {
    if (!fs.existsSync(FLOW_PATH)) {
        process.stderr.write(`[replay] flow not found: ${FLOW_PATH}\n`);
        process.exit(1);
    }
    if (!fs.existsSync(CSV_PATH)) {
        process.stderr.write(`[replay] csv not found: ${CSV_PATH}\n`);
        process.exit(1);
    }

    let flow = loadFlow(FLOW_PATH);
    // persist normalized form so later saves are clean
    saveFlow(FLOW_PATH, flow);

    const accounts = parseCsv(fs.readFileSync(CSV_PATH, "utf8"));
    process.stdout.write(
        `[replay] ${accounts.length} accounts, main=${flow.main.length} steps, branches=${flow.branches.length}\n`,
    );

    if (fs.existsSync(FAILED_CSV)) fs.unlinkSync(FAILED_CSV);

    let ok = 0;
    let fail = 0;
    for (let i = 0; i < accounts.length; i++) {
        const acc = accounts[i];
        process.stdout.write(`\n--- (${i + 1}/${accounts.length}) ${acc.email} ---\n`);
        // reload flow each time so newly-saved branches from previous runOne are picked up
        flow = loadFlow(FLOW_PATH);
        const r = await runOne(acc, flow);
        if (r.ok) {
            ok++;
        } else {
            fail++;
            const recoveryCol = acc.recovery ? acc.recovery : "";
            fs.appendFileSync(
                FAILED_CSV,
                `${acc.email},${acc.password},${recoveryCol},${(r.error || "").replace(/[\r\n]+/g, " ")}\n`,
            );
            process.stdout.write(`[fail] ${acc.email}: ${r.error}\n`);
        }
    }

    process.stdout.write(`\n[replay] done. ok=${ok} fail=${fail}\n`);
    if (fail) process.stdout.write(`[replay] failures logged -> ${FAILED_CSV}\n`);
    if (rl) rl.close();
    process.exit(0);
})().catch((e) => {
    process.stderr.write(`[replay] fatal: ${e.stack || e.message}\n`);
    process.exit(1);
});
