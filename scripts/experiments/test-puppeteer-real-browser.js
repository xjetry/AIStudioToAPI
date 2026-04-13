/*
 * Independent validation test for puppeteer-real-browser as a browser kernel
 * candidate for AIStudioToAPI.
 *
 * Goals:
 *   1. Verify it can launch, load storageState cookies, navigate to an AI Studio
 *      Canvas URL and click "Continue to the app".
 *   2. Dump fingerprint metrics (navigator.webdriver, userAgent, brands, plugins)
 *      for direct comparison with Playwright / Patchright / rebrowser / Chrome-headed.
 *
 * Not in scope: running a full ProxyUnaryCall; this test only validates kernel-level
 * fingerprint & navigation behavior.
 */

const path = require('path');
const fs = require('fs');

const AUTH_PATH = path.resolve(__dirname, '../../configs/auth/auth-0.json');
const CANVAS_URL =
    'https://ai.studio/apps/c48c6178-8dad-4d16-8de7-bb78d265482c?showPreview=true&showAssistant=true';

function log(...args) {
    // eslint-disable-next-line no-console
    console.log(`[test-prb ${new Date().toISOString()}]`, ...args);
}

function convertCookies(playwrightCookies) {
    return playwrightCookies
        .map((c) => {
            const sameSite =
                c.sameSite === 'None' || c.sameSite === 'Strict' || c.sameSite === 'Lax'
                    ? c.sameSite
                    : 'Lax';
            const cookie = {
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path || '/',
                httpOnly: !!c.httpOnly,
                secure: !!c.secure,
                sameSite,
            };
            if (typeof c.expires === 'number' && c.expires > 0) {
                cookie.expires = c.expires;
            }
            return cookie;
        })
        // Puppeteer rejects cookies with sameSite=None unless secure=true; drop bad ones.
        .filter((c) => !(c.sameSite === 'None' && !c.secure));
}

async function main() {
    log('Loading auth-0.json from', AUTH_PATH);
    const auth = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8'));
    log('accountName =', auth.accountName, '| cookies =', auth.cookies.length);

    const puppeteerCookies = convertCookies(auth.cookies);
    log('converted cookies =', puppeteerCookies.length);

    const { connect } = require('puppeteer-real-browser');
    log('puppeteer-real-browser loaded, calling connect()…');

    const startT = Date.now();
    const { page, browser } = await connect({
        headless: false,
        turnstile: false,
        args: ['--no-first-run', '--no-default-browser-check'],
        customConfig: {},
        connectOption: {
            defaultViewport: { width: 1280, height: 800 },
        },
        disableXvfb: false,
        ignoreAllFlags: false,
    });
    log('connect() done in', Date.now() - startT, 'ms');

    try {
        log('Setting cookies via page.setCookie…');
        await page.setCookie(...puppeteerCookies);

        log('Pre-goto fingerprint (about:blank)');
        const pre = await page.evaluate(() => ({
            ua: navigator.userAgent,
            brands: navigator.userAgentData ? navigator.userAgentData.brands : null,
            mobile: navigator.userAgentData ? navigator.userAgentData.mobile : null,
            platform: navigator.userAgentData ? navigator.userAgentData.platform : null,
            webdriver: navigator.webdriver,
            plugins: navigator.plugins.length,
            languages: navigator.languages,
        }));
        log('PRE fingerprint =', JSON.stringify(pre, null, 2));

        log('Navigating to Canvas URL…');
        await page.goto(CANVAS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Wait a bit for any Continue button to render
        await new Promise((r) => setTimeout(r, 3000));

        log('Looking for "Continue to the app" button…');
        const clicked = await page.evaluate(() => {
            const candidates = Array.from(
                document.querySelectorAll('button, a, span[role=button]')
            );
            const btn = candidates.find((el) => {
                const t = (el.textContent || '').trim().toLowerCase();
                return t.includes('continue to the app') || t === 'continue';
            });
            if (btn) {
                btn.click();
                return (btn.textContent || '').trim();
            }
            return null;
        });
        log('Continue button =', clicked ?? '(none found)');

        // Wait for Canvas to finish loading (mimic upstream flow)
        await new Promise((r) => setTimeout(r, 8000));

        log('Post-nav fingerprint');
        const post = await page.evaluate(() => ({
            url: location.href,
            title: document.title,
            ua: navigator.userAgent,
            brands: navigator.userAgentData ? navigator.userAgentData.brands : null,
            mobile: navigator.userAgentData ? navigator.userAgentData.mobile : null,
            platform: navigator.userAgentData ? navigator.userAgentData.platform : null,
            webdriver: navigator.webdriver,
            plugins: navigator.plugins.length,
            languages: navigator.languages,
            // Common automation tells
            hasChromeRuntime: !!(window.chrome && window.chrome.runtime),
            connection: navigator.connection
                ? {
                      effectiveType: navigator.connection.effectiveType,
                      rtt: navigator.connection.rtt,
                      downlink: navigator.connection.downlink,
                  }
                : null,
            hardwareConcurrency: navigator.hardwareConcurrency,
            deviceMemory: navigator.deviceMemory,
        }));
        log('POST fingerprint =', JSON.stringify(post, null, 2));

        // Grab a small snapshot of visible text for sanity check (403 page vs real app)
        const bodySnippet = await page
            .evaluate(() => (document.body ? document.body.innerText.slice(0, 500) : ''))
            .catch(() => '(eval failed)');
        log('Body snippet (500 chars):\n' + bodySnippet);
    } catch (err) {
        log('ERROR during test:', err && err.stack ? err.stack : err);
    } finally {
        log('Closing browser…');
        try {
            await browser.close();
        } catch (e) {
            log('close() error:', e && e.message);
        }
        log('Done.');
    }
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[test-prb] fatal:', err);
    process.exit(1);
});
