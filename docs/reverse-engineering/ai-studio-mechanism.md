# AI Studio Apps 机制详解与重实现指南

> 本文档是对 Google AI Studio Apps 平台内部机制的逆向分析,以及上游项目 `iBUHub/AIStudioToAPI`
> 如何利用这套机制提供 OpenAI/Gemini/Anthropic 兼容 API 的完整说明。
>
> **目标受众**: 没有看过上游代码、但需要在干净环境下重建同样能力的资深开发。
> 读完本文后你应该能明确决定技术路线并开始写代码。
>
> **所有技术判断都有现场证据**,证据来源是 debug.log 的真实网络抓包和抓取的 JS 文件。
> 参见同目录 `artifacts/` 下的文件。

---

## 1. 问题定义

### 1.1 目标

把 Google AI Studio (https://aistudio.google.com) 的免费 Gemini quota 以 OpenAI / Gemini /
Anthropic API 兼容格式暴露给外部客户端 (Cherry Studio / Cursor / curl / 自建 agent 等),让用户可以
像调 OpenAI 一样调 Gemini,不需要自己申请和管理 API key。

### 1.2 为什么这事难

Google 对外提供两种使用 Gemini 的官方方式:

1. **`aistudio.google.com/apikey`** 生成的个人 API key: 需要用户手动申请、手动配置,有配额限制,
   且 AI Studio Web UI 实际不用这个 key。
2. **AI Studio Web UI 本身**: 免费、quota 足够 (GM 2.5 Flash 每天大量次数),但**没有官方的 API**,
   只能通过浏览器交互。

项目的核心价值就是"把 Web UI 的调用路径暴露成 API"。难点在于:

- AI Studio Web 前端发请求到 Gemini 时用的**不是** `?key=AIza...` 这种 public key 认证,而是
  基于 Google 登录 session 的**内部认证链路**。
- 这个链路既不是公开文档,也不是标准 REST,而是一个 gRPC-Web RPC 端点。
- 认证签名 (`SAPISIDHASH`) 需要基于 Google 登录 cookie 动态生成,有时间戳,不可缓存。

### 1.3 本文关键发现概览

1. AI Studio 前端**不直接**调 `generativelanguage.googleapis.com`。
2. 真实调用的是私有 gRPC-Web 端点
   `https://alkalimakersuite-pa.clients6.google.com/$rpc/.../MakerSuiteService/ProxyUnaryCall`。
3. 认证由 Google 登录 cookie (`SAPISID` 等) + 动态计算的 `SAPISIDHASH` 完成。
4. 上游项目的 Canvas iframe + WebSocket 整套架构**只是**为了让客户端代码在一个能
   享受到这个内部链路的上下文里跑 — 本质是"寄生"。
5. 干净实现不需要 Canvas、不需要 `_aistudio-iframe.js`、**甚至不需要浏览器自动化**,
   直接在 Node.js 里复现这个 RPC 调用即可。

---

## 2. 真实机制: AI Studio 前端如何调用 Gemini

### 2.1 请求的真实路径

以一个 `gemini-2.5-flash` 的 generateContent 为例,实地抓包结果见
`artifacts/sample-rpc-request.http`。核心信息:

```
POST https://alkalimakersuite-pa.clients6.google.com
     /$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/ProxyUnaryCall
Content-Type: application/json+protobuf
```

**Body 不是 protobuf**,是 JSON 格式,但 `Content-Type` 说是 `json+protobuf` (gRPC-Web 的一种)。
Body 结构:

```json
[
  "/v1beta/models/gemini-2.5-flash:generateContent",
  "{\"contents\":[{\"parts\":[{\"text\":\"hi\"}],\"role\":\"user\"}],\"generationConfig\":{...},\"safetySettings\":[...]}"
]
```

一个 JSON 数组,**长度严格为 2**:
- `[0]` 字符串 — 要代发到 `generativelanguage.googleapis.com` 的 path
- `[1]` 字符串 — 要代发的 request body 的 `JSON.stringify` 结果 (不是嵌套对象!)

服务端收到后会:
1. 验证 cookie + SAPISIDHASH,确认是真实登录的 Google 用户
2. 验证 `x-goog-api-key` (静态 public key,绑定 `referer: aistudio.google.com`)
3. 用 `[0]` 作为 path 和 `[1]` 作为 body,以**用户自己的免费 quota**去打真正的 Gemini API
4. 把 Gemini 的响应原样 (或做少量 wrap) 返回

### 2.2 认证链路

#### 2.2.1 必需的 headers

```
x-goog-api-key: AIzaSyDdP816MREB3SkjZO04QXbjsigfcI0GWOs
```

这是 AI Studio 前端的 public API key,**所有用户都是同一个值**,静态烤在 JS bundle 里。
它本身对 `generativelanguage.googleapis.com` 不可用 (绑定了 `referer: aistudio.google.com`),
只对 `alkalimakersuite-pa.clients6.google.com` 这个特定端点有意义,仅用于标识"这个请求是 AI Studio
前端发的"。

```
x-goog-authuser: 0
```

多账号登录时的索引,单账号写 `0` 即可。

```
origin: https://aistudio.google.com
referer: https://aistudio.google.com/
```

CORS 和认证要求的 origin。**必须和生成 SAPISIDHASH 时使用的 origin 完全一致**。

```
x-user-agent: grpc-web-javascript/0.1
```

这是 gRPC-Web client 的标识。Google 后端可能会检查这个 header 来区分 web / mobile / server 调用。
写一个就行。

```
x-aistudio-visit-id: v1_NTNkZDUxZjUtNGI2NS00OGQxLTllZjUtODMxOWFiNGNkMjc1
```

AI Studio 的 session tracking ID,每次 tab 打开独立生成。经验上**不是必需**,但保守做法是带一个
uuid 格式的占位值或者从主页面 localStorage 抓取实际值 (key 名 `visitId` 或类似,需进一步验证)。

```
x-goog-ext-519733851-bin: CAASAUIwATgEQABQBFgDYgJVUw==
```

Google API 的 protobuf extension header,`519733851` 是 field number。Base64 解码后是一个
protobuf message,大概率是 "AI Studio 前端版本 + 用户 locale" 之类的元数据。
**经验上同一 origin 下固定不变**,可以直接硬编码抓到的值。

```
content-type: application/json+protobuf
```

必须。

#### 2.2.2 `authorization` header 的 SAPISIDHASH 算法

这是整个认证里**唯一动态**的部分,也是重实现时最关键的一环:

```
authorization: SAPISIDHASH <ts>_<hash1>  SAPISID1PHASH <ts>_<hash2>  SAPISID3PHASH <ts>_<hash3>
```

一个 header 里塞了三条 hash,用空格分隔,格式是 `<label> <timestamp>_<sha1hex>`。三条 hash 的 label 分别是:

- `SAPISIDHASH`   — 基于 cookie `SAPISID` 计算
- `SAPISID1PHASH` — 基于 cookie `__Secure-1PAPISID` 计算
- `SAPISID3PHASH` — 基于 cookie `__Secure-3PAPISID` 计算

**在正常登录的 Google 账号里,这三个 cookie 的值通常相同** (只是放在不同的 SameSite 作用域下),
所以三条 hash 在同一个 `ts` 下也会相同。但生成时必须**按各自对应的 cookie** 算,避免将来 Google 拆开。

**SAPISIDHASH 的单条计算**:

```python
import hashlib, time

def make_sapisid_field(cookie_value: str, origin: str = "https://aistudio.google.com") -> str:
    ts = int(time.time())
    to_hash = f"{ts} {cookie_value} {origin}"
    sha1 = hashlib.sha1(to_hash.encode()).hexdigest()
    return f"{ts}_{sha1}"
```

Node.js 版本:

```javascript
const crypto = require("crypto");

function makeSapisidField(cookieValue, origin = "https://aistudio.google.com") {
    const ts = Math.floor(Date.now() / 1000);
    const sha1 = crypto.createHash("sha1")
        .update(`${ts} ${cookieValue} ${origin}`)
        .digest("hex");
    return `${ts}_${sha1}`;
}

function makeAuthorizationHeader(cookies, origin = "https://aistudio.google.com") {
    const sapisid = cookies["SAPISID"];
    const sapisid1p = cookies["__Secure-1PAPISID"];
    const sapisid3p = cookies["__Secure-3PAPISID"];
    return [
        `SAPISIDHASH ${makeSapisidField(sapisid, origin)}`,
        `SAPISID1PHASH ${makeSapisidField(sapisid1p, origin)}`,
        `SAPISID3PHASH ${makeSapisidField(sapisid3p, origin)}`,
    ].join(" ");
}
```

这个算法是 Google 内部广泛使用的 cookie-bound 签名方案,Gmail、Google Photos、AI Studio 都在用。
开源社区里早就有人逆向出来了,搜 "SAPISIDHASH algorithm" 能看到大量一致的实现。

**时间窗口**: 签名里的 `ts` 是当前 Unix 时间戳 (秒),服务端对时钟偏差容忍通常在 10 分钟左右。
**每个请求都要重新生成**,不能缓存。

#### 2.2.3 必需的 cookies

从 `aistudio.google.com` 这个 origin 的 cookie jar 提取,以下全部必须带上:

| Cookie | 作用 |
|--------|------|
| `SAPISID` | 参与 SAPISIDHASH 计算,也单独做 session 认证 |
| `__Secure-1PAPISID` | 参与 SAPISID1PHASH |
| `__Secure-3PAPISID` | 参与 SAPISID3PHASH |
| `__Secure-1PSID` | 1P (first-party) session ID,长 cookie |
| `__Secure-3PSID` | 3P (third-party) session ID |
| `__Secure-1PSIDTS` | 1P session timestamp |
| `__Secure-3PSIDTS` | 3P session timestamp |
| `NID` | Google 通用识别 cookie |
| `SSID` | Secure session ID |
| `__Secure-1PSIDCC` | 1P session correlation |
| `__Secure-3PSIDCC` | 3P session correlation |

**最简化**的 cookie 集(经验,待验证是否够):
`SAPISID`, `__Secure-1PAPISID`, `__Secure-3PAPISID`, `__Secure-1PSID`, `__Secure-3PSID`, `NID`。

完整策略: 从 Playwright context `cookies()` 里把 `.google.com` domain 下所有 cookie 都带上,
让 Google 后端自己筛。

### 2.3 完整请求范例 (curl)

```bash
#!/bin/bash
# 假设你已经把 cookies 填好,SAPISIDHASH 已经算好放在 $AUTH_HEADER

curl 'https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/ProxyUnaryCall' \
  -H 'content-type: application/json+protobuf' \
  -H 'x-user-agent: grpc-web-javascript/0.1' \
  -H 'x-goog-api-key: AIzaSyDdP816MREB3SkjZO04QXbjsigfcI0GWOs' \
  -H 'x-goog-authuser: 0' \
  -H 'x-goog-ext-519733851-bin: CAASAUIwATgEQABQBFgDYgJVUw==' \
  -H "authorization: $AUTH_HEADER" \
  -H 'origin: https://aistudio.google.com' \
  -H 'referer: https://aistudio.google.com/' \
  -H "cookie: $COOKIES" \
  --data-raw '["/v1beta/models/gemini-2.5-flash:generateContent","{\"contents\":[{\"parts\":[{\"text\":\"hi\"}],\"role\":\"user\"}],\"generationConfig\":{},\"safetySettings\":[{\"category\":\"HARM_CATEGORY_HARASSMENT\",\"threshold\":\"BLOCK_NONE\"},{\"category\":\"HARM_CATEGORY_HATE_SPEECH\",\"threshold\":\"BLOCK_NONE\"},{\"category\":\"HARM_CATEGORY_SEXUALLY_EXPLICIT\",\"threshold\":\"BLOCK_NONE\"},{\"category\":\"HARM_CATEGORY_DANGEROUS_CONTENT\",\"threshold\":\"BLOCK_NONE\"}]}"]'
```

响应是 HTTP 200,body 是 JSON (外层可能有 gRPC-Web 的 wrap),内容就是 Gemini 的原生 generateContent response。

---

## 3. 上游 `iBUHub/AIStudioToAPI` 如何利用这套机制

### 3.1 为什么上游要用浏览器

上面的认证链路有两个难点从服务端直接做比较麻烦:

1. **初次获取 cookies**: 需要用户登录 Google 账号,这要么浏览器交互、要么 OAuth flow。
2. **`x-goog-api-key` 和 `x-goog-ext-*` 值**: 虽然是静态的但会随着平台更新变化,最好从运行时抓取。
3. **cookies 维护和刷新**: session cookies 有有效期,需要定期刷新。

上游选择了**直接让浏览器来做这件事**: 启动一个 headless 浏览器,加载一个特殊的 AI Studio App 页面,
让页面内的 JS 代码在 Google 的特权 origin 下发请求,而本地 Node.js 服务只负责"告诉页面要发什么请求"+
"接收页面的响应"。**Node.js 完全不碰 cookie / 不碰 SAPISIDHASH / 不碰 gRPC-Web endpoint**。

### 3.2 整体架构

```
┌─ Cherry Studio / curl / ... ──────────────────────────────────────┐
│  POST http://localhost:7860/v1/chat/completions                    │
└──────────────────────────────────────────┬─────────────────────────┘
                                           │
                                           ▼
┌─ Node.js 服务 (ProxyServerSystem) ────────────────────────────────┐
│  RequestHandler                                                    │
│  ├─ 格式转换 (OpenAI ↔ Gemini via FormatConverter)                │
│  ├─ 找到当前活跃的 browser context (BrowserManager)                │
│  └─ 通过 WebSocket 把 { path, method, headers, body } 发给浏览器    │
└──────────────────────────────────────────┬─────────────────────────┘
                                           │ ws://127.0.0.1:9998
                                           ▼
┌─ Patchright/Camoufox 启动的 headless 浏览器 ──────────────────────┐
│  主 frame: https://aistudio.google.com/apps/c48c6178-...           │
│  ├─ 有完整的 Google 登录态 (cookies + session)                     │
│  ├─ iframe: https://ais-pre-*.us-east5.run.app/...                │
│  │    ├─ 加载 index-OW2BOkGl.js (Canvas app,TS 编译)             │
│  │    ├─ 加载 _aistudio-iframe.js (Google 平台 shim)              │
│  │    │    - monkeypatch window.fetch                             │
│  │    │    - monkeypatch WebSocket (只对 wss://generative...)     │
│  │    │    - 等父 frame 发 bootstrap postMessage                  │
│  │    │                                                            │
│  │    └─ index.ts 的 ProxySystem 启动:                            │
│  │       - new WebSocket("ws://127.0.0.1:9998?authIndex=0")       │
│  │         ← shim 不拦截 (非 generativelanguage.googleapis.com)   │
│  │         → 原生 WS 连到本地 Node.js 服务                         │
│  │       - 收到 {method,path,headers,body} 消息时:                 │
│  │         fetch("https://generativelanguage.googleapis.com/...", │
│  │               {method, headers, body})                          │
│  │         ← shim 拦截                                             │
│  │         → 通过 MessagePort 发给父 frame                         │
│  │                                                                  │
│  └─ 父 frame 收到 MessagePort fetch 请求:                           │
│     1. 把 { url, method, headers, body } 重新打包成                 │
│        [path, JSON.stringify(body)]                                │
│     2. POST 到 alkalimakersuite-pa.clients6.google.com             │
│        /$rpc/MakerSuiteService/ProxyUnaryCall                      │
│        带上 cookie + 自动算出的 SAPISIDHASH + x-goog-api-key       │
│     3. 响应分块通过 MessagePort 流回 iframe                         │
│                                                                      │
│  index.ts 的 fetch 感觉"请求成功了",把响应分块通过 WebSocket         │
│  发回 Node.js                                                        │
└──────────────────────────────────────────────────────────────────┘
```

这套架构的本质:

- **WebSocket 是 iframe 和 Node.js 之间的桥**,用来双向传请求/响应。
- **父 frame (aistudio.google.com) 是 "免费的 RPC 代理"**,它自带登录态,帮 iframe 把 fetch 转发到
  真正的 Gemini 端点。
- **iframe 是 "假 Gemini 客户端"**,代码以为自己在直连 Gemini,实际走的是 shim。

### 3.3 `_aistudio-iframe.js` — 平台 Shim 的完整剖析

完整源码见 [`artifacts/_aistudio-iframe.js`](./artifacts/_aistudio-iframe.js)。关键部分:

#### 3.3.1 只在 iframe 里运行

```javascript
(() => {
  if (window.self === window.top) {
    // 主窗口不跑
    return;
  }
  // ...
})();
```

#### 3.3.2 模拟 `process.env.GEMINI_API_KEY`

```javascript
window.API_KEY = 'GEMINI_API_KEY';
window.GEMINI_API_KEY = 'GEMINI_API_KEY';
window.process = window.process || {};
window.process.env = window.process.env || {};
window.process.env.API_KEY = window.API_KEY;
window.process.env.GEMINI_API_KEY = window.GEMINI_API_KEY;
```

这只是**字面字符串** `'GEMINI_API_KEY'`,不是真的 key。作用是**让 Canvas 源码里用
`process.env.GEMINI_API_KEY` 的地方不报 undefined 错**。Canvas 代码实际不会把这个字符串
传到 fetch 里 — 因为 fetch 会被下面的 shim 拦截,根本走不到真实 Google API。

#### 3.3.3 Bootstrap Promise (等父 frame 发送 MessagePort)

```javascript
const bootstrapChannel = new Promise((resolve) => {
  window.addEventListener('message', (event) => {
    try {
      const url = new URL(event.origin);
      if (!url.hostname.endsWith('.google.com')) return;
    } catch (e) { return; }

    if (event.data.type === 'bootstrap') {
      resolve({
        port: event.ports[0],              // ← 父 frame 传过来的 MessagePort
        urlPatterns: event.data.urlPatterns.map((p) => new RegExp(p)),
      });
    }
  });
});
```

父 frame (`aistudio.google.com`) 会在 iframe load 之后发一个
`{ type: "bootstrap", urlPatterns: [...] }` 的 postMessage,并通过 `event.ports[0]` 把一个
`MessagePort` 传过来。这个 port 就是 iframe 和父 frame 之间的双向通信通道。

`urlPatterns` 是一组正则,告诉 shim 哪些 URL 要被拦截(走 port),哪些 URL 放行(走原生)。
根据抓包观察,这个列表至少包含匹配 `generativelanguage.googleapis.com` 的正则。

#### 3.3.4 `window.fetch` monkeypatch

```javascript
const nativeFetch = window.fetch;

async function fetch(resource, options) {
  const config = await bootstrapChannel;   // 等父 frame 准备好

  const request = resource instanceof Request
    ? resource.clone()
    : new Request(resource, options);

  // 不匹配 urlPatterns → 放行
  if (!config.urlPatterns.some((p) => request.url.match(p))) {
    return nativeFetch(resource, options);
  }

  // 匹配 → 通过 MessagePort 转给父 frame
  const hostPort = config.port;
  const channel = new MessageChannel();
  const buffer = await request.arrayBuffer();

  hostPort.postMessage({
    type: 'fetch',
    url: request.url,
    method: request.method,
    headers: [...request.headers.entries()],
    body: buffer.byteLength ? buffer : undefined,
  }, [channel.port2]);

  // 构造 ReadableStream,通过 channel.port1 接收 response/body/body_done 事件
  let streamController;
  const body = new ReadableStream({ start(c) { streamController = c; } });
  let resolveReceive;
  const receivePromise = new Promise((r) => { resolveReceive = r; });

  channel.port1.onmessage = (message) => {
    switch (message.data.type) {
      case 'response':
        resolveReceive(new Response(body, {
          status: message.data.status,
          statusText: message.data.statusText,
          headers: new Headers(message.data.headers),
        }));
        break;
      case 'body':
        streamController.enqueue(message.data.data);
        break;
      case 'body_done':
        streamController.close();
        break;
    }
  };

  return receivePromise;
}

Object.defineProperty(window, 'fetch', { get: () => fetch });
```

关键设计:
1. **透明替换**: Canvas 代码写 `fetch("https://generativelanguage.googleapis.com/...")` 不需要改动。
2. **原生 fetch 保留**: 不匹配的 URL 走原生,比如 `ws://127.0.0.1:9998` 走原生所以本地 WS 能连上。
3. **流式支持**: 通过 `ReadableStream` + `body` / `body_done` 消息实现 SSE 风格的分块传输。

#### 3.3.5 `WebSocket` monkeypatch (只拦截 `wss://generativelanguage.googleapis.com/`)

```javascript
function createWebSocket(url, protocols) {
  if (url.startsWith('wss://generativelanguage.googleapis.com/')) {
    return Reflect.construct(ProxiedWebSocket, [url, protocols]);
  }
  return Reflect.construct(originalWebSocket, [url, protocols]);
}

Object.defineProperty(window, 'WebSocket', { get: () => createWebSocket });
```

Gemini 的 bidi streaming API 用 WebSocket,所以 shim 也要拦。
**其他 WebSocket 走原生** — 关键!本地 `ws://127.0.0.1:9998` 因此畅通。

这也是为什么上游架构能 work: iframe 里的 Canvas 代码既要连本地 Node.js 的 WS 又要调 Gemini API,
shim 在这里做了正确的路由。

### 3.4 `scripts/client/build.js` — 被误解的死代码

仓库里的 `scripts/client/build.js` **在上游 v1.2.1 里根本不会被注入**。证据:

- `src/core/BrowserManager.js` 里的 `_loadAndConfigureBuildScript` 方法是**整段注释掉的**
  (见 [Agent B 调研报告](#) 对上游代码的 grep 结果)
- 上游 `_initializeContext` 里没有任何 `addScriptTag` / `addInitScript` / `page.evaluate`
  加载 build.js 的调用
- `addInitScript` 只注入了 privacy 脚本 (用来 spoof WebGL、postMessage 响应 authIndex),
  不注入 build.js

**那实际跑的是什么代码?** 是 Canvas app 里的 `index.ts`,编译产物位于
`ais-pre-*.run.app/assets/index-OW2BOkGl.js` (完整文件见
[`artifacts/canvas-index-OW2BOkGl.js`](./artifacts/canvas-index-OW2BOkGl.js))。这个文件是**上游维护者
自己把本地 build.js 翻译成 TypeScript 后上传到 AI Studio Apps 平台发布出来的**。内容和本地
`scripts/client/build.js` 功能一致,不含任何 key 注入逻辑。

**本地 build.js 的存在意义**: 作为 **开发参考 / 备份 / 降级 fallback**,永远保持和 Canvas 里的
`index.ts` 功能对齐。fork 的本地仓库在 commit `9a74347` 引入的 `_injectBuildScriptIntoIframe`
是一次误解,试图把这份"死代码"重新激活注入,但**没有 shim,注入的 build.js 直接发裸 fetch**,
所以永远 403 "unregistered callers"。

### 3.5 Canvas App `c48c6178-...` 是什么

上游维护者在 AI Studio Apps 平台上发布的一个应用,名字叫 **"AIStudioToAPI-V1.1.3"**,包含:

- `index.html` — 标准 Vite 入口 (见 artifacts),内含 authIndex 握手脚本
- `index.ts` — ProxySystem 客户端 (WebSocket + RequestProcessor,和本地 build.js 功能等价)
- `index.css`, `package.json`, `vite.config.ts`, `tsconfig.json`, `metadata.json` — 标准 Vite 项目配置

其中 `vite.config.ts` 里有:

```typescript
define: {
  'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
  'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
},
```

**但 `index.ts` 里从不引用这两个变量**,所以 define 实际是 dead config,Canvas app 里的 fetch
从来不会带 key 参数。key 注入的工作**完全**由 `_aistudio-iframe.js` shim + 父 frame RPC 完成。

### 3.6 端到端时序 (成功 case)

```
t=0ms  client → Node.js: POST /v1/chat/completions  {model:"gemini-2.5-flash", messages:[...]}
t=1ms  Node.js: FormatConverter.openaiToGemini(body)
       → {contents:[...], safetySettings:[...], generationConfig:{}}
t=2ms  Node.js: WebSocket send 给 browser
       {path:"/v1beta/models/gemini-2.5-flash:generateContent",
        method:"POST", body:"{...}", headers:{...}}

t=3ms  (iframe) index.ts ProxySystem._handleIncomingMessage 收到
t=4ms  index.ts RequestProcessor.execute():
       url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
       fetch(url, {method:"POST", headers:{...}, body:"{...}"})

t=5ms  _aistudio-iframe.js shim 拦截 (url 匹配 urlPatterns)
       postMessage({type:"fetch", url, method, headers, body:bodyBytes}, [channel.port2])
       via hostPort (= 父 frame 发的 bootstrap port)

t=6ms  父 frame (aistudio.google.com) 收到 MessagePort.fetch 消息
       构造 [path, JSON.stringify(bodyObj)]
       POST https://alkalimakersuite-pa.clients6.google.com/$rpc/.../ProxyUnaryCall
            Content-Type: application/json+protobuf
            x-goog-api-key: AIzaSyDdP816MREB3SkjZO04QXbjsigfcI0GWOs
            authorization: SAPISIDHASH <ts>_<sha1>  SAPISID1PHASH ... SAPISID3PHASH ...
            cookie: SAPISID=... __Secure-1PAPISID=... ...
            body: ["/v1beta/models/gemini-2.5-flash:generateContent", "{...body json...}"]

t=1500ms  Google 后端验证 → 代发到 real Gemini API → 拿到响应 → 按 chunk 返回
t=1501ms  父 frame 把响应 chunk 通过 MessagePort 回传
          { type:"response", status:200, statusText:"OK", headers:{...} }
          { type:"body", data: Uint8Array }
          { type:"body", data: Uint8Array }
          ...
          { type:"body_done" }

t=1502ms  iframe shim 的 ReadableStream 接收到,resolve 给 Canvas index.ts 的 fetch
t=1503ms  index.ts 的 _processProxyRequest 拿到 response,
          reader.read() 循环读 chunks,每个 chunk 通过 WebSocket 发回 Node.js
          ({event_type:"chunk", data, request_id})

t=1504ms  Node.js 收到 chunks 聚合,转 OpenAI SSE 格式,流给 client
t=1505ms  client 拿到完整响应
```

---

## 4. 为什么 Patchright/Chromium 下走不通

fork 的唯一 intentional 改动是 `9c75f07` 把 Camoufox (Firefox) 换成 Patchright (Chromium)。
紧跟着 `9a74347` 增加了 `_injectBuildScriptIntoIframe` 和 Canvas URL 切换等一系列"修复"。

实地测试表明,Patchright 下:

- `_aistudio-iframe.js` 依然加载成功 (见 debug.log 里的 `REQ* GET .../_aistudio-iframe.js`)
- `index-OW2BOkGl.js` 依然加载成功
- iframe 能进到 ready 状态
- **但发请求时会 403 "unregistered callers"**

可能的原因 (**未 100% 验证**,但按逆向经验排序):

1. **父 frame `bootstrap` postMessage 没被发送**: `aistudio.google.com` 的前端代码可能检测
   UA / feature flag,对 Chromium 不发 bootstrap,导致 shim 的 `await bootstrapChannel` 永远 pending。
   Canvas index.ts 的 fetch 也就永远卡住。这种情况下 `_injectBuildScriptIntoIframe` 的 fallback
   会注入本地 build.js,但本地 build.js 发的是裸 fetch,403。
2. **shim 的 `Object.defineProperty(window, 'fetch', ...)` 在 Patchright 的 anti-detection 层被屏蔽**:
   Patchright 会改写一些 `Object.defineProperty` 相关的 hook,可能误伤了 shim 的 fetch 覆盖。
3. **Chromium 对同源策略 / MessageChannel 的时序和 Firefox 不同**,导致 bootstrap port 握手时序竞争。

要定位具体原因需要在 Patchright 下再跑一组探针: 注入自己的 `console.log` 到 shim 的关键点
(bootstrap resolved、fetch 被 monkeypatch、拦截到某 URL),看是哪一步没发生。

**结论**: Chromium 路径投入产出比非常低,建议直接换路。

---

## 5. 实施路径 (干净重建)

给出两条路径,**路径 A 强烈推荐**。

### 路径 A: 纯 Node.js,直接复现 RPC 调用 (推荐)

完全抛弃 browser automation,把所有事情在 Node.js 里做。

#### 5.1.1 整体架构

```
客户端 (Cherry Studio/curl)
  ↓ POST /v1/chat/completions
Node.js HTTP server (Express)
  ↓ FormatConverter.openaiToGemini
  ↓
AistudioRpcClient.call(path, body)                  ← 新增的核心模块
  ↓ 从本地 cookie jar 取 cookies
  ↓ 动态计算 SAPISIDHASH
  ↓ 构造 [path, JSON.stringify(body)]
  ↓ fetch("https://alkalimakersuite-pa.clients6.google.com/$rpc/.../ProxyUnaryCall", {
  ↓    method:"POST", headers:{...完整 15 个 header}, body:[...]
  ↓ })
  ↓
解包响应 → 还原成标准 Gemini response
  ↓
FormatConverter.geminiToOpenai
  ↓
流回客户端
```

**零浏览器,零 WebSocket 中转**。Node.js 直接用 `globalThis.fetch` 或 `undici` 发请求。

#### 5.1.2 Cookie 获取策略

需要 `aistudio.google.com` 的登录 cookies。三种方案:

**方案 A.1 一次性 Playwright 登录 + 持久化** (最方便)

启动时跑一次 headless Playwright,弹出浏览器窗口让用户登录 Google,
登录后用 `context.cookies(".google.com")` 把所有 cookie 持久化到本地 JSON 文件。
后续所有请求都从这个文件读 cookies。不需要任何浏览器驻留。

过期后 (通常 2 周~1 个月) 再跑一次登录。

```javascript
// scripts/login.js
const { chromium } = require("playwright");
const fs = require("fs");

(async () => {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("https://aistudio.google.com/");
    console.log("请在弹出窗口里登录 Google,登录后按 Enter...");
    process.stdin.once("data", async () => {
        const cookies = await context.cookies("https://aistudio.google.com/");
        fs.writeFileSync("./data/cookies.json", JSON.stringify(cookies, null, 2));
        console.log("Cookies saved.");
        await browser.close();
        process.exit(0);
    });
})();
```

**方案 A.2 手动粘贴 cookie** (最极简)

用户在正常 Chrome 里打开 `aistudio.google.com`,登录后在 DevTools Network 面板随便抓一个
请求的 cookie header,粘贴到 `.env` 或配置文件。适合单用户部署。

**方案 A.3 OAuth flow** (最优雅但最复杂)

走标准 Google OAuth 拿 session。需要注册 OAuth client,处理 refresh token,
且**不确定 Google 是否允许 OAuth session 访问 alkalimakersuite endpoint**。
不推荐首选。

#### 5.1.3 核心模块: `AistudioRpcClient`

```javascript
// src/core/AistudioRpcClient.js
const crypto = require("crypto");
const fs = require("fs");

const RPC_ENDPOINT = "https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/ProxyUnaryCall";
const ORIGIN = "https://aistudio.google.com";
const STATIC_API_KEY = "AIzaSyDdP816MREB3SkjZO04QXbjsigfcI0GWOs";
const STATIC_EXT_BIN = "CAASAUIwATgEQABQBFgDYgJVUw==";

class AistudioRpcClient {
    constructor(cookieFilePath) {
        this.cookieFile = cookieFilePath;
        this._loadCookies();
    }

    _loadCookies() {
        const raw = JSON.parse(fs.readFileSync(this.cookieFile, "utf-8"));
        // Playwright 导出的 cookies 是 [{name, value, domain, ...}, ...]
        this.cookieMap = Object.fromEntries(raw.map(c => [c.name, c.value]));
        this.cookieHeader = raw
            .filter(c => (c.domain || "").endsWith(".google.com"))
            .map(c => `${c.name}=${c.value}`)
            .join("; ");
    }

    _makeSapisidField(cookieValue) {
        const ts = Math.floor(Date.now() / 1000);
        const sha1 = crypto.createHash("sha1")
            .update(`${ts} ${cookieValue} ${ORIGIN}`)
            .digest("hex");
        return `${ts}_${sha1}`;
    }

    _makeAuthHeader() {
        const s = this.cookieMap["SAPISID"];
        const s1 = this.cookieMap["__Secure-1PAPISID"];
        const s3 = this.cookieMap["__Secure-3PAPISID"];
        return [
            `SAPISIDHASH ${this._makeSapisidField(s)}`,
            `SAPISID1PHASH ${this._makeSapisidField(s1)}`,
            `SAPISID3PHASH ${this._makeSapisidField(s3)}`,
        ].join(" ");
    }

    /**
     * 调用 Gemini API,返回 Response (fetch 的,支持流式)
     * @param {string} path - e.g. "/v1beta/models/gemini-2.5-flash:generateContent"
     * @param {object} body - Gemini request body (contents, safetySettings, ...)
     */
    async call(path, body) {
        const rpcBody = JSON.stringify([path, JSON.stringify(body)]);
        return fetch(RPC_ENDPOINT, {
            method: "POST",
            headers: {
                "content-type": "application/json+protobuf",
                "x-user-agent": "grpc-web-javascript/0.1",
                "x-goog-api-key": STATIC_API_KEY,
                "x-goog-authuser": "0",
                "x-goog-ext-519733851-bin": STATIC_EXT_BIN,
                "authorization": this._makeAuthHeader(),
                "origin": ORIGIN,
                "referer": ORIGIN + "/",
                "cookie": this.cookieHeader,
                "x-aistudio-visit-id": `v1_${crypto.randomUUID()}`,
            },
            body: rpcBody,
        });
    }
}

module.exports = AistudioRpcClient;
```

#### 5.1.4 响应处理

响应体格式需要实地抓一次才能确认,从 debug.log 看大概率是:
- 外层是 gRPC-Web 的 length-prefixed frame (5 字节 header + payload)
- payload 是标准 Gemini response 的 JSON (对于非流式) 或 JSON Lines (对于 stream)

gRPC-Web length-prefixed frame 格式:
```
Byte 0    : flag (0x00 = data frame, 0x80 = trailers frame)
Byte 1-4  : length (big-endian uint32)
Byte 5..N : payload
```

流式响应会有多个 frame,直到收到 trailers frame 为止。

具体实现需要:

```javascript
async function* parseGrpcWebStream(response) {
    const reader = response.body.getReader();
    let buffer = new Uint8Array(0);
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer = concat(buffer, value);
        while (buffer.length >= 5) {
            const flag = buffer[0];
            const len = new DataView(buffer.buffer, buffer.byteOffset + 1, 4).getUint32(0);
            if (buffer.length < 5 + len) break;
            const payload = buffer.slice(5, 5 + len);
            buffer = buffer.slice(5 + len);
            if (flag === 0) {
                yield JSON.parse(new TextDecoder().decode(payload));
            }
            // flag === 0x80 是 trailers,通常是空或 status
        }
    }
}
```

**⚠️ 未验证**: 上面是标准 gRPC-Web 规范。实际 `alkalimakersuite` 端点返回的格式需要抓包验证。
也可能是纯 JSON (不带 frame),或者是 server-sent JSON Lines。**第一步实现时先直接把 response body
打出来看**。

#### 5.1.5 替换 BrowserManager 和 WebSocket 层

一旦 `AistudioRpcClient` 能 work,`BrowserManager.js` 整个可以删掉,`ConnectionRegistry` + 本地
WebSocket server 整套也可以删掉。`RequestHandler.js` 的 "forward via WebSocket" 那段改成直接
调 `AistudioRpcClient.call(path, body)`。

**预计删除代码 4000+ 行,新增 500 行以内**。

#### 5.1.6 Cookie 刷新策略

session cookies 会过期。策略:

1. **定期主动刷新**: 每 6 小时后台跑一次 Playwright,导航到 `https://aistudio.google.com/`,
   读新 cookies 覆盖本地文件。因为 Google 会在任何 `.google.com` 请求上自动续签 session。
2. **失败被动刷新**: 收到 401/403 时触发一次刷新,重试一次请求。
3. **过期提示**: 连续失败超过 N 次,提示用户重新登录。

#### 5.1.7 Multi-account 支持

上游的多账号切换 (`AuthSwitcher`) 变得很简单: 每个账号一个 `cookies-{index}.json` 文件,
`AistudioRpcClient` 保存成一个池,按策略轮询。不再需要多浏览器 context。**内存占用归零**。

### 路径 B: Browser-based, 回到上游架构

如果你不想完全抛弃浏览器 (比如你需要某些只能在浏览器里做的事,像 DOM 元素选择或者截图),
就直接用 `playwright.firefox.launch()` + 完全复制上游 `f30085c` 的 `BrowserManager.js` 逻辑
(只 `page.goto` + wait + WS 监听,不注入任何 build.js,不做 iframe 处理)。

**关键**: **不能用 Patchright/Chromium**,因为 shim 在 Chromium 下不工作 (原因见第 4 节)。
必须用 Firefox。Playwright 官方的 Firefox 维护得比 Camoufox 好,内存占用约 500MB/context,
与 Patchright (~300MB) 差别不算致命。

此路径代码改动量最小 (基本等于退回到上游 `f30085c`),但长期维护负担高 (跟着 Google 平台改)。

---

## 6. 已验证事实 vs. 未验证假设

### ✅ 已验证 (有现场抓包 / 源码证据)

1. AI Studio 前端调用的 RPC endpoint 是
   `alkalimakersuite-pa.clients6.google.com/$rpc/.../MakerSuiteService/ProxyUnaryCall`
2. Request body 是 `[path, JSON.stringify(body)]` 的 JSON 数组
3. `x-goog-api-key` 是静态 public key `AIzaSyDdP816MREB3SkjZO04QXbjsigfcI0GWOs`
4. `authorization` header 格式是 `SAPISIDHASH ... SAPISID1PHASH ... SAPISID3PHASH ...`
5. `_aistudio-iframe.js` monkeypatch 了 `window.fetch` 和 `window.WebSocket`
6. Canvas app 的 `index.ts` 是本地 `build.js` 的 TS 重写版,功能等价,不含 key 注入
7. 本地 `scripts/client/build.js` 在上游 Camoufox 版里从不被注入 (源码注释确认)
8. 上游 Camoufox + v1.2.1 + 当前时间点 (2026-04-13) 实测可用
9. 本地 Patchright 分支在相同账号 / 相同 Canvas URL 下走不通,403 "unregistered callers"

### ❓ 有合理推测但未直接验证

1. SAPISIDHASH 算法就是 `sha1(ts + " " + SAPISID + " " + origin)` — **待验证**。
   开源社区对其他 Google 产品的相同 header 已大量逆向,算法一致,但**不排除 alkalimakersuite 端点
   有额外盐值或算法变种**。**路径 A 实施第一步必须验证这点**。
2. `x-goog-ext-519733851-bin` 的值是固定的 — 经验上同一 origin 不变,但 Google 可能随时改。
3. `x-aistudio-visit-id` 非必需 — 未验证,实施时先带一个随机 uuid 保守处理。
4. 不带 `x-goog-ext-519733851-bin` / 不带 `x-user-agent` 能否 work — 未验证。先全部带上。

### 🚫 已证伪的假设 (早期错误方向,不要再走)

1. ~~Canvas iframe 下有 Service Worker 做 key 注入~~ — 实测 `navigator.serviceWorker.getRegistrations()`
   返回空数组。Service Worker 机制不成立。
2. ~~`window.fetch` 被 Cloud Run 后端或 Google 网关透明代理~~ — `fromServiceWorker: false`,
   请求是正常出站到 `alkalimakersuite`。
3. ~~父 frame 用 `credentials: 'include'` 直接打 `generativelanguage.googleapis.com`~~ — 实际没有任何
   对该域名的非 ActiveTrigger 请求。真实请求目标是 alkalimakersuite。
4. ~~`process.env.GEMINI_API_KEY` 在 Vite 构建时被替换成真实 key~~ — `_aistudio-iframe.js` 里确实设了
   `process.env.GEMINI_API_KEY = 'GEMINI_API_KEY'` (字面字符串) 作为 dead fallback,但 Canvas `index.ts`
   从不引用它,Vite define 是 dead config。

---

## 7. 快速开始的验证脚本 (阶段 1)

在投入大量时间重构之前,**必须**先跑这个最小验证,确认路径 A 的 RPC 调用能直接 work:

```javascript
// scripts/experiments/verify-rpc.js
const crypto = require("crypto");
const fs = require("fs");

// Step 1: 把你从 Chrome DevTools 抓的 cookie header 直接贴到这
const COOKIE_HEADER = `SAPISID=...; __Secure-1PAPISID=...; __Secure-3PAPISID=...; __Secure-1PSID=...; __Secure-3PSID=...; NID=...`;

// Step 2: 从 cookie header 里提取三个 SAPISID 变体
function parseCookies(header) {
    return Object.fromEntries(
        header.split("; ").map(p => {
            const idx = p.indexOf("=");
            return [p.slice(0, idx), p.slice(idx + 1)];
        })
    );
}
const cookies = parseCookies(COOKIE_HEADER);

// Step 3: 生成 authorization header
function makeSapisidField(cookieValue, origin = "https://aistudio.google.com") {
    const ts = Math.floor(Date.now() / 1000);
    const sha1 = crypto.createHash("sha1")
        .update(`${ts} ${cookieValue} ${origin}`).digest("hex");
    return `${ts}_${sha1}`;
}
const auth = [
    `SAPISIDHASH ${makeSapisidField(cookies["SAPISID"])}`,
    `SAPISID1PHASH ${makeSapisidField(cookies["__Secure-1PAPISID"])}`,
    `SAPISID3PHASH ${makeSapisidField(cookies["__Secure-3PAPISID"])}`,
].join(" ");

// Step 4: 构造请求
const body = JSON.stringify([
    "/v1beta/models/gemini-2.5-flash:generateContent",
    JSON.stringify({
        contents: [{ parts: [{ text: "hi, who are you?" }], role: "user" }],
        generationConfig: {},
        safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        ],
    }),
]);

(async () => {
    const r = await fetch(
        "https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/ProxyUnaryCall",
        {
            method: "POST",
            headers: {
                "content-type": "application/json+protobuf",
                "x-user-agent": "grpc-web-javascript/0.1",
                "x-goog-api-key": "AIzaSyDdP816MREB3SkjZO04QXbjsigfcI0GWOs",
                "x-goog-authuser": "0",
                "x-goog-ext-519733851-bin": "CAASAUIwATgEQABQBFgDYgJVUw==",
                "authorization": auth,
                "origin": "https://aistudio.google.com",
                "referer": "https://aistudio.google.com/",
                "cookie": COOKIE_HEADER,
            },
            body,
        }
    );
    console.log("STATUS:", r.status);
    console.log("HEADERS:", Object.fromEntries(r.headers));
    const buf = await r.arrayBuffer();
    console.log("BODY (hex dump first 200 bytes):",
        Buffer.from(buf).slice(0, 200).toString("hex"));
    console.log("BODY (text):",
        new TextDecoder().decode(buf).slice(0, 2000));
})();
```

运行:

```bash
node scripts/experiments/verify-rpc.js
```

**预期结果**:
- 200 OK
- 返回类似 `{"candidates":[...],"usageMetadata":{...},"modelVersion":"gemini-2.5-flash",...}` 的 JSON

**如果成功**: 整个路径 A 就是可行的,可以进入正式重构。
**如果失败**:
- `401/403` → cookie 过期或 SAPISIDHASH 算错。重新从 Chrome 抓 cookie,核对算法。
- `400` → body 格式错了,或者 path 错了。对照 `artifacts/sample-rpc-request.http` 逐字段核对。
- `CORS error` → Node.js 里理论上不会有 (CORS 只在 browser 里),如果出现说明发错了 URL。

---

## 8. 参考资料

### 8.1 本目录 artifacts

- [`artifacts/_aistudio-iframe.js`](./artifacts/_aistudio-iframe.js) — Google 平台 shim 完整源码 (24KB)
- [`artifacts/canvas-index-OW2BOkGl.js`](./artifacts/canvas-index-OW2BOkGl.js) — Canvas app 编译产物 (16KB)
- [`artifacts/sample-rpc-request.http`](./artifacts/sample-rpc-request.http) — 一次真实成功 RPC 调用的完整 HTTP capture

### 8.2 上游项目

- GitHub: https://github.com/iBUHub/AIStudioToAPI
- 关键 commits:
  - `f30085c` v1.2.0 发布,Camoufox 架构,最后一个干净版本
  - `ab54cdc` v1.2.1 最新 release (仅 UI 改动)
  - 本 fork 的 `9c75f07` Patchright 迁移
  - 本 fork 的 `9a74347` 加入 `_injectBuildScriptIntoIframe` + Canvas URL 切换 (这是坏掉的起点)

### 8.3 相关技术资料

- **SAPISIDHASH 算法** — Google 未公开但广泛逆向,可搜 "SAPISIDHASH Google authorization algorithm"。
- **gRPC-Web 协议** — https://github.com/grpc/grpc-web/blob/master/doc/PROTOCOL-WEB.md
- **Decoded: How Google AI Studio Securely Proxies Gemini API Requests** (Guillaume Laforge 博客,
  描述的是 AI Studio Apps 导出到独立部署时的机制,和我们看到的 iframe shim 机制不是同一条路,
  但背景信息有用) — https://glaforge.dev/posts/2026/02/09/decoded-how-google-ai-studio-securely-proxies-gemini-api-requests/

### 8.4 本文的证据链

所有断言的现场证据来自:

- `debug.log` (2026-04-13 运行捕获) — 现场抓包,包括完整的 `_aistudio-iframe.js` 下载、Canvas
  `index-*.js` 下载、成功的 `alkalimakersuite` POST 请求 + 响应
- 两个 `.js` 文件的完整源码 (见 artifacts)
- 对上游 `iBUHub/AIStudioToAPI` `src/core/BrowserManager.js` 的直接 grep (确认 build.js 注入点是
  注释掉的)

---

**文档版本**: 2026-04-13
**作者**: 本 fork 逆向工作 (Claude 协助,基于用户提供的实地 debug log 和 Canvas app 源文件)
