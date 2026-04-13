一键提取 Google AI Studio 的登录认证信息，导出为 JSON 文件，供 [AIStudioToAPI](https://github.com/iBUHub/AIStudioToAPI) 项目使用。

## 功能

- 在 AI Studio 页面右下角添加「Extract Auth」按钮
- 点击后自动提取当前登录账号的核心认证 Cookie（仅 9 个，最小化提取）
- 自动识别登录邮箱，导出为 `{邮箱}.json` 文件
- 导出格式与 AIStudioToAPI 的 `configs/auth/auth-N.json` 完全兼容

## 前置配置（仅需一次）

本脚本需要读取 `httpOnly` Cookie（如 `__Secure-1PSID`），请按以下步骤配置 Tampermonkey：

1. 点击浏览器中的 **Tampermonkey 图标** → **管理面板** → **设置**
2. 将「**配置模式**」切换为「**高级**」
3. 在「**安全**」区域，将「**允许脚本访问 Cookie**」设置为 **All**
4. 保存设置，刷新 AI Studio 页面

> **注意**：本脚本仅支持 **Tampermonkey**（需要 GM_cookie API）。Violentmonkey / Greasemonkey 不支持。

## 使用方法

1. 在浏览器中打开 [Google AI Studio](https://aistudio.google.com) 并登录
2. 页面右下角出现蓝色「📦 Extract Auth」按钮
3. 点击按钮 → 自动下载 `你的邮箱@gmail.com.json`
4. 将文件重命名为 `auth-0.json`（多账号依次为 `auth-1.json`、`auth-2.json`...）
5. 放入 AIStudioToAPI 项目的 `configs/auth/` 目录

## 提取的 Cookie 列表

仅提取 `.google.com` 域下的 9 个核心认证 Cookie，不包含任何跟踪或分析 Cookie：

| Cookie | 用途 |
|--------|------|
| `SID` | 主会话 ID |
| `HSID` | HTTP 会话绑定 |
| `SSID` | Secure 会话绑定 |
| `SAPISID` | API 认证签名计算 |
| `SIDCC` | 会话 consent |
| `__Secure-1PSID` | HTTPS 主会话 |
| `__Secure-1PAPISID` | HTTPS API 认证 |
| `__Secure-1PSIDCC` | HTTPS consent |
| `__Secure-1PSIDTS` | 会话时间戳 |

## 常见问题

**Q: 点击按钮提示「GM_cookie 不可用」？**
A: 请确认使用的是 Tampermonkey 并完成上方「前置配置」步骤。

**Q: 提示「缺少 __Secure-1PSID」？**
A: 请确保已在 AI Studio 页面完成登录，然后刷新页面重试。

**Q: 导出的 JSON 能直接用吗？**
A: 重命名为 `auth-N.json` 后放入 `configs/auth/` 即可，无需其他修改。
