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
    
    console.log("[info] 导航到 aistudio.google.com ...");
    await page.goto("https://aistudio.google.com/prompts/new_chat", { 
        waitUntil: "domcontentloaded", timeout: 60000 
    });
    await page.waitForTimeout(5000);
    
    // 从 cookies 算 SAPISIDHASH
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
    
    // 测试 1: ProxyUnaryCall 不带 x-goog-ext-519733851-bin
    const body = JSON.stringify([
        "/v1beta/models/gemini-2.5-flash:generateContent",
        JSON.stringify({
            contents: [{ parts: [{ text: "hi, say exactly one word" }], role: "user" }],
            generationConfig: {},
            safetySettings: [
                { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
            ],
        }),
    ]);
    
    const urlPath = "/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/ProxyUnaryCall";
    const fullUrl = "https://alkalimakersuite-pa.clients6.google.com" + urlPath;
    
    // Test A: 无 x-goog-ext-519733851-bin
    console.log("\n[test A] ProxyUnaryCall, 不带 ext-bin");
    const resA = await page.evaluate(async ({ url, body, auth }) => {
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
            return { status: r.status, body: (await r.text()).slice(0, 1500) };
        } catch (e) { return { error: e.message }; }
    }, { url: fullUrl, body, auth: authHeader });
    console.log(`status=${resA.status}`);
    console.log(`body=${(resA.body || resA.error || "").slice(0, 1200)}`);
    
    // Test B: 带 x-goog-ext-519733851-bin
    console.log("\n[test B] ProxyUnaryCall, 带 ext-bin");
    const resB = await page.evaluate(async ({ url, body, auth }) => {
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
            return { status: r.status, body: (await r.text()).slice(0, 1500) };
        } catch (e) { return { error: e.message }; }
    }, { url: fullUrl, body, auth: authHeader });
    console.log(`status=${resB.status}`);
    console.log(`body=${(resB.body || resB.error || "").slice(0, 1200)}`);
    
    await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
