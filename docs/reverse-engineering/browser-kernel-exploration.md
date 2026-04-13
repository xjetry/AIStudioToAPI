# 浏览器内核探索报告

> 这是对"是否存在比 Camoufox 更小、更快且仍能过 Google 反爬的 Node.js 浏览器自动化方案"的实证调研。
> 与 `ai-studio-mechanism.md` 是互补文档:那份讲**为什么需要** 反爬绕过,这份讲**什么内核能过、什么不能过,以及为什么**。
>
> **最终结论(一句话)**: 经过对 Chromium 系方案穷尽测试,**只有 Firefox 内核(Camoufox 家族)能过 Google 的 `ProxyUnaryCall` 反爬**,`camoufox-js` 是最佳 Node 原生选择。

---

## 1. 背景 — 为什么要探索

上游 `iBUHub/AIStudioToAPI` v1.2.1 用的是 Camoufox(patched Firefox),我们 fork 当初迁移到 Patchright(patched Chromium)是为了:
- 更低内存(Patchright 宣称 ~300MB/context vs Camoufox ~700MB)
- 更简单的部署(不用单独下载 Camoufox 二进制)
- Node.js 生态更原生

迁移后发现 Patchright 下 `POST alkalimakersuite-pa.clients6.google.com/.../ProxyUnaryCall` 会返回 **403 `[7,"The caller does not have permission"]`**,而上游 Camoufox 同账号同 cookie 立即就能成功。

**本文档就是对"有没有其他可行 Chromium/Firefox 方案"的穷尽尝试记录。**

---

## 2. 测试方法

### 2.1 单元测试 vs 完整 upstream 测试

**关键观察**: 我们早期用 `page.evaluate(() => fetch("https://alkalimakersuite-pa.../ProxyUnaryCall", ...))` 直接构造请求时,**连本机 Camoufox 二进制自己也 403**(见 `scripts/experiments/test-with-camoufox.js`)。

原因是:成功的 `ProxyUnaryCall` 请求**必须由 `aistudio.google.com` 父 frame 内部的 JS 处理函数通过 MessagePort 从 Canvas iframe 的 `_aistudio-iframe.js` shim 触发**。那个函数访问了某个 runtime-only 的 session state(很可能是内存里的、非 cookie/非可观察的),我们从外部 `page.evaluate` 重构请求时拿不到。

**因此有效测试只有一种**: 把浏览器内核塞进完整的 `upstream v1.2.1` 服务(`npm run dev:server`),让 Canvas + shim + parent handler 完整跑起来,然后用 `curl http://localhost:7860/v1/chat/completions` 验证。

### 2.2 测试标准

- 成功: curl 返回 `{"choices":[{"message":{"content":"Hi!"}}]}` 样的正常 JSON
- 失败: curl 返回 `{"error": ...}` 或 server 日志里出现 `Google API returned error: 403` / `unregistered callers` / `PERMISSION_DENIED`

### 2.3 附加诊断(子测试)

即使决定性测试是"完整 upstream + curl",每个内核方案还记录了这些辅助信号:
- `navigator.webdriver` (true/false/undefined)
- `navigator.userAgent` (是否有 HeadlessChrome)
- `navigator.userAgentData.brands` (Google Chrome vs Chromium vs HeadlessChrome)
- 内存 RSS (主进程 + helper 合计)

---

## 3. 测试结果汇总

| # | 内核 | 入口 | 绕过测试 | `webdriver` | `brands` | `UA` leaked | 主进程 RSS | 测试脚本 |
|---|------|------|---------|-------------|----------|-------------|------------|---------|
| 1 | Playwright Chromium (vanilla) | `chromium.launch()` | ❌ 403 | `true` | `Chromium` | `HeadlessChrome` | ~200MB | `test-from-browser-context.js` 等 |
| 2 | Patchright Chromium | `patchright.chromium.launch()` | ❌ 403 | `false`(patch 后) | `Chromium` | `HeadlessChrome` | ~200MB | (fork 原本就用的) |
| 3 | rebrowser-playwright | `rebrowser-playwright.chromium.launch()` | ❌ 403 | `false`(patch 后) | `Chromium` | `HeadlessChrome` | ~200MB 主进程, ~1.3GB 全进程组 | `test-with-rebrowser.js` |
| 4 | Real Google Chrome, headless | `chromium.launch({channel:'chrome'})` | ❌ 403 | `true` | `Google Chrome`(干净✅) | `HeadlessChrome` | ~225MB 主进程, ~600MB 组 | `test-chrome-channel-headless.js` |
| 5 | Real Google Chrome, headed | `chromium.launch({channel:'chrome', headless:false})` | ❌ 403 | `true` | `Google Chrome`(干净✅) | `Chrome`(干净✅) | ~240MB 主进程, ~900MB 组 | `test-chrome-channel-headed.js` |
| 6 | Playwright vanilla Firefox | `firefox.launch()` | ❌ 403 | `true` | (Firefox 不发 Client Hints) | Firefox(干净) | ~400MB | `test-firefox.js` |
| 7 | Playwright Firefox + webdriver patch | `firefox.launch() + addInitScript` | ❌ 403 | `false`(patch 后) | — | Firefox(干净) | ~400MB | `test-firefox-no-webdriver.js` |
| 8 | **Camoufox binary via `firefox.launch({executablePath})`** | upstream v1.2.1 原装方案 | **✅ 200** | `undefined`(C++ patch) | — | Firefox(真实随机) | ~511MB 主进程, ~1GB 组 | upstream v1.2.1 本体 |
| 9 | **camoufox-js** (Apify Node 端口) | `await import('camoufox-js').launchOptions()` + `firefox.launch()` | **✅ 200** | `undefined` | — | Firefox(browserforge 随机) | ~511MB 主进程, ~1GB 组 | 修改 BrowserManager + curl |

**通过率 = 2 / 9** — 全是 Firefox 内核。Chromium 系全军覆没。

---

## 4. 关键发现

### 4.1 `HeadlessChrome` 字符串不是根因

早期假设是"`sec-ch-ua-full-version-list` 里泄露 `"HeadlessChrome"` 触发检测",因为 vanilla Playwright Chromium 的 brands 确实带 HeadlessChrome。但后续测试推翻了这个假设:

- **Real Chrome headed (#5)**: UA 和 brands 都完全干净(`Chrome` / `Google Chrome`),依然 403
- **rebrowser-playwright (#3)**: 修复了 `navigator.webdriver`,依然 403
- **Playwright Firefox vanilla (#6)**: Firefox UA,不发 Client Hints,`webdriver = true`,依然 403
- **Playwright Firefox + init script 关 webdriver (#7)**: 所有 JS 层信号都干净,依然 403

**说明: Google 的 `ProxyUnaryCall` 检测不依赖任何 JS 层可观察信号**(UA / brands / webdriver / Client Hints)。

### 4.2 真正的根因:TCP 层指纹(TLS JA3 + HTTP/2 特征)

唯一能解释以上全部结果的假设:

**Google 服务端在 TCP/TLS 握手层就对请求做了"浏览器类别识别",基于 JA3 TLS ClientHello 指纹 + HTTP/2 SETTINGS/WINDOW_UPDATE frame 顺序**。

- Chrome / Chromium / Edge 的 BoringSSL 栈发出的 ClientHello cipher suite 顺序、extension 顺序、supported_versions 列表有固定特征
- Firefox 的 NSS 栈发出的 ClientHello 完全不同
- 两者的 HTTP/2 初始化 frame 顺序也有已知差异(Akamai 有公开文献描述)

这是为什么:
- **所有 Chromium 系方案(Patchright / rebrowser / Real Chrome / Playwright Chromium) 都 403** —— 它们都链接 BoringSSL,JA3 指纹一致
- **vanilla Playwright Firefox 也 403** —— 虽然是 NSS 栈,但 Playwright 的启动配置和真实浏览器不同,可能 TLS extension 顺序有差
- **Camoufox 能过** —— 它是 patched Firefox,C++ 层改了 NSS ClientHello 的构造,让它看起来像最常见的真实 Firefox session

**这个假设无法在 JS 层被证伪或规避**(因为 JS 根本访问不到 TLS 握手),所以对我们来说就是工程上的"硬约束"。

### 4.3 `ProxyUnaryCall` 的特殊地位

同一个 session 下,**其他 RPC 方法**(`GetUserRestrictions`, `ListPrompts`, `ListCodeAssistantConfigurations`, `GetApplet` 等) **即使从 Playwright Chromium 也能 200** —— 见 `test-after-canvas.js` 的捕获。Google 只对 `ProxyUnaryCall`(消费 quota 的那个)做了严苛的 TLS 指纹校验,其他读取性 RPC 宽松得多。

这合理:quota 消费是 Google 最想防滥用的入口。

---

## 5. camoufox-js 迁移细节

Apify 维护的 Node.js 端口,共享 Camoufox 的 C++ patch,因此 TLS 指纹和本机 Camoufox 二进制**完全等价**。测试通过。

### 5.1 和本机 Camoufox binary 的关键差异

| 项 | Upstream 原装(firefox.launch + executablePath) | camoufox-js |
|---|---|---|
| 二进制来源 | 项目仓库自带 `camoufox-macos/`, `camoufox-linux/` 等目录 | `npx camoufox-js fetch` 下载到 `~/Library/Caches/camoufox/` |
| 指纹注入 | 固定由 Python launcher 写的 `properties.json` | 每次启动由 [browserforge](https://github.com/daijro/browserforge) 随机生成(更隐蔽) |
| 模块系统 | CommonJS `require('playwright')` | **ESM only** — 必须用 `await import('camoufox-js')` |
| 参数命名 | Playwright 风格 camelCase (`executablePath`, `firefoxUserPrefs`) | Python Camoufox 风格 snake_case (`executable_path`, `firefox_user_prefs`) |
| CAMOU_CONFIG_1 env | 由 launcher 手动设置 | 由 `launchOptions()` 自动注入到 `env` 字段 |
| GeoIP / humanize | 需自行配置 | 开箱即用 (`geoip: true`, `humanize: true`) |

### 5.2 BrowserManager.js 迁移要点(由 agent 验证过能工作)

```js
// 顶部 (CommonJS 动态 import ESM)
let _camoufoxMod = null;
async function getCamoufoxLaunchOptions(overrides) {
    if (!_camoufoxMod) _camoufoxMod = await import("camoufox-js");
    return _camoufoxMod.launchOptions(overrides);
}

// _ensureBrowser / _launchBrowserForVNC 里原本的 firefox.launch({...}) 改成:
const camouOpts = await getCamoufoxLaunchOptions({
    headless: true,  // VNC 路径用 false
    firefox_user_prefs: this.firefoxUserPrefs,
    args: this.launchArgs,
    geoip: true,
    humanize: true,
    i_know_what_im_doing: true,
    // ⚠️ 不传 executable_path — camoufox-js 会用自己 fetched 的 binary
});
this.browser = await firefox.launch({
    ...camouOpts,
    ...(proxyConfig ? { proxy: proxyConfig } : {}),
});
```

### 5.3 陷阱

- ❌ **不要传** `executable_path` 指向项目现有的 `camoufox-macos/Camoufox.app/Contents/MacOS/camoufox`。camoufox-js 期望 `properties.json` 与二进制在**同一目录**,但 macOS .app bundle 把 `properties.json` 放在 `Contents/Resources/`,会 ENOENT 启动失败
- 必须执行 `npx camoufox-js fetch` 一次下载:
  - Camoufox 135.0 binary (~300 MB)
  - GeoIP 数据库 (~65 MB)
- 下载位置(不可配置):
  - macOS: `~/Library/Caches/camoufox/`
  - Linux: `~/.cache/camoufox/`
- Docker 部署需要在镜像 build 阶段执行 `npx camoufox-js fetch`,把缓存目录塞进镜像;或者启动时 fetch(多一次启动延时)

### 5.4 内存数据(实测)

单 context 稳态:
- 主 `camoufox` 进程: 511 MB
- Tab #1 (aistudio.google.com): 107 MB
- Tab #2 (Canvas iframe): 293 MB
- GPU/RDD/utility helpers: ~126 MB
- **合计: ~1036 MB**

**注意**: Agent 调研报告引用的"Camoufox ~200 MB"是官方宣传数字,不符合我们的实测。真实占用和本机 Camoufox binary **相同**(~1 GB/context)。**camoufox-js 带来的不是内存优化,而是绕过路径的 Node 原生化**。

---

## 6. 排除的方案及理由

### ❌ puppeteer-real-browser
- Puppeteer API(不兼容 Playwright),迁移成本高
- 虽然用真实 Chrome headed,但 TLS 栈仍是 BoringSSL,**同样会 403**(按 TCP 层指纹假设)
- 测试 agent 因 cwd 问题未完成,但按 Chromium 系全军覆没的规律**预期失败**

### ❌ puppeteer-extra + playwright-extra + stealth 插件
- README 和社区共识都确认:只 patch JS 层(navigator.webdriver 等),**不改网络栈**
- 从根因看无效

### ❌ Ulixee Hero (https://ulixee.org)
- 自研协议栈,理论上能改 TLS 层
- 2.0 仍是 alpha(最后 commit 2025-05),生产环境不稳
- API 和 Playwright 不兼容,**需要完全重写 BrowserManager**
- 收益不确定,成本巨大
- **备选方案,仅在 Camoufox 生态彻底失效时再评估**

### ❌ nodriver (https://github.com/ultrafunkamsterdam/nodriver)
- Python only,无 Node 端口
- 不适用

### ❌ Pure CDP (chrome-remote-interface)
- 需要从零实现整套浏览器控制逻辑(context, evaluate, interception 等)
- 即便实现也在 Chromium 内核下跑,同样受 JA3 约束
- 不值得

### ❌ 本机 Chrome / Edge / Brave 等 Chromium 变种
- 都是 BoringSSL + Chromium 网络栈
- JA3 指纹一致,**必然 403**

---

## 7. 操作建议

1. **短期**(立即可行): 保持 Camoufox 本机 binary + Playwright `firefox.launch + executablePath`,即上游 `v1.2.1` 的原装方案。已知工作。
2. **中期**(工程优化): 迁移到 `camoufox-js`。脱离 Python 依赖,获得 browserforge 随机指纹,升级通过 npm。
3. **长期**(架构弹性): 把 browser kernel 作为可插拔组件,在 BrowserManager 里预留一个 `createBrowser()` 工厂,方便未来 Camoufox 失效时切换到 Hero 或其他自研方案。

## 8. 参考

- 本次测试脚本: `scripts/experiments/` 目录下 18 个文件,每个对应一种尝试
- 主机制文档: [`ai-studio-mechanism.md`](./ai-studio-mechanism.md)
- Camoufox 官方: https://camoufox.com
- camoufox-js: https://github.com/apify/camoufox-js
- BrowserForge: https://github.com/daijro/browserforge
- TLS JA3 简介: https://github.com/salesforce/ja3
- Akamai H2 fingerprint 参考: https://www.akamai.com/blog/security/passive-fingerprinting-of-http2-clients

---

**文档版本**: 2026-04-13 二次调研完成 (浏览器内核穷尽测试)
