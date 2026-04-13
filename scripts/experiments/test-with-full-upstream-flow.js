const { firefox } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// === 完全复制上游 BrowserManager.js 的 launchArgs 和 firefoxUserPrefs ===
const launchArgs = [];
const firefoxUserPrefs = {
    "app.update.enabled": false,
    "browser.cache.disk.enable": false,
    "browser.ping-centre.telemetry": false,
    "browser.safebrowsing.enabled": false,
    "browser.safebrowsing.malware.enabled": false,
    "browser.safebrowsing.phishing.enabled": false,
    "browser.search.update": false,
    "browser.shell.checkDefaultBrowser": false,
    "browser.tabs.warnOnClose": false,
    "datareporting.policy.dataSubmissionEnabled": false,
    "dom.min_background_timeout_value": 1,
    "dom.min_timeout_value": 1,
    "dom.min_tracking_background_timeout_value": 1,
    "dom.timeout.background_budget_regeneration_rate": 200,
    "dom.timeout.background_throttling_max_budget": 100,
    "dom.timeout.budget_throttling_max_delay": 0,
    "dom.timeout.throttling_delay": 2147483647,
    "dom.webnotifications.enabled": false,
    "extensions.update.enabled": false,
    "general.smoothScroll": false,
    "gfx.webrender.all": false,
    "layers.acceleration.disabled": true,
    "media.autoplay.default": 5,
    "media.volume_scale": "0.0",
    "network.dns.disablePrefetch": true,
    "network.http.speculative-parallel-limit": 0,
    "network.prefetch-next": false,
    "permissions.default.geo": 0,
    "services.sync.enabled": false,
    "toolkit.cosmeticAnimations.enabled": false,
    "toolkit.telemetry.archive.enabled": false,
    "toolkit.telemetry.enabled": false,
    "toolkit.telemetry.unified": false,
};

// === 复制上游的 privacy protection script (简化版,authIndex=0) ===
const privacyScript = `
    (function() {
        if (window._privacyProtectionInjected) return;
        window._privacyProtectionInjected = true;
        try {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            if (navigator.plugins.length === 0) {
                Object.defineProperty(navigator, 'plugins', { get: () => new Array(4) });
            }
            const getParameterProxy = WebGLRenderingContext.prototype.getParameter;
            WebGLRenderingContext.prototype.getParameter = function(parameter) {
                if (parameter === 37445) return 'Google Inc. (AMD)';
                if (parameter === 37446) return 'ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)';
                return getParameterProxy.apply(this, arguments);
            };
            window['_canvas_noise_123'] = '123';
            if (window === window.top) {
                console.log("[ProxyClient] Privacy protection layer active");
                window.addEventListener('message', function(event) {
                    if (event.data && event.data.type === 'requestAuthIndex') {
                        event.source.postMessage({type: 'authIndexResponse', authIndex: 0}, '*');
                    }
                });
            }
        } catch (err) {}
    })();
`;

(async () => {
    const authPath = path.resolve("configs/auth/auth-0.json");
    const auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    const camoufoxPath = path.resolve("camoufox-macos/Camoufox.app/Contents/MacOS/camoufox");
    
    console.log(`[info] Launching Camoufox with EXACT upstream settings...`);
    const browser = await firefox.launch({
        args: launchArgs,
        executablePath: camoufoxPath,
        firefoxUserPrefs,
        headless: true,
    });
    console.log(`[info] ✓ browser version: ${browser.version()}`);
    
    const randomWidth = 1920 + Math.floor(Math.random() * 50);
    const randomHeight = 1080 + Math.floor(Math.random() * 50);
    const context = await browser.newContext({
        deviceScaleFactor: 1,
        storageState: auth,
        viewport: { height: randomHeight, width: randomWidth },
    });
    
    // Inject privacy script BEFORE page creation (like upstream)
    await context.addInitScript(privacyScript);
    
    const page = await context.newPage();
    
    // Upstream does these too
    try {
        await page.bringToFront();
        await page.evaluate(() => window.focus());
    } catch (e) {}
    
    console.log("[info] Navigating Canvas URL...");
    await page.goto("https://ai.studio/apps/c48c6178-8dad-4d16-8de7-bb78d265482c?showPreview=true&showAssistant=true", {
        waitUntil: "domcontentloaded", timeout: 180000 
    });
    await page.waitForTimeout(2000);
    try {
        await page.getByRole("button", { name: /continue to the app/i }).click({ timeout: 5000 });
        console.log("[info] ✓ clicked Continue");
    } catch (e) {}
    await page.waitForTimeout(10000);
    
    // Compute auth with fresh cookies from the freshly-navigated context
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
    
    // 使用上游 successful 请求一样的 body 格式 (从 /tmp/upstream-run2.log 抓)
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
    
    console.log("\n[test] ProxyUnaryCall from FULL upstream flow");
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
    console.log(`  body=${(res.body || res.error || "").substring(0, 1500)}`);
    
    await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
