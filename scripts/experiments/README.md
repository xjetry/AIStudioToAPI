# 实验脚本索引

本目录是 **2026-04-13** 对"AIStudioToAPI 如何绕过 Google `ProxyUnaryCall` 反爬"以及"哪些浏览器内核能用"的**全部实地测试脚本**归档。

**所有脚本都是独立可跑的,用于证明/证伪某个假设**。不是项目运行时代码。

阅读顺序: 先看 [`docs/reverse-engineering/ai-studio-mechanism.md`](../../docs/reverse-engineering/ai-studio-mechanism.md)(真相文档)和 [`browser-kernel-exploration.md`](../../docs/reverse-engineering/browser-kernel-exploration.md)(内核探索),然后按需查对应脚本。

---

## 机制探索 (assumed 已失效,只作参考)

这些脚本对应我们在未搞清楚真相前的各种假设,最终全被证伪。

| 脚本 | 假设 | 结果 |
|------|------|------|
| `fresh-cookies.js` | 用 Playwright 从 auth-0.json 拿最新 cookies | ✅ 能拿到,但用它们直接打 ProxyUnaryCall 还是 403 |
| `test-from-browser-context.js` | 从 page.evaluate 内调 fetch 有没有特殊凭据效果 | ❌ 一样 403 |
| `capture-access-token.js` | 抓 `GenerateAccessToken` 返回的 ya29 token,猜 ProxyUnaryCall 用它认证 | ❌ 不用,ProxyUnaryCall 用 SAPISIDHASH |
| `capture-and-replay.js` | 抓 page 自然触发的 RPC + replay | ✅ 简单 RPC 能 replay (200),但 `ProxyUnaryCall` 不能 (403) |
| `diff-with-success.js` | 比对成功请求和我们失败请求的 header diff | ✅ 发现 `sec-ch-ua-full-version-list` 泄露 HeadlessChrome (后来发现这不是根因) |
| `test-with-captured-visit-id.js` | 猜 visit-id 必须从自然捕获里来 | ❌ 不是 |
| `test-after-canvas.js` | 猜 Canvas 页面要先完整加载才能 ProxyUnaryCall | ❌ 完整加载了也 403 |
| `test-strip-chhints.js` | 剥离 sec-ch-ua headers 看是否还 403 | ❌ 还是 403 |
| `test-generate-content.js` | 测试从 Playwright page context 直接发 ProxyUnaryCall | ❌ 403,验证了"必须走 shim + parent handler" |

## 浏览器内核测试 (决策性)

这些是决定"哪个内核能用"的关键测试。结果汇总见 [`docs/reverse-engineering/browser-kernel-exploration.md`](../../docs/reverse-engineering/browser-kernel-exploration.md) §3。

| 脚本 | 内核 | 独立测试结果 | 完整 upstream 测试 |
|------|------|--------|--------|
| `test-firefox.js` | Playwright vanilla Firefox | ❌ 403 | 未测 |
| `test-firefox-ua.js` | Playwright Chromium + Firefox UA 伪装 | ❌ 403 | 未测 |
| `test-firefox-no-webdriver.js` | vanilla Firefox + `navigator.webdriver=false` patch | ❌ 403 | 未测 |
| `test-with-camoufox.js` | 本机 Camoufox 二进制 via `firefox.launch + executablePath` | ❌ page.evaluate 403(预期) | **✅ 200**(上游 v1.2.1 本体) |
| `test-with-full-upstream-flow.js` | 完整复制上游 launchArgs + firefoxUserPrefs + privacy script | ❌ page.evaluate 403(验证了必须走 shim) | — |
| `test-with-rebrowser.js` | rebrowser-playwright (Chromium stealth patches) | ❌ 403 | ❌ 未跑 full flow (agent 报告) |
| `test-chrome-channel-headless.js` | Real Google Chrome 二进制 via `channel:'chrome', headless:true` | ❌ 403 | — |
| `test-chrome-channel-headed.js` | Real Google Chrome 二进制,headed 模式 | ❌ 403(即便 UA/brands 都完全干净) | — |
| `test-puppeteer-real-browser.js` | puppeteer-real-browser (实 Chrome + xvfb 思路) | ⚠️ agent 未完成测试 (cwd 问题) | — |

## 结论速查

**唯一能过的内核是 Firefox 家族 + C++ 层 patch**(Camoufox / camoufox-js)。所有 Chromium 系方案无论怎么 patch JS 层都会被 Google 在 TCP/TLS 层(JA3 指纹)拦下。详细解释见 `browser-kernel-exploration.md` §4.2。

**`camoufox-js`**(Apify 维护的 Node 端口) 经实测可通过完整 upstream 流程,是推荐的最终方向。迁移指引见 `browser-kernel-exploration.md` §5。

## 如何运行这些脚本

大部分脚本:
```bash
node scripts/experiments/<script-name>.js
```

**前提**:
- `configs/auth/auth-0.json` 存在且仍然有效(未过期)
- 对应的 npm 包已安装(某些脚本测试时临时 `npm install --no-save` 了包,跑完又卸了,看脚本头部注释)
- `camoufox-macos/Camoufox.app/Contents/MacOS/camoufox` 存在(本机 Camoufox binary,仅 macOS 测试用)

**一些脚本** 会修改 `src/core/BrowserManager.js` 或启动完整 server,看脚本内部注释。

## 清理提示

这些是**归档**文件,不是生产代码。如果某天项目要瘦身,可以整个目录删掉,只保留 `docs/reverse-engineering/` 里的文档作为历史证据。
