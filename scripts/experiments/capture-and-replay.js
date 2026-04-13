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

    // 捕获所有 alkalimakersuite 请求
    const captures = [];
    page.on("request", req => {
        if (req.url().includes("alkalimakersuite")) {
            captures.push({
                url: req.url(),
                method: req.method(),
                headers: req.headers(),
                postData: req.postData(),
                ts: Date.now(),
            });
        }
    });
    page.on("response", async resp => {
        if (resp.url().includes("alkalimakersuite")) {
            console.log(`[captured-response] ${resp.status()} ${resp.url().substring(0, 80)}`);
        }
    });

    console.log("[info] 导航到 aistudio.google.com/prompts/new_chat ...");
    await page.goto("https://aistudio.google.com/prompts/new_chat", { 
        waitUntil: "domcontentloaded", timeout: 60000 
    });
    await page.waitForTimeout(8000);

    console.log(`[info] 捕获到 ${captures.length} 个 alkalimakersuite 请求`);
    if (captures.length === 0) {
        console.log("[warn] 没捕获到 — aistudio 主页可能没自发触发 makersuite RPC");
        await browser.close();
        return;
    }

    // 打印每个请求的 authorization header 和响应状态
    for (const c of captures) {
        console.log(`\n--- 请求 ${c.ts} ---`);
        console.log(`  URL: ${c.url.substring(c.url.indexOf("$rpc"))}`);
        console.log(`  method: ${c.method}`);
        console.log(`  auth header first 80: ${(c.headers.authorization || "").substring(0, 80)}`);
        console.log(`  has cookie header: ${!!c.headers.cookie}`);
        console.log(`  x-goog-api-key: ${c.headers["x-goog-api-key"]}`);
        console.log(`  x-aistudio-visit-id: ${c.headers["x-aistudio-visit-id"]}`);
        console.log(`  x-goog-ext-519733851-bin: ${c.headers["x-goog-ext-519733851-bin"]}`);
    }

    // 把第一个成功的请求的完整 headers 存下来
    fs.writeFileSync("/tmp/captured-rpc.json", JSON.stringify(captures, null, 2));
    console.log("\n[info] saved all captures to /tmp/captured-rpc.json");

    // 现在 REPLAY — 用同一个 context 里 page.evaluate 再发一次,完全复制 headers (除了 authorization 自己算)
    const first = captures[0];
    const authHeader = first.headers.authorization;
    console.log(`\n[replay] 用 page.evaluate 在同一个 page 上 replay,完全复制原 headers + 自算 SAPISIDHASH`);
    
    // 方案 A: 直接用原始 authorization 
    const resA = await page.evaluate(async ({ url, postData, headers }) => {
        try {
            // Remove forbidden/auto headers
            const clean = {};
            const forbidden = ["host", "content-length", "connection", "accept-encoding"];
            for (const [k, v] of Object.entries(headers)) {
                if (!forbidden.includes(k.toLowerCase())) clean[k] = v;
            }
            const r = await fetch(url, { method: "POST", credentials: "include", headers: clean, body: postData });
            return { status: r.status, body: (await r.text()).slice(0, 500) };
        } catch (e) { return { error: e.message }; }
    }, first);
    console.log(`[replay A — 用原 authorization] status=${resA.status} body=${(resA.body || resA.error || "").slice(0, 200)}`);

    // 方案 B: 自算 SAPISIDHASH
    const cookies = await context.cookies("https://aistudio.google.com/");
    const map = Object.fromEntries(cookies.map(c => [c.name, c.value]));
    const ORIGIN = "https://aistudio.google.com";
    const mkField = (cv) => {
        const ts = Math.floor(Date.now() / 1000);
        return `${ts}_${crypto.createHash("sha1").update(`${ts} ${cv} ${ORIGIN}`).digest("hex")}`;
    };
    const myAuth = [
        `SAPISIDHASH ${mkField(map["SAPISID"])}`,
        `SAPISID1PHASH ${mkField(map["__Secure-1PAPISID"])}`,
        `SAPISID3PHASH ${mkField(map["__Secure-3PAPISID"])}`,
    ].join(" ");
    
    const resB = await page.evaluate(async ({ url, postData, headers, myAuth }) => {
        try {
            const clean = { ...headers, authorization: myAuth };
            const forbidden = ["host", "content-length", "connection", "accept-encoding"];
            for (const f of forbidden) delete clean[f];
            const r = await fetch(url, { method: "POST", credentials: "include", headers: clean, body: postData });
            return { status: r.status, body: (await r.text()).slice(0, 500) };
        } catch (e) { return { error: e.message }; }
    }, { url: first.url, postData: first.postData, headers: first.headers, myAuth });
    console.log(`[replay B — 自算 authorization] status=${resB.status} body=${(resB.body || resB.error || "").slice(0, 200)}`);

    await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
