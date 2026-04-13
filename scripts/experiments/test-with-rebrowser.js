const { chromium } = require('rebrowser-playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

(async () => {
    const authPath = path.resolve("configs/auth/auth-0.json");
    const auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));

    console.log(`[info] rebrowser-playwright version: ${require('rebrowser-playwright/package.json').version}`);
    // Use the full Chromium binary (not headless_shell) so that sec-ch-ua headers
    // match real Chrome as closely as possible. rebrowser still applies its patches.
    const chromiumPath = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1169/chrome-mac/Chromium.app/Contents/MacOS/Chromium`;
    console.log(`[info] launching rebrowser chromium (1169) at ${chromiumPath}`);

    const browser = await chromium.launch({
        headless: true,
        executablePath: chromiumPath,
        args: [
            '--disable-blink-features=AutomationControlled',
        ],
    });
    console.log(`[info] launched, version: ${browser.version()}`);

    const context = await browser.newContext({ storageState: auth });
    const page = await context.newPage();

    console.log("\n[info] Navigating Canvas URL...");
    await page.goto("https://ai.studio/apps/c48c6178-8dad-4d16-8de7-bb78d265482c?showPreview=true&showAssistant=true", {
        waitUntil: "domcontentloaded", timeout: 60000
    });
    await page.waitForTimeout(2000);
    try {
        await page.getByRole("button", { name: /continue to the app/i }).click({ timeout: 5000 });
        console.log("  clicked Continue to the app");
    } catch (e) {
        console.log("  no Continue button:", e.message.substring(0, 60));
    }
    await page.waitForTimeout(8000);

    // ===== Fingerprint probe =====
    const fp = await page.evaluate(async () => {
        const brands = navigator.userAgentData ? navigator.userAgentData.brands : null;
        let highEntropy = null;
        try {
            if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
                highEntropy = await navigator.userAgentData.getHighEntropyValues([
                    "fullVersionList", "uaFullVersion", "platform", "platformVersion"
                ]);
            }
        } catch (e) {}
        return {
            ua: navigator.userAgent,
            brands,
            highEntropy,
            webdriver: navigator.webdriver,
            plugins: navigator.plugins ? navigator.plugins.length : null,
            languages: navigator.languages,
        };
    });
    console.log(`\n[fingerprint] userAgent: ${fp.ua}`);
    console.log(`[fingerprint] navigator.webdriver: ${fp.webdriver}`);
    console.log(`[fingerprint] userAgentData.brands: ${JSON.stringify(fp.brands)}`);
    console.log(`[fingerprint] getHighEntropyValues.fullVersionList: ${JSON.stringify(fp.highEntropy && fp.highEntropy.fullVersionList)}`);
    console.log(`[fingerprint] uaFullVersion: ${fp.highEntropy && fp.highEntropy.uaFullVersion}`);
    console.log(`[fingerprint] plugins.length: ${fp.plugins}`);
    console.log(`[fingerprint] languages: ${JSON.stringify(fp.languages)}`);

    const hasHeadless = JSON.stringify(fp.brands || "").toLowerCase().includes("headless")
        || JSON.stringify(fp.highEntropy || "").toLowerCase().includes("headless")
        || (fp.ua || "").toLowerCase().includes("headless");
    console.log(`[fingerprint] HeadlessChrome leaked? ${hasHeadless ? "YES (bad)" : "NO (good)"}`);

    // ===== Memory measurement =====
    try {
        const psOut = execSync(
            `ps -A -o pid,rss,command | grep -i -E "(Chromium|Chrome.*Helper)" | grep -v grep | grep -v "Google Chrome" || true`,
            { encoding: 'utf8' }
        );
        console.log(`\n[memory] chromium processes:`);
        let totalRssKB = 0;
        let mainRssKB = 0;
        for (const line of psOut.trim().split('\n')) {
            if (!line) continue;
            const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
            if (!m) continue;
            const [, , rss, cmd] = m;
            const rssKB = parseInt(rss);
            totalRssKB += rssKB;
            if (!cmd.includes('Helper') && rssKB > mainRssKB) mainRssKB = rssKB;
            console.log(`  ${(rssKB / 1024).toFixed(1)} MB  ${cmd.slice(0, 100)}`);
        }
        console.log(`[memory] main process RSS: ${(mainRssKB / 1024).toFixed(1)} MB`);
        console.log(`[memory] all chromium processes total RSS: ${(totalRssKB / 1024).toFixed(1)} MB`);
    } catch (e) {
        console.log(`[memory] failed: ${e.message}`);
    }

    // ===== ProxyUnaryCall test =====
    const cookies = await context.cookies("https://aistudio.google.com/");
    const map = Object.fromEntries(cookies.map(c => [c.name, c.value]));
    const ORIGIN = "https://aistudio.google.com";
    const mkField = (cv) => {
        const ts = Math.floor(Date.now() / 1000);
        return `${ts}_${crypto.createHash("sha1").update(`${ts} ${cv} ${ORIGIN}`).digest("hex")}`;
    };
    const authHeader = [
        `SAPISIDHASH ${mkField(map["SAPISID"])}`,
        `SAPISID1PHASH ${mkField(map["__Secure-1PAPISID"])}`,
        `SAPISID3PHASH ${mkField(map["__Secure-3PAPISID"])}`,
    ].join(" ");

    const body = JSON.stringify([
        "/v1beta/models/gemini-2.5-flash:generateContent",
        JSON.stringify({
            contents: [{ parts: [{ text: "say one word" }], role: "user" }],
            generationConfig: {},
            safetySettings: [
                { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
            ],
        }),
    ]);

    const url = "https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/ProxyUnaryCall";

    console.log("\n[test] ProxyUnaryCall from rebrowser-chromium main frame");
    const res = await page.evaluate(async ({ url, body, auth }) => {
        try {
            const r = await fetch(url, {
                method: "POST",
                credentials: "include",
                headers: {
                    "content-type": "application/json+protobuf",
                    "x-user-agent": "grpc-web-javascript/0.1",
                    "x-goog-api-key": "AIzaSyDdP816MREB3SkjZO04QXbjsigfcI0GWOs",
                    "x-goog-authuser": "0",
                    "x-goog-ext-519733851-bin": "CAASAUIwATgEQABQBFgDYgJVUw==",
                    "authorization": auth,
                },
                body,
            });
            return { status: r.status, body: (await r.text()).slice(0, 3000) };
        } catch (e) { return { error: e.message }; }
    }, { url, body, auth: authHeader });
    console.log(`  status=${res.status}`);
    console.log(`  body=${(res.body || res.error || "").substring(0, 2000)}`);

    await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
