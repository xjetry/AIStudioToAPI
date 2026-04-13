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
    
    // 捕获 alkalimakersuite 请求看流程
    const alkaliReqs = [];
    page.on("request", req => {
        if (req.url().includes("alkalimakersuite")) {
            const methodName = req.url().split("MakerSuiteService/")[1] || "";
            alkaliReqs.push({ time: Date.now(), method: methodName });
        }
    });
    page.on("response", async resp => {
        if (resp.url().includes("alkalimakersuite")) {
            const methodName = resp.url().split("MakerSuiteService/")[1] || "";
            console.log(`  → ${resp.status()} ${methodName}`);
        }
    });

    console.log("[step 1] 导航到 Canvas app URL (走完整流程)");
    await page.goto("https://ai.studio/apps/c48c6178-8dad-4d16-8de7-bb78d265482c?showPreview=true&showAssistant=true", {
        waitUntil: "domcontentloaded", timeout: 60000 
    });
    await page.waitForTimeout(3000);
    
    // 点 Continue to the app
    console.log("\n[step 2] 点 Continue to the app");
    try {
        await page.getByRole("button", { name: /continue to the app/i }).click({ timeout: 5000 });
        console.log("  ✓ clicked");
    } catch (e) {
        console.log("  ⚠ no continue button:", e.message.substring(0, 80));
    }
    
    // 等 Canvas iframe 加载起来
    console.log("\n[step 3] 等 5 秒让 Canvas iframe 加载");
    await page.waitForTimeout(5000);
    
    const frames = page.frames();
    console.log(`\n[step 4] 现在 page 有 ${frames.length} 个 frame:`);
    for (const f of frames) {
        console.log(`  - ${f.url().substring(0, 100)}`);
    }
    
    // 这时候试 ProxyUnaryCall
    console.log("\n[step 5] 用 main frame page.evaluate 试 ProxyUnaryCall");
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
    
    const res1 = await page.evaluate(async ({ url, body, auth }) => {
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
            return { status: r.status, body: (await r.text()).slice(0, 2000) };
        } catch (e) { return { error: e.message }; }
    }, { url, body, auth: authHeader });
    console.log(`\n[test 从 main frame aistudio.google.com 调 ProxyUnaryCall]`);
    console.log(`  status=${res1.status}`);
    console.log(`  body=${(res1.body || res1.error || "").slice(0, 800)}`);
    
    // 也试从 iframe context 调
    const canvasFrame = frames.find(f => f.url().includes("run.app") || f.url().includes("usercontent"));
    if (canvasFrame) {
        console.log(`\n[test 从 Canvas iframe (${canvasFrame.url().substring(0, 60)}...) 调 ProxyUnaryCall]`);
        try {
            const res2 = await canvasFrame.evaluate(async ({ url, body, auth }) => {
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
                    return { status: r.status, body: (await r.text()).slice(0, 2000) };
                } catch (e) { return { error: e.message }; }
            }, { url, body, auth: authHeader });
            console.log(`  status=${res2.status}`);
            console.log(`  body=${(res2.body || res2.error || "").slice(0, 800)}`);
        } catch (e) {
            console.log(`  iframe evaluate failed: ${e.message.substring(0, 100)}`);
        }
    }
    
    console.log(`\n[summary] 自然捕获的 alkalimakersuite 请求共 ${alkaliReqs.length} 次:`);
    const methodSet = [...new Set(alkaliReqs.map(r => r.method))];
    console.log(`  unique methods: ${methodSet.join(", ")}`);
    
    await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
