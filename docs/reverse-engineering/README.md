# AI Studio Apps 逆向研究文档

本目录是对 `iBUHub/AIStudioToAPI`(Camoufox 版本)工作机制的**双轮逆向分析** + 浏览器内核可用性穷尽测试。

**两轮调研的演进**:

- **第一轮(文档 #1 `ai-studio-mechanism.md`)**: 起初想搞清楚"上游 Camoufox 为什么能过 Google 反爬"。结论推向"完全绕开浏览器、在 Node.js 里直接复现 `alkalimakersuite` RPC 调用"。
- **第二轮(文档 #2 `browser-kernel-exploration.md`)**: 第一轮的"纯 Node 方案"在实测中**全线失败** — Python urllib / curl / Playwright page.evaluate / 任何 HTTP 客户端都返回 403 `PERMISSION_DENIED`。第二轮转向"如果绕不开浏览器,那哪个内核能用",对 9 种浏览器组合做了实证测试,结论:**Firefox 系(Camoufox 家族)是唯一可行路径**,`camoufox-js` 是 Node 原生最佳选择。

**⚠️ 读者警告**: 文档 #1 的第 5.1 节(纯 Node.js 实现路径 A)**已被文档 #2 证伪**。保留它作为调研过程的历史记录,不要按那个建议实施。**实际可行的路径是文档 #2 §5 `camoufox-js` 迁移**。

## 目录

| 文件 | 说明 |
|------|------|
| [`ai-studio-mechanism.md`](./ai-studio-mechanism.md) | **主文档 #1**。完整讲 Google AI Studio 前端调用 Gemini 的真实链路(`alkalimakersuite` gRPC-Web 端点 + SAPISIDHASH 签名)、上游 Canvas iframe + `_aistudio-iframe.js` shim + 父 frame handler 机制。⚠️ 第 5.1 节 "纯 Node.js 复现" 已被证伪,见 #2 |
| [`browser-kernel-exploration.md`](./browser-kernel-exploration.md) | **主文档 #2**。浏览器内核穷尽测试报告 — 为什么 Chromium 系(Playwright / Patchright / rebrowser / Real Chrome headed+headless / vanilla Firefox)全部 403;为什么 Camoufox 能过;根因是 TLS JA3 + HTTP/2 TCP 层指纹(JS 层改不掉);`camoufox-js` 迁移完整指引 |
| [`artifacts/_aistudio-iframe.js`](./artifacts/_aistudio-iframe.js) | Google AI Studio Apps 平台注入到 Canvas iframe 的 shim SDK 源码(24KB),从 `https://ais-pre-*.us-east5.run.app/_aistudio-iframe.js` 实地抓取。整个 fetch/WebSocket monkeypatch + MessagePort RPC 协议的**物证** |
| [`artifacts/canvas-index-OW2BOkGl.js`](./artifacts/canvas-index-OW2BOkGl.js) | Canvas App `c48c6178-...` (名为 "AIStudioToAPI-V1.1.3") 在 AI Studio Apps 平台发布的编译产物(16KB),从 `/assets/index-OW2BOkGl.js` 实地抓取 |
| [`artifacts/sample-rpc-request.http`](./artifacts/sample-rpc-request.http) | 一次**真实成功**的 AI Studio → Gemini `ProxyUnaryCall` 请求的完整 HTTP capture,包括所有 headers、body、返回状态码 |
| [`../../scripts/experiments/README.md`](../../scripts/experiments/README.md) | 配套的 18 个实验脚本索引。每个脚本对应一个具体假设的证实或证伪,是本目录两份主文档的实证基础 |

## TL;DR (2026-04-13 定稿)

1. **AI Studio 前端不直接调** `generativelanguage.googleapis.com`,而是调**私有 gRPC-Web 端点** `alkalimakersuite-pa.clients6.google.com/$rpc/.../ProxyUnaryCall`,用 Google session cookies + SAPISIDHASH 动态签名认证。
2. **这个端点有严苛的 TCP 层指纹检测(JA3 + HTTP/2 fingerprint)**,任何 Chromium 系浏览器(Playwright Chromium、Patchright、rebrowser-playwright、Real Google Chrome headed/headless、puppeteer-real-browser)都会 **403** — 即使 `navigator.webdriver === false`、UA 和 Client Hints 完全干净也不行。
3. **Firefox 内核本身也不够** — vanilla Playwright Firefox 同样 403。**必须用 Camoufox**(C++ 层 patch 了 NSS ClientHello + humanize 等)才能过。
4. 上游 `iBUHub/AIStudioToAPI` v1.2.1 的架构是**必要的**而非偶然:用 Camoufox 跑 Canvas iframe,让内部 `index.ts` 通过 `_aistudio-iframe.js` shim → MessagePort → 父 frame handler 去触发 `ProxyUnaryCall`。**既不能跳过浏览器,也不能跳过 Canvas**。
5. **推荐实施**: 迁移到 `camoufox-js`(Apify 维护的 Camoufox Node.js 端口),共享 C++ patch,脱离 Python 依赖,用 `browserforge` 随机指纹更隐蔽。详见 `browser-kernel-exploration.md` §5。
6. **不要尝试**的方向: 纯 Node.js HTTP 客户端、puppeteer-extra-stealth、Ulixee Hero(alpha)、各种 Chromium 变种。根因是 TCP 层,改不掉。

**一句话**: 用 `camoufox-js`,其他路都试过了,都是死的。
