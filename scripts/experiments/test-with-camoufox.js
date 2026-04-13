const { firefox } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

(async () => {
    const authPath = path.resolve("configs/auth/auth-0.json");
    const auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    
    // 用 Camoufox 二进制,像 BrowserManager 一样
    const camoufoxPath = path.join(process.cwd(),
        "camoufox-macos", "Camoufox.app", "Contents", "MacOS", "camoufox");
    console.log(`[info] launching Camoufox binary: ${camoufoxPath}`);
    
    const browser = await firefox.launch({ 
        executablePath: camoufoxPath,
        headless: true,
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
    
    const ua = await page.evaluate(() => navigator.userAgent);
    const wd = await page.evaluate(() => navigator.webdriver);
    console.log(`[info] navigator.userAgent: ${ua}`);
    console.log(`[info] navigator.webdriver: ${wd}`);
    
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
    
    console.log("\n[test] ProxyUnaryCall from Camoufox main frame");
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
