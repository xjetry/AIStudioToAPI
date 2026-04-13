const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

(async () => {
    const authPath = path.resolve("configs/auth/auth-0.json");
    const auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ 
        storageState: auth,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:135.0) Gecko/20100101 Firefox/135.0",
    });
    const page = await context.newPage();
    
    console.log("[info] 导航 Canvas URL with Firefox UA spoof...");
    await page.goto("https://ai.studio/apps/c48c6178-8dad-4d16-8de7-bb78d265482c?showPreview=true&showAssistant=true", {
        waitUntil: "domcontentloaded", timeout: 60000 
    });
    await page.waitForTimeout(3000);
    try {
        await page.getByRole("button", { name: /continue to the app/i }).click({ timeout: 5000 });
    } catch (e) {}
    await page.waitForTimeout(6000);
    
    // 打印 context 里的所有 .google.com cookies,确认没丢
    const cookies = await context.cookies("https://aistudio.google.com/");
    const map = Object.fromEntries(cookies.map(c => [c.name, c.value]));
    console.log(`\n[cookies] ${cookies.length} total:`);
    for (const name of ["SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID",
                         "__Secure-1PSID", "__Secure-3PSID", "NID", "SSID",
                         "__Secure-1PSIDTS", "__Secure-3PSIDTS",
                         "__Secure-1PSIDCC", "__Secure-3PSIDCC"]) {
        const val = map[name];
        console.log(`  ${name}: ${val ? val.substring(0, 20) + "..." : "❌ MISSING"}`);
    }
    
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
    
    console.log(`\n[test] ProxyUnaryCall with Firefox UA from Chromium page.evaluate`);
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
                    "authorization": auth,
                },
                body,
            });
            return { status: r.status, body: (await r.text()).slice(0, 2000) };
        } catch (e) { return { error: e.message }; }
    }, { url, body, auth: authHeader });
    console.log(`  status=${res.status}`);
    console.log(`  body=${(res.body || res.error || "").substring(0, 800)}`);
    
    await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
