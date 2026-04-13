const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
    const authPath = path.resolve("configs/auth/auth-0.json");
    const auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: auth });
    const page = await context.newPage();
    
    const accessTokenResponses = [];
    const capturedReqs = [];
    
    page.on("request", req => {
        if (req.url().includes("alkalimakersuite")) {
            const m = req.url().split("MakerSuiteService/")[1] || "";
            capturedReqs.push({
                method: m,
                headers: req.headers(),
                postData: req.postData(),
                time: Date.now(),
            });
        }
    });
    page.on("response", async resp => {
        if (resp.url().includes("GenerateAccessToken")) {
            try {
                const body = await resp.text();
                accessTokenResponses.push({ status: resp.status(), body });
                console.log(`[GenerateAccessToken RESP] status=${resp.status()}`);
                console.log(`  body: ${body.substring(0, 600)}`);
            } catch (e) {}
        }
    });

    console.log("[info] 导航 Canvas URL 走完整流程...");
    await page.goto("https://ai.studio/apps/c48c6178-8dad-4d16-8de7-bb78d265482c?showPreview=true&showAssistant=true", {
        waitUntil: "domcontentloaded", timeout: 60000 
    });
    await page.waitForTimeout(3000);
    try {
        await page.getByRole("button", { name: /continue to the app/i }).click({ timeout: 5000 });
    } catch (e) {}
    await page.waitForTimeout(8000);
    
    console.log(`\n[info] 捕获到 ${capturedReqs.length} 个请求`);
    
    // 对比 GenerateAccessToken 和 ListPrompts(类似简单方法) 的 authorization header
    const genTok = capturedReqs.find(r => r.method.startsWith("GenerateAccessToken"));
    const listCfg = capturedReqs.find(r => r.method.startsWith("ListCodeAssistantConfigurations"));
    
    if (genTok) {
        console.log(`\n[GenerateAccessToken REQ headers keys]: ${Object.keys(genTok.headers).join(", ")}`);
        console.log(`  auth header: ${(genTok.headers.authorization || "(none)").substring(0, 100)}...`);
        console.log(`  postData: ${(genTok.postData || "").substring(0, 200)}`);
    }
    if (listCfg) {
        console.log(`\n[ListCfg auth header]: ${(listCfg.headers.authorization || "(none)").substring(0, 100)}...`);
    }
    
    // 关键:看看 GenerateAccessToken 返回了什么 token
    console.log(`\n[GenerateAccessToken responses captured: ${accessTokenResponses.length}]`);
    for (const r of accessTokenResponses) {
        console.log(`  status=${r.status}, body first 500 chars:`);
        console.log(`  ${r.body.substring(0, 500)}`);
    }
    
    // 把所有信息存下来
    fs.writeFileSync("/tmp/gen-token-capture.json", JSON.stringify({
        capturedReqs: capturedReqs.map(r => ({
            ...r,
            cookie: r.headers.cookie ? r.headers.cookie.substring(0, 100) + "..." : undefined,
        })),
        accessTokenResponses,
    }, null, 2));
    console.log("\n[info] saved to /tmp/gen-token-capture.json");
    
    await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
