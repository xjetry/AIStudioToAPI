const { firefox, chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// 尝试用 playwright 的 firefox（和 Camoufox 最接近）
(async () => {
    const authPath = path.resolve("configs/auth/auth-0.json");
    const auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    
    // 优先 firefox
    let browser;
    try {
        browser = await firefox.launch({ headless: true });
        console.log("[info] using firefox");
    } catch (e) {
        console.log("[info] firefox not available, trying chromium:", e.message);
        browser = await chromium.launch({ headless: true });
    }
    
    const context = await browser.newContext({ storageState: auth });
    const page = await context.newPage();
    
    console.log("[info] navigating to aistudio.google.com ...");
    await page.goto("https://aistudio.google.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);
    
    const cookies = await context.cookies("https://aistudio.google.com/");
    const gcookies = cookies.filter(c => c.domain.endsWith(".google.com"));
    
    console.log(`[info] got ${gcookies.length} .google.com cookies`);
    const map = Object.fromEntries(gcookies.map(c => [c.name, c.value]));
    
    const needed = ["SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID",
                     "__Secure-1PSID", "__Secure-3PSID", "__Secure-1PSIDCC",
                     "__Secure-3PSIDCC", "NID", "SSID", "__Secure-1PSIDTS", "__Secure-3PSIDTS"];
    for (const n of needed) {
        console.log(`  ${n}: ${(map[n] || "(missing)").substring(0, 30)}...`);
    }
    
    const cookieHeader = gcookies.map(c => `${c.name}=${c.value}`).join("; ");
    fs.writeFileSync("/tmp/fresh-cookies.json", JSON.stringify({
        cookieMap: map,
        cookieHeader,
        allCookies: gcookies,
    }, null, 2));
    console.log("[info] saved to /tmp/fresh-cookies.json");
    
    await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
