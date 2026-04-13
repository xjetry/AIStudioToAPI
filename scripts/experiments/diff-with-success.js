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
    
    let ourFailedRequest = null;
    page.on("request", req => {
        if (req.url().includes("ProxyUnaryCall")) {
            ourFailedRequest = {
                url: req.url(),
                method: req.method(),
                headers: req.headers(),
                postData: req.postData(),
            };
        }
    });

    console.log("[step] Full Canvas flow...");
    await page.goto("https://ai.studio/apps/c48c6178-8dad-4d16-8de7-bb78d265482c?showPreview=true&showAssistant=true", {
        waitUntil: "domcontentloaded", timeout: 60000 
    });
    await page.waitForTimeout(2000);
    try {
        await page.getByRole("button", { name: /continue to the app/i }).click({ timeout: 5000 });
    } catch (e) {}
    await page.waitForTimeout(8000);
    
    // Compute auth
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
            contents: [{ parts: [{ text: "hi" }], role: "user" }],
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
    
    console.log("[step] firing ProxyUnaryCall from page.evaluate");
    await page.evaluate(async ({ url, body, auth }) => {
        try {
            await fetch(url, {
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
        } catch (e) {}
    }, { url, body, auth: authHeader });
    
    await page.waitForTimeout(500);
    
    // 读 debug.log 里 02:58:28 成功的 request
    const successLines = fs.readFileSync("debug.log", "utf-8").split("\n");
    let successHeaders = null;
    for (const line of successLines) {
        if (line.includes("02:58:28.870") && line.includes("REQ* headers")) {
            const idx = line.indexOf("REQ* headers: ");
            successHeaders = JSON.parse(line.slice(idx + 14).trim());
            break;
        }
    }
    
    console.log("\n=== DIFF: SUCCESS (02:58:28 Camoufox) vs OUR FAILED (now Chromium) ===");
    
    const allKeys = new Set([
        ...Object.keys(successHeaders),
        ...Object.keys(ourFailedRequest.headers),
    ]);
    
    for (const k of [...allKeys].sort()) {
        const s = successHeaders[k];
        const f = ourFailedRequest.headers[k];
        if (s === f) {
            console.log(`  = ${k}: ${(s || "").substring(0, 60)}`);
        } else {
            console.log(`  ! ${k}:`);
            console.log(`      SUCCESS: ${(s || "(missing)").substring(0, 100)}`);
            console.log(`      OURS:    ${(f || "(missing)").substring(0, 100)}`);
        }
    }
    
    console.log("\n=== Body compare ===");
    const successBody = null; // we saved it earlier as postData in a different format
    console.log(`  OURS length: ${ourFailedRequest.postData.length}`);
    console.log(`  OURS first 200: ${ourFailedRequest.postData.substring(0, 200)}`);
    
    await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
