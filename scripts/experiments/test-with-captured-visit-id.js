const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

(async () => {
    const authPath = path.resolve("configs/auth/auth-0.json");
    const auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: auth });
    const page = await context.newPage();
    
    let capturedVisitId = null;
    page.on("request", req => {
        if (req.url().includes("alkalimakersuite")) {
            const vid = req.headers()["x-aistudio-visit-id"];
            if (vid && !capturedVisitId) capturedVisitId = vid;
        }
    });

    console.log("[info] 导航 Canvas URL + Continue + wait for iframe");
    await page.goto("https://ai.studio/apps/c48c6178-8dad-4d16-8de7-bb78d265482c?showPreview=true&showAssistant=true", {
        waitUntil: "domcontentloaded", timeout: 60000 
    });
    await page.waitForTimeout(2000);
    try {
        await page.getByRole("button", { name: /continue to the app/i }).click({ timeout: 5000 });
    } catch (e) {}
    await page.waitForTimeout(8000);
    
    console.log(`\n[info] captured visit id from natural request: ${capturedVisitId}`);
    
    // Cookies
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
    
    console.log(`\n[test] 用自然捕获的 visit-id 调 ProxyUnaryCall`);
    const res = await page.evaluate(async ({ url, body, auth, visitId }) => {
        try {
            const r = await fetch(url, {
                method: "POST",
                credentials: "include",
                headers: {
                    "content-type": "application/json+protobuf",
                    "x-user-agent": "grpc-web-javascript/0.1",
                    "x-goog-api-key": "AIzaSyDdP816MREB3SkjZO04QXbjsigfcI0GWOs",
                    "x-goog-authuser": "0",
                    "x-aistudio-visit-id": visitId,
                    "authorization": auth,
                },
                body,
            });
            return { status: r.status, body: (await r.text()).slice(0, 2000) };
        } catch (e) { return { error: e.message }; }
    }, { url, body, auth: authHeader, visitId: capturedVisitId });
    console.log(`  status=${res.status}`);
    console.log(`  body=${(res.body || res.error || "").substring(0, 800)}`);
    
    await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
