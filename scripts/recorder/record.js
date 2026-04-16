/*
 * Recorder: launches Patchright Chromium with a fixed persistent profile,
 * captures user click/fill/press events on every page, and writes a JSON
 * "flow" file that replay.js can replay against many accounts.
 *
 * Email/password values are masked into __EMAIL__ / __PASSWORD__ placeholders
 * so the flow file is safe to commit and reuse across accounts.
 *
 * Why evaluate-injection + polling instead of addInitScript / exposeBinding /
 * console.log: Patchright's anti-detection runs everything in an isolated
 * world and clamps the bridges (binding & main-world console) so events from
 * page-side listeners never reach Node. By using page.evaluate we install the
 * listeners directly into the isolated world, queue events on its private
 * window object, and pull them out with another evaluate on a poll loop —
 * the whole bridge stays inside the isolated world and is unaffected by
 * Patchright's fixes.
 *
 * Usage:
 *   node scripts/recorder/record.js [flowName]
 *   # press Ctrl+C when login is finished
 */

const { chromium } = require("patchright");
const path = require("path");
const fs = require("fs");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const PROFILE_DIR = path.join(PROJECT_ROOT, ".browser-profiles", "recorder");
const FLOWS_DIR = path.join(__dirname, "flows");

const flowName = process.argv[2] || "login";
const OUT_FILE = path.join(FLOWS_DIR, `${flowName}.json`);
const START_URL = "https://aistudio.google.com";
const POLL_MS = 250;

fs.mkdirSync(PROFILE_DIR, { recursive: true });
fs.mkdirSync(FLOWS_DIR, { recursive: true });

const events = [];

function pushEvent(ev) {
    events.push({ ...ev, t: ev.t || Date.now() });
    const tag = (ev.type || "?").padEnd(6);
    const detail =
        ev.value !== undefined ? `= ${ev.value}` : ev.key ? `(${ev.key})` : "";
    process.stdout.write(`[rec] ${tag} ${ev.selector || ""} ${detail}\n`);
}

function save() {
    try {
        fs.writeFileSync(OUT_FILE, JSON.stringify(events, null, 2));
        process.stdout.write(`\n[rec] saved ${events.length} events -> ${OUT_FILE}\n`);
    } catch (e) {
        process.stderr.write(`[rec] save failed: ${e.message}\n`);
    }
    process.exit(0);
}

// Source of the listener bundle. Runs inside the page's isolated world via
// page.evaluate. Idempotent: installs once per document.
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
    // checkbox/radio have a static "value" attribute (often "on") that is
    // unrelated to their checked state — flushing it produces a stale fill
    // event that breaks replay. The 'change' handler below already records
    // checkbox toggles as click events.
    if (el.type === 'checkbox' || el.type === 'radio') return;
    emit({
      type: 'fill',
      selector: getSelector(el),
      value: maskValue(el, el.value),
      url: location.href,
    });
  }

  function getClickText(el) {
    // Click target may be an inner span/div with no text of its own.
    // Walk up a few levels to find a meaningful label so replay can
    // fall back to text-based locators.
    let cur = el;
    let depth = 0;
    while (cur && depth < 5) {
      const t = ((cur.innerText || cur.textContent) || '').trim();
      if (t && t.length < 100) return t.slice(0, 80);
      cur = cur.parentElement;
      depth++;
    }
    return '';
  }

  document.addEventListener('mousedown', (e) => {
    flushActiveValue();
    const el = e.target;
    emit({
      type: 'click',
      selector: getSelector(el),
      tag: el && el.tagName,
      text: getClickText(el),
      url: location.href,
    });
  }, true);

  // Note: no focusout listener — mousedown already flushes activeElement
  // before emitting click, and keydown[Enter] flushes too. focusout fires
  // *after* mousedown in capture phase, which would push a stale fill
  // event into the queue right before navigation, breaking replay.

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

  emit({ type: 'ready', url: location.href });
  return { ok: true };
})();
`;

const DRAIN_SCRIPT = `(() => { const q = window.__rec_queue || []; window.__rec_queue = []; return q; })()`;

async function install(page) {
    try {
        const r = await page.evaluate(INSTALL_SCRIPT);
        if (r && r.ok) {
            process.stdout.write(`[rec] installed listeners @ ${page.url()}\n`);
        }
    } catch (_) {
        // navigation in flight, will retry on next framenavigated
    }
}

async function drain(page) {
    try {
        const q = await page.evaluate(DRAIN_SCRIPT);
        if (Array.isArray(q)) {
            for (const ev of q) pushEvent(ev);
        }
    } catch (_) {
        // navigation in flight
    }
}

(async () => {
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: false,
        viewport: null,
        args: ["--start-maximized"],
    });

    const tracked = new WeakSet();
    function track(page) {
        if (tracked.has(page)) return;
        tracked.add(page);
        page.on("framenavigated", (frame) => {
            if (frame !== page.mainFrame()) return;
            pushEvent({ type: "nav", url: frame.url() });
            // Re-install after every main-frame navigation (window was reset)
            install(page);
        });
        install(page);
    }

    context.on("page", track);
    for (const p of context.pages()) track(p);

    const page = context.pages()[0] || (await context.newPage());
    await page.goto(START_URL, { waitUntil: "domcontentloaded" }).catch(() => {});

    const pollTimer = setInterval(async () => {
        for (const p of context.pages()) await drain(p);
    }, POLL_MS);

    process.stdout.write("\n>> Recording. Complete the login flow, then press Ctrl+C to save.\n");
    process.stdout.write(">> Watch for [rec] installed and [rec] ready lines.\n\n");

    const finish = async () => {
        clearInterval(pollTimer);
        // final drain
        for (const p of context.pages()) await drain(p);
        save();
    };
    process.on("SIGINT", finish);
    process.on("SIGTERM", finish);
})().catch((e) => {
    process.stderr.write(`[rec] fatal: ${e.stack || e.message}\n`);
    process.exit(1);
});
