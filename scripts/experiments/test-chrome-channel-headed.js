const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

(async () => {
    const authPath = path.resolve("configs/auth/auth-0.json");
    const auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));

    console.log(`[info] launching Playwright channel:'chrome', headless:false`);
    const browser = await chromium.launch({
        channel: 'chrome',
        headless: false,
    });
    console.log(`[info] ✓ launched, version: ${browser.version()}`);

    const context = await browser.newContext({ storageState: auth });
    const page = await context.newPage();

    console.log("\n[info] Navigating Canvas URL...");
    await page.goto("https://ai.studio/apps/c48c6178-8dad-4d16-8de7-bb78d265482c?showPreview=true&showAssistant=true", {
        waitUntil: "domcontentloaded", timeout: 60000
    });
    await page.waitForTimeout(2000);
    try {
        await page.getByRole("button", { name: /continue to the app/i }).click({ timeout: 5000 });
        console.log("  ✓ clicked Continue to the app");
    } catch (e) {
        console.log("  ⚠ no Continue button:", e.message.substring(0, 60));
    }
    await page.waitForTimeout(8000);

    // ---- fingerprint ----
    const fp = await page.evaluate(() => ({
        ua: navigator.userAgent,
        brands: navigator.userAgentData && navigator.userAgentData.brands,
        plat: navigator.userAgentData && navigator.userAgentData.platform,
        webdriver: navigator.webdriver,
    }));
    console.log(`[fingerprint] ua=${fp.ua}`);
    console.log(`[fingerprint] brands=${JSON.stringify(fp.brands)}`);
    console.log(`[fingerprint] platform=${fp.plat}`);
    console.log(`[fingerprint] webdriver=${fp.webdriver}`);

    // ---- measure memory (RSS) before request ----
    try {
        const out = execSync('ps ax -o rss=,command= | grep -i "Google Chrome" | grep -v grep', { encoding: 'utf-8' });
        const lines = out.trim().split('\n').filter(Boolean);
        let total = 0;
        console.log(`[memory] ${lines.length} Chrome processes:`);
        for (const line of lines) {
            const m = line.trim().match(/^(\d+)\s+(.*)$/);
            if (m) {
                const rssKb = parseInt(m[1], 10);
                total += rssKb;
                const cmd = m[2].slice(0, 120);
                console.log(`  ${(rssKb / 1024).toFixed(1)} MB  ${cmd}`);
            }
        }
        console.log(`[memory] total RSS = ${(total / 1024).toFixed(1)} MB`);
    } catch (e) {
        console.log(`[memory] ps failed: ${e.message}`);
    }

    // ---- build SAPISIDHASH header ----
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

    console.log("\n[test] ProxyUnaryCall from Chrome main frame");
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
