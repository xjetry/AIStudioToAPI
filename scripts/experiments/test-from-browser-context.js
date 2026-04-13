const { chromium } = require('playwright');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

(async () => {
    const authPath = path.resolve("configs/auth/auth-0.json");
    const auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: auth });
    const page = await context.newPage();
    
    console.log("[info] navigating to aistudio.google.com ...");
    await page.goto("https://aistudio.google.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);
    
    // 从 page context 里调 fetch —— TLS fingerprint、HTTP/2 握手都是浏览器本尊
    console.log("[info] calling fetch() from page evaluate context...");
    const result = await page.evaluate(async () => {
        // 在 aistudio.google.com 主 frame 的 JS 上下文里，cookies 自动带上
        // SAPISIDHASH 还是需要自己算，但可以用 crypto.subtle
        const ORIGIN = "https://aistudio.google.com";
        const getCookie = (name) => {
            const m = document.cookie.match(new RegExp("(?:^|; )" + name.replace(/[\-\.\+\*]/g, "\\$&") + "=([^;]*)"));
            return m ? m[1] : null;
        };
        // 不使用 http-only cookies (js 拿不到),所以 SAPISID 系列拿不到
        console.log("document.cookie names:", document.cookie.split(";").map(c => c.trim().split("=")[0]));
        
        // 尝试不在 js 里算 auth,让浏览器自动带 cookie (credentials: 'include')
        // 但这样 authorization header 怎么生成? 先试试不加 authorization 看错误有没有变
        const body = JSON.stringify([
            "/v1beta/models/gemini-2.5-flash:generateContent",
            JSON.stringify({
                contents: [{ parts: [{ text: "hi from browser" }], role: "user" }],
                generationConfig: {},
                safetySettings: [
                    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
                ],
            }),
        ]);
        
        try {
            // Attempt 1: no authorization header
            const r1 = await fetch(
                "https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/ProxyUnaryCall",
                {
                    method: "POST",
                    credentials: "include",
                    headers: {
                        "content-type": "application/json+protobuf",
                        "x-user-agent": "grpc-web-javascript/0.1",
                        "x-goog-api-key": "AIzaSyDdP816MREB3SkjZO04QXbjsigfcI0GWOs",
                        "x-goog-authuser": "0",
                        "x-goog-ext-519733851-bin": "CAASAUIwATgEQABQBFgDYgJVUw==",
                    },
                    body,
                }
            );
            const text = await r1.text();
            return { attempt: "no-auth-header", status: r1.status, body: text.slice(0, 500) };
        } catch (e) {
            return { attempt: "no-auth-header", error: e.message };
        }
    });
    
    console.log("[result]", JSON.stringify(result, null, 2));
    
    // Attempt 2: 用 Playwright Node 侧算 SAPISIDHASH 注入到 page.evaluate
    console.log("\n[info] attempt 2: generating SAPISIDHASH in Node (from http-only cookies)...");
    const cookies = await context.cookies("https://aistudio.google.com/");
    const map = Object.fromEntries(cookies.map(c => [c.name, c.value]));
    
    const ORIGIN = "https://aistudio.google.com";
    const makeField = (cv) => {
        const ts = Math.floor(Date.now() / 1000);
        const sha1 = crypto.createHash("sha1").update(`${ts} ${cv} ${ORIGIN}`).digest("hex");
        return `${ts}_${sha1}`;
    };
    const authHdr = [
        `SAPISIDHASH ${makeField(map["SAPISID"])}`,
        `SAPISID1PHASH ${makeField(map["__Secure-1PAPISID"])}`,
        `SAPISID3PHASH ${makeField(map["__Secure-3PAPISID"])}`,
    ].join(" ");
    
    const result2 = await page.evaluate(async (authHeader) => {
        const body = JSON.stringify([
            "/v1beta/models/gemini-2.5-flash:generateContent",
            JSON.stringify({
                contents: [{ parts: [{ text: "hi from browser" }], role: "user" }],
                generationConfig: {},
                safetySettings: [
                    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
                ],
            }),
        ]);
        try {
            const r = await fetch(
                "https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/ProxyUnaryCall",
                {
                    method: "POST",
                    credentials: "include",
                    headers: {
                        "content-type": "application/json+protobuf",
                        "x-user-agent": "grpc-web-javascript/0.1",
                        "x-goog-api-key": "AIzaSyDdP816MREB3SkjZO04QXbjsigfcI0GWOs",
                        "x-goog-authuser": "0",
                        "x-goog-ext-519733851-bin": "CAASAUIwATgEQABQBFgDYgJVUw==",
                        "authorization": authHeader,
                    },
                    body,
                }
            );
            return { status: r.status, body: (await r.text()).slice(0, 1000) };
        } catch (e) {
            return { error: e.message };
        }
    }, authHdr);
    
    console.log("[result2]", JSON.stringify(result2, null, 2));
    
    await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
