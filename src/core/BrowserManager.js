/**
 * File: src/core/BrowserManager.js
 * Description: Browser manager for launching and controlling headless Camoufox (patched Firefox)
 *              instances. Uses camoufox-js (Apify's Node port of Camoufox) as the main kernel;
 *              it is ESM-only and must be loaded via dynamic import.
 *
 * Author: Ellinav, iBenzene, bbbugg, 挈挈
 */

const fs = require("fs");
const path = require("path");
const { firefox } = require("playwright");

// camoufox-js is ESM-only; cached module reference for this process.
let _camoufoxMod = null;
async function _getCamoufoxLaunchOptions(overrides) {
    if (!_camoufoxMod) {
        _camoufoxMod = await import("camoufox-js");
    }
    return _camoufoxMod.launchOptions(overrides);
}

const { parseProxyFromEnv } = require("../utils/ProxyUtils");
const {
    AuthExpiredError,
    isAuthExpiredError,
    ContextAbortedError,
    isContextAbortedError,
} = require("../utils/CustomErrors");

/**
 * Browser Manager Module
 * Responsible for launching, managing, and switching browser contexts
 */
class BrowserManager {
    constructor(logger, config, authSource) {
        this.logger = logger;
        this.config = config;
        this.authSource = authSource;
        // Per-account Firefox processes. Under a single shared Firefox, non-primary
        // tabs' in-page fetch() gets held by the renderer's global scheduler once
        // traffic goes concurrent — only the foremost tab drains. We give each
        // account its own Firefox process so every context is the primary tab of
        // its own browser and no cross-account scheduler contention exists.
        // Map<authIndex, BrowserInstance>.
        this.browsers = new Map();

        // Multi-context architecture: Store all initialized contexts
        // Map: authIndex -> {context, page, healthMonitorInterval}
        this.contexts = new Map();

        // Context pool state tracking
        this.initializingContexts = new Set(); // Indices currently being initialized in background
        this.abortedContexts = new Set(); // Indices that should be aborted during background init
        this._backgroundPreloadTask = null; // Current background preload task promise (only one at a time)
        this._backgroundPreloadAbort = false; // Flag to signal background task to abort
        this._pendingBackgroundPreloadRequest = null; // Follow-up preload request to run after the current task
        this._dispatchPrepTasks = new Map(); // Dedup per-auth dispatch wakeups

        // Legacy single context references (for backward compatibility)
        this.context = null;
        this.page = null;

        // currentAuthIndex is the single source of truth for current account, accessed via getter/setter
        // -1 means no account is currently active (invalid/error state)
        this._currentAuthIndex = -1;

        // Flag to distinguish intentional close from unexpected disconnect
        // Used by ConnectionRegistry callback to skip unnecessary reconnect attempts
        this.isClosingIntentionally = false;

        // ConnectionRegistry reference (set after construction to avoid circular dependency)
        this.connectionRegistry = null;

        // Background wakeup service status (instance-level, tracks this.page)
        // Prevents multiple BackgroundWakeup instances from running simultaneously
        this.backgroundWakeupRunning = false;

        // Added for background wakeup logic from new core
        this.noButtonCount = 0;

        // WebSocket initialization state per context - prevents cross-contamination
        // between concurrent init/reconnect operations on different accounts
        // Map: authIndex -> { success: boolean, failed: boolean }
        this._wsInitState = new Map();

        // Active rolled-off monitors (authIndex -> intervalId). Used by
        // _monitorRolledOffContext to trace whether a just-rolled-off page
        // is actually processing its queued work or sitting frozen.
        this._rolledOffMonitors = new Map();

        // Idle auto-refill: after ~5s of no WebUI account-related activity,
        // if the pool has free capacity, preload the next rotation accounts
        // until we hit maxContexts. Reset/rescheduled on every WebUI touch.
        this._idleRefillTimer = null;
        this._idleRefillDelayMs = 5000;

        // Target URL for AI Studio app
        this.targetUrl = "https://ai.studio/apps/c48c6178-8dad-4d16-8de7-bb78d265482c";

        // Firefox/Camoufox does not use Chromium-style command line args.
        // We keep this empty; Camoufox has its own anti-fingerprinting optimizations built-in.
        this.launchArgs = [];

        // Firefox-specific preferences for optimization (passed to firefox.launch)
        this.firefoxUserPrefs = {
            "app.update.enabled": false, // Disable auto updates
            "browser.cache.disk.enable": false, // Disable disk cache
            "browser.ping-centre.telemetry": false, // Disable ping telemetry
            "browser.safebrowsing.enabled": false, // Disable safe browsing
            "browser.safebrowsing.malware.enabled": false, // Disable malware check
            "browser.safebrowsing.phishing.enabled": false, // Disable phishing check
            "browser.search.update": false, // Disable search engine auto-update
            "browser.shell.checkDefaultBrowser": false, // Skip default browser check
            "browser.tabs.warnOnClose": false, // No warning on closing tabs
            "datareporting.policy.dataSubmissionEnabled": false, // Disable data reporting
            "dom.min_background_timeout_value": 1,
            // Mute audio
            // Additional anti-throttle prefs that the existing set
            // didn't cover: disable budget-timer-throttling entirely and
            // freeze-protection for worker tasks, so non-foreground
            // contexts keep firing their fetch() tasks without delay.
            "dom.min_background_timeout_value_without_budget_throttling": 4,

            // Disable background tab timer throttling (default: 1000ms)
            "dom.min_timeout_value": 1,
            // Reduce global minimum timer interval (default: 4ms per HTML5 spec)
            "dom.min_tracking_background_timeout_value": 1,

            // Disable tracking script background throttling (default: 10000ms)
            "dom.timeout.background_budget_regeneration_rate": 200,

            // Increase budget regeneration rate to prevent budget exhaustion
            "dom.timeout.background_throttling_max_budget": 100,
            // Increase max timer budget to reduce throttling frequency
            "dom.timeout.budget_throttling_max_delay": 0,

            "dom.timeout.enable_budget_timer_throttling": false,

            // Disable budget-based forced delay (default: 11250ms)
            "dom.timeout.throttling_delay": 2147483647,

            "dom.timeout.tracking_throttling_delay": 0,

            // Prevent throttling from ever activating (default: 50ms)
            "dom.webnotifications.enabled": false,

            "dom.workers.throttling.enableWorkerTaskFreezing": false,

            // Disable notifications
            "extensions.update.enabled": false,

            // Disable extension auto-update
            "general.smoothScroll": false,

            // Disable smooth scrolling
            "gfx.webrender.all": false,

            // Disable WebRender (GPU-based renderer)
            "layers.acceleration.disabled": true,

            // Disable GPU hardware acceleration
            "media.autoplay.default": 5,
            // 5 = Block all autoplay
            "media.volume_scale": "0.0",
            "network.dns.disablePrefetch": true, // Disable DNS prefetching
            "network.http.max-connections": 900, // Global max HTTP connections (default 900)
            "network.http.max-persistent-connections-per-server": 64, // Per-host limit (default 6) - raised to avoid serializing concurrent fetches across parallel contexts
            "network.http.speculative-parallel-limit": 0, // Disable speculative connections
            "network.prefetch-next": false, // Disable link prefetching
            "permissions.default.geo": 0, // 0 = Always deny geolocation
            "services.sync.enabled": false, // Disable Firefox Sync
            "toolkit.cosmeticAnimations.enabled": false, // Disable UI animations
            "toolkit.telemetry.archive.enabled": false, // Disable telemetry archive
            "toolkit.telemetry.enabled": false, // Disable telemetry
            "toolkit.telemetry.unified": false, // Disable unified telemetry
        };

        // Browser binary is managed by camoufox-js (downloaded via `npx camoufox-js fetch`
        // into ~/.cache/camoufox/ on Linux or ~/Library/Caches/camoufox/ on macOS).
        // The config.browserExecutablePath escape hatch is intentionally preserved for
        // deployments that want to pin a specific Camoufox binary; when set, it is
        // forwarded to camoufox-js as `executable_path` — but the binary's parent
        // directory MUST contain properties.json (not compatible with macOS .app bundles).
        this.browserExecutablePath = this.config.browserExecutablePath || null;
    }

    get currentAuthIndex() {
        return this._currentAuthIndex;
    }

    set currentAuthIndex(value) {
        this._currentAuthIndex = value;
    }

    /**
     * Set the ConnectionRegistry reference (called after construction to avoid circular dependency)
     * @param {ConnectionRegistry} connectionRegistry - The ConnectionRegistry instance
     */
    setConnectionRegistry(connectionRegistry) {
        this.connectionRegistry = connectionRegistry;
    }

    /**
     * Helper: Check for page errors that require refresh
     * @returns {Object} Object with error flags
     */
    async _checkPageErrors(page) {
        try {
            return await page.evaluate(() => {
                // eslint-disable-next-line no-undef
                const bodyText = document.body.innerText || "";
                return {
                    appletFailed: bodyText.includes("Failed to initialize applet"),
                    concurrentUpdates:
                        bodyText.includes("There are concurrent updates") || bodyText.includes("concurrent updates"),
                    snapshotFailed:
                        bodyText.includes("Failed to create snapshot") || bodyText.includes("Please try again"),
                };
            });
        } catch (e) {
            return { appletFailed: false, concurrentUpdates: false, snapshotFailed: false };
        }
    }

    /**
     * Helper: Wait for WebSocket initialization with log monitoring
     * Supports abort for background tasks and context deletion
     * @param {object} page - Playwright page object
     * @param {string} logPrefix - Log prefix for messages
     * @param {number} timeout - Timeout in milliseconds (default 60000)
     * @param {number} authIndex - Auth index for this context (default -1)
     * @param {boolean} isBackgroundTask - Whether this is a background preload task (default false)
     * @returns {Promise<boolean>} true if initialization succeeded, false if failed or aborted
     */
    async _waitForWebSocketInit(
        page,
        logPrefix = "[Browser]",
        timeout = 60000,
        authIndex = -1,
        isBackgroundTask = false
    ) {
        this.logger.info(`${logPrefix} ⏳ Waiting for WebSocket initialization (timeout: ${timeout / 1000}s)...`);

        const startTime = Date.now();
        const checkInterval = 250; // Check the state map every 250ms

        try {
            while (Date.now() - startTime < timeout) {
                // Check if this specific context was marked for abort
                if (this.abortedContexts.has(authIndex)) {
                    this.logger.info(`${logPrefix} WebSocket wait aborted (context marked for deletion)`);
                    throw new ContextAbortedError(authIndex, "marked for deletion");
                }

                // Check if background preload was aborted (only for background tasks)
                if (isBackgroundTask && this._backgroundPreloadAbort) {
                    this.logger.info(`${logPrefix} WebSocket wait aborted (background preload aborted)`);
                    throw new Error(
                        `Context initialization aborted for index ${authIndex} (background preload aborted)`
                    );
                }

                // Read state fresh each iteration. The console listener writes
                // this Map synchronously on every forwarded browser log, so a
                // plain Node-side poll is enough — no browser calls needed here.
                const state = this._wsInitState.get(authIndex);

                if (state && state.success) {
                    return true;
                }
                if (state && state.failed) {
                    this.logger.warn(`${logPrefix} Initialization failed`);
                    return false;
                }

                // Do NOT call page.evaluate / page.mouse.move from this loop.
                // Concurrent browser-level calls across parallel contexts hit
                // a Camoufox/Playwright Firefox serialization bottleneck that
                // caused individual waiters to hang indefinitely after their
                // WS connection had already succeeded.
                await new Promise(resolve => setTimeout(resolve, checkInterval));
            }

            // Timeout reached
            this.logger.error(`${logPrefix} ⏱️ WebSocket initialization timeout after ${timeout / 1000}s`);
            return false;
        } catch (error) {
            // If it's an abort error, re-throw it so the caller can handle it properly
            if (isContextAbortedError(error)) {
                throw error;
            }
            // For other errors, log and return false
            this.logger.error(`${logPrefix} Error during WebSocket initialization wait: ${error.message}`);
            return false;
        }
    }

    /**
     * Feature: Update authentication file
     * Writes the current storageState back to the auth file, effectively extending session validity.
     * @param {number} authIndex - The auth index to update
     */
    async _updateAuthFile(authIndex) {
        // Retrieve the target account's context from the multi-context Map to avoid cross-contamination of auth data by using this.context
        const contextData = this.contexts.get(authIndex);
        if (!contextData || !contextData.context) return;

        // Check availability of auto-update feature from config
        if (!this.config.enableAuthUpdate) {
            return;
        }

        try {
            const configDir = path.join(process.cwd(), "configs", "auth");
            const authFilePath = path.join(configDir, `auth-${authIndex}.json`);

            // Read original file content to preserve all fields (e.g. accountName, custom fields)
            // Relies on AuthSource validation (checks valid index AND file existence)
            const authData = this.authSource.getAuth(authIndex);
            if (!authData) {
                this.logger.warn(
                    `[Auth Update] Auth source #${authIndex} returned no data (invalid index or file missing), skipping update.`
                );
                return;
            }

            // Each account has its own Firefox now, so storageState() only
            // races against that one browser's own state — no cross-account
            // serialization needed.
            this.logger.debug(`[Auth Update] Reading storageState for #${authIndex}...`);
            const storageState = await contextData.context.storageState();
            this.logger.debug(`[Auth Update] storageState for #${authIndex} read.`);

            // Merge new credentials into existing data
            authData.cookies = storageState.cookies;
            authData.origins = storageState.origins;

            // Note: We do NOT force-set accountName. If it was there, it stays; if not, it remains missing.
            // This preserves the "missing state" as requested.

            // Overwrite the file with merged data
            await fs.promises.writeFile(authFilePath, JSON.stringify(authData, null, 2));

            this.logger.info(`[Auth Update] 💾 Successfully updated auth credentials for account #${authIndex}`);
        } catch (error) {
            this.logger.error(`[Auth Update] ❌ Failed to update auth file: ${error.message}`);
        }
    }

    /**
     * Interface: Notify user activity
     * Used to force wake up the Launch detection when a request comes in
     */
    notifyUserActivity() {
        if (this.noButtonCount > 0) {
            this.logger.info("[Browser] ⚡ User activity detected, forcing Launch detection wakeup...");
            this.noButtonCount = 0;
        }
    }

    /**
     * Helper: Generate a consistent numeric seed from a string
     * Used to keep fingerprints consistent for the same account index
     */
    _generateIdentitySeed(str) {
        let hashValue = 0;
        for (let i = 0; i < str.length; i++) {
            const charCode = str.charCodeAt(i);
            hashValue = (hashValue << 5) - hashValue + charCode;
            hashValue |= 0; // Convert to 32bit integer
        }
        return Math.abs(hashValue);
    }

    /**
     * Feature: Generate Privacy Protection Script (Stealth Mode)
     * Injects specific GPU info and masks webdriver properties to avoid bot detection.
     */
    _getPrivacyProtectionScript(authIndex) {
        let seedSource = `account_salt_${authIndex}`;

        // Attempt to use accountName (email) for better consistency across index reordering
        try {
            const authData = this.authSource.getAuth(authIndex);
            if (authData && authData.accountName && typeof authData.accountName === "string") {
                const cleanName = authData.accountName.trim().toLowerCase();
                if (cleanName.length > 0) {
                    seedSource = `account_email_${cleanName}`;
                }
            }
        } catch (e) {
            // Fallback to index-based seed if auth data read fails
        }

        // Use a consistent seed so the fingerprint remains static for this specific account
        let seed = this._generateIdentitySeed(seedSource);

        // Pseudo-random generator based on the seed
        const deterministicRandom = () => {
            const x = Math.sin(seed++) * 10000;
            return x - Math.floor(x);
        };

        // Select a GPU profile consistent with this account
        const gpuProfiles = [
            { renderer: "Intel Iris OpenGL Engine", vendor: "Intel Inc." },
            {
                renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1050 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)",
                vendor: "Google Inc. (NVIDIA)",
            },
            {
                renderer: "ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)",
                vendor: "Google Inc. (AMD)",
            },
        ];
        const profile = gpuProfiles[Math.floor(deterministicRandom() * gpuProfiles.length)];

        // We inject a noise variable to make the environment unique but stable
        const randomArtifact = Math.floor(deterministicRandom() * 1000);

        return `
            (function() {
                if (window._privacyProtectionInjected) return;
                window._privacyProtectionInjected = true;

                try {
                    // 0. Always-visible page state. In Camoufox/Firefox with
                    //    multiple parallel browser contexts, non-current pages
                    //    observe document.visibilityState === 'hidden', which
                    //    causes AI Studio's stream reader / rAF / timer loops
                    //    to pause — stalling in-flight generations on rolled-
                    //    off accounts during rapid usage-based switching.
                    //    Force the page to report as visible at all times so
                    //    the background drain path can actually complete.
                    try {
                        Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => false });
                        Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => 'visible' });
                        Object.defineProperty(Document.prototype, 'webkitHidden', { configurable: true, get: () => false });
                        Object.defineProperty(Document.prototype, 'webkitVisibilityState', { configurable: true, get: () => 'visible' });
                    } catch (_) {}
                    // Suppress any visibilitychange events the runtime fires
                    // before our override is installed. Listeners added AFTER
                    // our override will see 'visible' via the property getter.
                    try {
                        const origAddEventListener = EventTarget.prototype.addEventListener;
                        EventTarget.prototype.addEventListener = function(type, listener, options) {
                            if (type === 'visibilitychange' || type === 'webkitvisibilitychange') {
                                const wrapped = function(ev) {
                                    try { return listener.call(this, ev); } catch (_) {}
                                };
                                return origAddEventListener.call(this, type, wrapped, options);
                            }
                            // Suppress blur events entirely — AI Studio's
                            // Canvas app listens to window 'blur' to pause
                            // its fetch dispatch pipeline when the tab
                            // loses OS focus. Under multi-hot dispatch,
                            // only one tab can be foreground; the rest
                            // are effectively "blurred" forever and their
                            // fetches stall. Swallowing the event keeps
                            // AI Studio in its "focused" code path on
                            // every pool context.
                            if (type === 'blur' || type === 'webkitblur') {
                                return origAddEventListener.call(this, type, function() {}, options);
                            }
                            return origAddEventListener.call(this, type, listener, options);
                        };
                    } catch (_) {}

                    // Force document.hasFocus() to always return true so
                    // any code path that gates on focus (including AI
                    // Studio's Canvas app) treats the page as focused
                    // regardless of which tab Firefox actually put in
                    // the foreground. Paired with the blur-event
                    // suppression above this keeps non-foreground pool
                    // contexts in the "has focus" state.
                    try {
                        Document.prototype.hasFocus = function() { return true; };
                    } catch (_) {}
                    // Also shadow Window.prototype if any code calls
                    // window.top.document.hasFocus via a parent ref.
                    try {
                        Object.defineProperty(window, 'onblur', { configurable: true, get: () => null, set: () => {} });
                        Object.defineProperty(window, 'onfocus', { configurable: true, get: () => null, set: () => {} });
                    } catch (_) {}

                    // 1. Mask WebDriver property
                    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

                    // 2. Mock Plugins if empty
                    if (navigator.plugins.length === 0) {
                        Object.defineProperty(navigator, 'plugins', {
                            get: () => new Array(${3 + Math.floor(deterministicRandom() * 3)}),
                        });
                    }

                    // 3. Spoof WebGL Renderer (High Impact)
                    const getParameterProxy = WebGLRenderingContext.prototype.getParameter;
                    WebGLRenderingContext.prototype.getParameter = function(parameter) {
                        // 37445: UNMASKED_VENDOR_WEBGL
                        // 37446: UNMASKED_RENDERER_WEBGL
                        if (parameter === 37445) return '${profile.vendor}';
                        if (parameter === 37446) return '${profile.renderer}';
                        return getParameterProxy.apply(this, arguments);
                    };

                    // 4. Inject benign noise
                    window['_canvas_noise_${randomArtifact}'] = '${randomArtifact}';

                    if (window === window.top) {
                        console.log("[ProxyClient] Privacy protection layer active: ${profile.renderer}");

                        // PostMessage responder for authIndex requests from cross-origin iframes
                        // Injected via addInitScript so it's ready BEFORE any iframe loads (no race condition)
                        window.addEventListener('message', function(event) {
                            if (event.data && event.data.type === 'requestAuthIndex') {
                                console.log('[BrowserManager] Received authIndex request, responding with: ${authIndex}');
                                event.source.postMessage({
                                    type: 'authIndexResponse',
                                    authIndex: ${authIndex}
                                }, '*');
                            }
                        });
                    }
                } catch (err) {
                    console.error("[ProxyClient] Failed to inject privacy script", err);
                }
            })();
        `;
    }

    /**
     * Feature: Natural Mouse Movement
     * Simulates human-like mouse jitters instead of instant teleportation
     */
    async _simulateHumanMovement(page, targetX, targetY) {
        try {
            // Split movement into 3 segments with random deviations
            const steps = 3;
            for (let i = 1; i <= steps; i++) {
                const intermediateX = targetX + (Math.random() - 0.5) * (100 / i);
                const intermediateY = targetY + (Math.random() - 0.5) * (100 / i);

                // Final step must be precise
                const destX = i === steps ? targetX : intermediateX;
                const destY = i === steps ? targetY : intermediateY;

                await page.mouse.move(destX, destY, {
                    steps: 5 + Math.floor(Math.random() * 5), // Optimized speed (was 10-20)
                });
            }
        } catch (e) {
            // Ignore movement errors if page is closed
        }
    }

    /**
     * Deep-activate a pool context so it is in "launched" state before
     * joining the dispatchable pool. Must be called from
     * _initializeContext after WS init succeeds and before adding to
     * the contexts map.
     *
     * Background: the original architecture only called
     * _activateContext on the currently-active context, which is the
     * only path that runs _startBackgroundWakeup — and _startBackground
     * Wakeup is the only thing that physically clicks AI Studio's
     * "Launch" button to transition the session past the welcome/
     * rocket modal. Pre-loaded contexts that never became current
     * stayed on the modal; when multi-hot dispatch later routes a
     * request to them, the in-page fetch() never fires because the
     * session isn't launched.
     *
     * This helper replicates just the Launch-click phase, using a
     * pure page.evaluate() click (no page.mouse) so it does NOT need
     * the tab to be foreground / have OS focus. That's the key to
     * "bypass the blur block": instead of simulating a real user
     * interaction that Firefox gates on focus, we dispatch a DOM
     * click event directly from in-page JS, which fires regardless
     * of visibility / hasFocus state.
     *
     * @param {import('playwright').Page} page
     * @param {number} authIndex
     * @returns {Promise<boolean>} true if a Launch button was clicked, false if polling exhausted without finding one
     */
    async _deepActivateContext(page, authIndex, options = {}) {
        const logPrefix = options.logPrefix || `[Context#${authIndex}]`;
        const totalTimeoutMs = options.totalTimeoutMs ?? 5000;
        const pollIntervalMs = options.pollIntervalMs ?? 500;
        const startedAt = Date.now();
        this.logger.info(
            `${logPrefix} 🚀 Deep activate: polling for Launch/rocket button (up to ${totalTimeoutMs}ms)...`
        );

        while (Date.now() - startedAt < totalTimeoutMs) {
            if (page.isClosed?.()) {
                this.logger.warn(`${logPrefix} Deep activate aborted: page closed.`);
                return false;
            }
            if (this.abortedContexts.has(authIndex)) {
                this.logger.info(`${logPrefix} Deep activate aborted: context marked for deletion.`);
                return false;
            }

            let evalResult = null;
            try {
                evalResult = await page.evaluate(() => {
                    // Scan the interaction modal area first (where the
                    // rocket/Launch button typically lives), then fall
                    // back to a broader scan across buttons/divs.
                    const matches = /Launch|rocket_launch/i;
                    const minY = 0;
                    const maxY = 1200;

                    const scanRoots = [
                        // eslint-disable-next-line no-undef
                        ...Array.from(document.querySelectorAll(".interaction-modal button, .interaction-modal p")),
                        // eslint-disable-next-line no-undef
                        ...Array.from(document.querySelectorAll('button, div[role="button"], span, a, i')),
                    ];

                    for (const el of scanRoots) {
                        const text = (el.innerText || el.textContent || "").trim();
                        if (!matches.test(text)) continue;
                        const rect = el.getBoundingClientRect();
                        if (rect.width <= 0 || rect.height <= 0) continue;
                        if (rect.top < minY || rect.top > maxY) continue;

                        // Walk up to find a clickable ancestor (button
                        // or role=button) — AI Studio wraps text in
                        // spans / icons inside real buttons.
                        let clickTarget = el;
                        for (let depth = 0; depth < 3 && clickTarget.parentElement; depth++) {
                            if (clickTarget.tagName === "BUTTON") break;
                            if (clickTarget.getAttribute && clickTarget.getAttribute("role") === "button") break;
                            clickTarget = clickTarget.parentElement;
                        }

                        try {
                            // Pure DOM .click(): fires a synthetic
                            // click event regardless of whether the
                            // tab has OS focus or is blurred. This is
                            // exactly what bypasses the blur gate.
                            clickTarget.click();
                            return {
                                clicked: true,
                                tag: clickTarget.tagName || "UNKNOWN",
                                text: text.substring(0, 30),
                            };
                        } catch (e) {
                            return { clicked: false, error: String(e) };
                        }
                    }
                    return { clicked: false, notFound: true };
                });
            } catch (err) {
                this.logger.debug(`${logPrefix} Deep activate evaluate failed: ${err.message}`);
            }

            if (evalResult && evalResult.clicked) {
                const elapsedMs = Date.now() - startedAt;
                this.logger.info(
                    `${logPrefix} ✅ Deep activate: Launch clicked via JS (${evalResult.tag} "${evalResult.text}") after ${elapsedMs}ms`
                );
                // Small settle window so the modal transition finishes
                // before the context joins the dispatch pool.
                await page.waitForTimeout(1500).catch(() => {});
                return true;
            }

            await page.waitForTimeout(pollIntervalMs).catch(() => {});
        }

        const elapsedMs = Date.now() - startedAt;
        this.logger.warn(
            `${logPrefix} ⚠️ Deep activate: no Launch button found after ${elapsedMs}ms — context may still need manual activation to work under multi-hot dispatch`
        );
        return false;
    }

    /**
     * Count outstanding in-flight requests currently bound to a given auth
     * index, by walking the shared ConnectionRegistry.messageQueues map.
     * Used by the FastSwitch rate-limit + rolled-off monitor for DEBUG
     * visibility into whether a just-rolled-off page is actually draining.
     * @param {number} authIndex
     * @returns {number}
     */
    _countPendingRequestsByAuth(authIndex) {
        if (!this.connectionRegistry || !this.connectionRegistry.messageQueues) return 0;
        let count = 0;
        for (const entry of this.connectionRegistry.messageQueues.values()) {
            if (entry && entry.authIndex === authIndex) count++;
        }
        return count;
    }

    /**
     * DEBUG-only: after a FastSwitch rolls off a context, poll its
     * pending-request count every ~2s for ~20s and log the delta, so we
     * can see whether the rolled-off page is draining its in-flight
     * fetches or sitting frozen. Overwrites any prior monitor for the
     * same authIndex.
     * @param {number} authIndex - The just-rolled-off authIndex
     * @param {number} initialPending - Pending count captured pre-swap
     */
    _monitorRolledOffContext(authIndex, initialPending) {
        const prior = this._rolledOffMonitors.get(authIndex);
        if (prior) clearInterval(prior);

        const startedAt = Date.now();
        const durationMs = 20000;
        const intervalMs = 2000;

        this.logger.info(
            `🔬 [RolledOff-DBG] Monitoring #${authIndex} for ${durationMs}ms (initial pending=${initialPending})`
        );

        const id = setInterval(() => {
            const elapsed = Date.now() - startedAt;
            const currentPending = this._countPendingRequestsByAuth(authIndex);
            const isStillInPool = this.contexts.has(authIndex);
            const isCurrent = this._currentAuthIndex === authIndex;
            this.logger.info(
                `🔬 [RolledOff-DBG] #${authIndex} t+${elapsed}ms pending=${currentPending} inPool=${isStillInPool} isCurrent=${isCurrent}`
            );
            if (elapsed >= durationMs || currentPending === 0 || !isStillInPool) {
                clearInterval(id);
                this._rolledOffMonitors.delete(authIndex);
                this.logger.info(
                    `🔬 [RolledOff-DBG] #${authIndex} monitor stopped (elapsed=${elapsed}ms, finalPending=${currentPending}, drained=${currentPending === 0})`
                );
            }
        }, intervalMs);
        id.unref?.();
        this._rolledOffMonitors.set(authIndex, id);
    }

    /**
     * Activate a context as the current one: update legacy references, reset wakeup state,
     * and start background services (health monitor + wakeup + active trigger).
     * @param {object} ctx - The browser context object
     * @param {object} pg - The page object
     * @param {number} authIndex - The auth index being activated
     */
    _activateContext(ctx, pg, authIndex) {
        this.context = ctx;
        this.page = pg;
        this._currentAuthIndex = authIndex;
        this.noButtonCount = 0;
        // Tell Firefox to actually focus this tab so its JS runs at foreground
        // priority. Without this, we only update Node-side routing state,
        // and Firefox keeps the initial context as its sole foreground tab —
        // resulting in later-activated contexts getting their JS task queue
        // de-prioritized to the point where in-flight fetches stall.
        // Safe here (unlike in _initializeContext) because _activateContext
        // is only called sequentially on a single already-loaded page, not
        // across multiple contexts in parallel.
        pg.bringToFront().catch(err => {
            this.logger.debug(`[Browser] bringToFront for #${authIndex} failed: ${err.message}`);
        });
        this._startHealthMonitor();
        this._startBackgroundWakeup();
    }

    async _primeContextForDispatch(authIndex, page, options = {}) {
        const contextData = this.contexts.get(authIndex);
        if (!contextData || !page || page.isClosed?.()) return false;
        if (contextData.dispatchReady === true) return true;

        const logPrefix = options.logPrefix || `[DispatchPrime#${authIndex}]`;
        const totalTimeoutMs = options.totalTimeoutMs ?? 2500;
        const intervalMs = options.intervalMs ?? 350;
        const startedAt = Date.now();
        let primedOnce = false;

        while (Date.now() - startedAt < totalTimeoutMs) {
            if (page.isClosed?.()) return false;
            await page.bringToFront().catch(() => {});
            try {
                const vp = page.viewportSize() || { height: 1080, width: 1920 };
                const moveX = Math.floor(Math.random() * Math.max(100, vp.width * 0.4));
                const moveY = Math.floor(Math.random() * Math.max(100, vp.height * 0.4));
                await this._simulateHumanMovement(page, moveX, moveY);
                primedOnce = true;
            } catch (err) {
                this.logger.debug(`${logPrefix} human movement failed: ${err.message}`);
            }

            const handledLaunch = await this._attemptLaunchWakeup(page, logPrefix).catch(err => {
                this.logger.debug(`${logPrefix} launch wake failed: ${err.message}`);
                return false;
            });
            if (handledLaunch) {
                contextData.dispatchReady = true;
                this.logger.info(`${logPrefix} dispatch-ready via launch wakeup.`);
                return true;
            }

            await page.waitForTimeout(intervalMs).catch(() => {});
        }

        if (primedOnce) {
            contextData.dispatchReady = true;
            this.logger.info(`${logPrefix} dispatch-ready after focus/human wake cycle.`);
            return true;
        }

        return contextData.dispatchReady === true;
    }

    /**
     * Ring-activate every loaded context in sequence so each page is
     * individually brought to foreground for a short window. This is the
     * workaround for the "pre-loaded-but-never-activated context stalls
     * in-page fetch" bug: contexts that only went through _initializeContext
     * (newContext + goto + WS init) but never through _activateContext keep
     * Firefox's per-page task scheduler de-prioritized, so dispatched
     * requests arrive over the WS but page.fetch() never fires on the wire.
     *
     * We cycle through every loaded context, call _activateContext on it,
     * wait long enough for Firefox to actually process the focus change,
     * then move on. The ring ENDS on `primaryIndex` so that after this
     * method returns, that index is the current active context — matching
     * what the caller in ProxyServerSystem expects from preloadContextPool.
     *
     * @param {number} primaryIndex - Which index should remain active at the end
     * @param {string} logPrefix - Log prefix for status messages
     */
    async _ringActivateLoadedContexts(primaryIndex, logPrefix = "[RingActivate]") {
        const loaded = [...this.contexts.entries()].filter(([, data]) => {
            if (!data || !data.context || !data.page) return false;
            try {
                return !data.page.isClosed();
            } catch {
                return false;
            }
        });
        if (loaded.length === 0) return;
        if (loaded.length === 1) {
            // Nothing to cycle; the single loaded context will be activated
            // by the caller in the normal flow.
            return;
        }

        // Put primaryIndex last so it ends as the active context. Everything
        // else goes in Map iteration order (insertion order, which follows
        // the startup sync-preload sequence).
        const primary = loaded.find(([idx]) => idx === primaryIndex);
        const others = loaded.filter(([idx]) => idx !== primaryIndex);
        const ordered = primary ? [...others, primary] : loaded;

        const activationDwellMs = 1200;
        this.logger.info(
            `${logPrefix} 🔄 Ring-activating ${ordered.length} loaded contexts sequentially ` +
                `(dwell=${activationDwellMs}ms, order=[${ordered.map(([idx]) => idx).join(", ")}])...`
        );

        for (const [idx, data] of ordered) {
            try {
                if (!data.page || data.page.isClosed()) {
                    this.logger.warn(`${logPrefix} Skipping #${idx}: page closed before activation`);
                    continue;
                }
                this.logger.info(`${logPrefix} Activating context #${idx}...`);
                this._activateContext(data.context, data.page, idx);
                await this._primeContextForDispatch(idx, data.page, {
                    intervalMs: 400,
                    logPrefix: `${logPrefix} [Prime#${idx}]`,
                    totalTimeoutMs: activationDwellMs,
                }).catch(err => {
                    this.logger.warn(`${logPrefix} Prime for #${idx} failed: ${err.message}`);
                });
                // Let Firefox's task scheduler actually process bringToFront
                // and let the page's JS task queue drain at foreground priority
                // before we steal focus again for the next context in the ring.
                await data.page.waitForTimeout(activationDwellMs).catch(() => {});
            } catch (err) {
                this.logger.warn(`${logPrefix} Ring activation for #${idx} failed: ${err.message}`);
            }
        }

        this.logger.info(`${logPrefix} ✅ Ring activation complete, primary=#${primaryIndex}`);
    }

    /**
     * Before routing a request to a non-current account, give that page a
     * short foreground wake-up window and one more Launch-button scan. In
     * multi-browser mode this is the last missing step for accounts that were
     * preloaded successfully but never became `currentAuthIndex`, so they
     * received WS proxy requests without ever kicking off ProxyUnaryCall.
     * Concurrent requests for the same authIndex share one wake-up promise.
     * @param {number} authIndex
     */
    async prepareContextForDispatch(authIndex) {
        if (!Number.isInteger(authIndex) || authIndex < 0) return;
        if (authIndex === this._currentAuthIndex) return;

        const existing = this._dispatchPrepTasks.get(authIndex);
        if (existing) {
            await existing;
            return;
        }

        const prepTask = (async () => {
            const contextData = this.contexts.get(authIndex);
            const page = contextData?.page;
            if (!page || page.isClosed?.()) return;
            if (contextData.dispatchReady === true) return;

            this.logger.info(`[DispatchPrep#${authIndex}] Waking non-current context before forwarding request...`);
            await this._primeContextForDispatch(authIndex, page, {
                intervalMs: 300,
                logPrefix: `[DispatchPrep#${authIndex}]`,
                totalTimeoutMs: 3000,
            });
        })();

        this._dispatchPrepTasks.set(authIndex, prepTask);
        try {
            await prepTask;
        } finally {
            if (this._dispatchPrepTasks.get(authIndex) === prepTask) {
                this._dispatchPrepTasks.delete(authIndex);
            }
        }
    }

    /**
     * Helper: Send active trigger
     * Sends a trigger request to wake up Google backend
     * This is a fire-and-forget operation - we don't wait for the trigger request to complete
     * @param {string} logPrefix - Log prefix for step messages (e.g., "[Browser]" or "[Reconnect]")
     * @param {Page} page - The page object to use (defaults to this.page if not provided)
     */
    _sendActiveTrigger(logPrefix = "[Browser]", page = null) {
        // Active Trigger (Hack to wake up Google Backend)
        this.logger.info(`${logPrefix} ⚡ Sending active trigger request to Launch flow...`);

        // Use provided page or fall back to this.page
        const targetPage = page || this.page;

        // Fire-and-forget: send trigger request in background without waiting
        targetPage
            .evaluate(async () => {
                try {
                    await fetch("https://generativelanguage.googleapis.com/v1beta/models?key=ActiveTrigger", {
                        headers: { "Content-Type": "application/json" },
                        method: "GET",
                    });
                } catch (e) {
                    console.log("[ProxyClient] Active trigger sent");
                }
            })
            .catch(() => {
                // Silently ignore errors - this is a best-effort trigger
            });
    }

    /**
     * Helper: Navigate to target page and wake up the page
     * Contains the common navigation and page activation logic
     * @param {Page} page - The page object to navigate
     * @param {string} logPrefix - Log prefix for messages (e.g., "[Browser]" or "[Reconnect]")
     */
    async _navigateAndWakeUpPage(page, logPrefix = "[Browser]") {
        this.logger.debug(`${logPrefix} Navigating to target page...`);

        await page.goto(this.targetUrl, {
            timeout: 180000,
            waitUntil: "domcontentloaded",
        });
        this.logger.debug(`${logPrefix} Page loaded.`);

        // Wait for page to stabilize
        await page.waitForTimeout(2000 + Math.random() * 1000);
    }

    /**
    /**
     * Helper: Check page status and detect various error conditions
     * Detects: cookie expiration, region restrictions, 403 errors, page load failures
     * @param {Page} page - The page object to check
     * @param {string} logPrefix - Log prefix for messages (e.g., "[Browser]" or "[Reconnect]")
     * @param {number} authIndex - The auth index being checked (default: -1). When >= 0 and a login redirect is detected, this method will await this.authSource.markAsExpired(authIndex) to mark the auth as expired.
     * @throws {Error} If any error condition is detected
     */
    async _checkPageStatusAndErrors(page, logPrefix = "[Browser]", authIndex = -1) {
        const currentUrl = page.url();
        let pageTitle = "";
        try {
            pageTitle = await page.title();
        } catch (e) {
            this.logger.warn(`${logPrefix} Unable to get page title: ${e.message}`);
        }

        this.logger.debug(`${logPrefix} [Diagnostic] URL: ${currentUrl}`);
        this.logger.debug(`${logPrefix} [Diagnostic] Title: "${pageTitle}"`);

        // Check for various error conditions
        if (
            currentUrl.includes("accounts.google.com") ||
            currentUrl.includes("ServiceLogin") ||
            pageTitle.includes("Sign in") ||
            pageTitle.includes("登录")
        ) {
            // Mark auth as expired if authIndex is provided
            if (authIndex >= 0 && this.authSource) {
                await this.authSource.markAsExpired(authIndex);
            }
            throw new AuthExpiredError();
        }

        if (pageTitle.includes("Available regions") || pageTitle.includes("not available")) {
            throw new Error(
                "🚨 The current IP does not support access to Google AI Studio. Please change the IP and restart!"
            );
        }

        if (pageTitle.includes("403") || pageTitle.includes("Forbidden")) {
            throw new Error("🚨 403 Forbidden: Current IP reputation too low, access denied by Google risk control.");
        }

        if (currentUrl === "about:blank") {
            throw new Error("🚨 Page load failed (about:blank), possibly network timeout or browser crash.");
        }
    }

    /**
     * Helper: Handle various popups with intelligent detection
     * Uses short polling instead of long hard-coded timeouts
     * @param {Page} page - The page object to check for popups
     * @param {string} logPrefix - Log prefix for messages (e.g., "[Browser]" or "[Reconnect]")
     */
    async _handlePopups(page, logPrefix = "[Browser]") {
        this.logger.debug(`${logPrefix} 🔍 Starting intelligent popup detection (max 6s)...`);

        const popupConfigs = [
            {
                logFound: `${logPrefix} Found "Continue to the app" button, clicking...`,
                name: "Continue to the app",
                text: "Continue to the app",
            },
        ];

        // Polling-based detection with smart exit conditions
        // - Initial wait: give popups time to render after page load
        // - Consecutive idle tracking: exit after N consecutive iterations with no new popups
        const maxIterations = 12; // Max polling iterations
        const pollInterval = 500; // Interval between polls (ms)
        const minIterations = 6; // Min iterations (3s), ensure slow popups have time to load
        const idleThreshold = 4; // Exit after N consecutive iterations with no new popups
        const handledPopups = new Set();
        let consecutiveIdleCount = 0; // Counter for consecutive idle iterations

        for (let i = 0; i < maxIterations; i++) {
            let foundAny = false;

            for (const popup of popupConfigs) {
                if (handledPopups.has(popup.name)) continue;

                try {
                    // Use DOM operation to find and click button
                    const clicked = await page.evaluate(text => {
                        // eslint-disable-next-line no-undef
                        const buttons = document.querySelectorAll("button");
                        for (const btn of buttons) {
                            // Check if the element occupies space (simple visibility check)
                            const rect = btn.getBoundingClientRect();
                            const isVisible = rect.width > 0 && rect.height > 0;

                            if (isVisible) {
                                const btnText = (btn.innerText || "").trim();
                                if (btnText === text) {
                                    btn.click();
                                    return true;
                                }
                            }
                        }
                        return false;
                    }, popup.text);

                    if (clicked) {
                        this.logger.info(popup.logFound);
                        handledPopups.add(popup.name);
                        foundAny = true;

                        // "Continue to the app" confirms entry, exit popup detection early
                        if (popup.name === "Continue to the app") {
                            return;
                        }

                        // Short pause after clicking to let next popup appear
                        await page.waitForTimeout(800);
                    }
                } catch (error) {
                    // Element not visible or doesn't exist is expected here,
                    // but propagate clearly critical browser/page issues.
                    if (error && error.message) {
                        const msg = error.message;
                        if (
                            msg.includes("Execution context was destroyed") ||
                            msg.includes("Target page, context or browser has been closed") ||
                            msg.includes("Protocol error") ||
                            msg.includes("Navigation failed because page was closed")
                        ) {
                            throw error;
                        }
                        if (this.logger && typeof this.logger.debug === "function") {
                            this.logger.debug(
                                `${logPrefix} Ignored error while checking popup "${popup.name}": ${msg}`
                            );
                        }
                    }
                }
            }

            // Update consecutive idle counter
            if (foundAny) {
                consecutiveIdleCount = 0; // Found popup, reset counter
            } else {
                consecutiveIdleCount++;
            }

            // Exit conditions:
            // 1. Must have completed minimum iterations (ensure slow popups have time to load)
            // 2. Consecutive idle count exceeds threshold (no new popups appearing)
            if (i >= minIterations - 1 && consecutiveIdleCount >= idleThreshold) {
                this.logger.debug(
                    `${logPrefix} Popup detection complete (${i + 1} iterations, ${handledPopups.size} popups handled)`
                );
                break;
            }

            if (i < maxIterations - 1) {
                await page.waitForTimeout(pollInterval);
            }
        }

        // Log final summary
        if (handledPopups.size === 0) {
            this.logger.info(`${logPrefix} No popups detected during scan`);
        } else {
            this.logger.info(
                `${logPrefix} Popup detection complete: handled ${handledPopups.size} popup(s) - ${Array.from(handledPopups).join(", ")}`
            );
        }
    }

    /**
     * Helper: Try to click Launch button if it exists on the page
     * This is not a popup, but a page button that may need to be clicked
     * @param {Page} page - The page object to check for Launch button
     * @param {string} logPrefix - Log prefix for messages (e.g., "[Browser]" or "[Reconnect]")
     */
    async _tryClickLaunchButton(page, logPrefix = "[Browser]") {
        try {
            this.logger.debug(`${logPrefix} 🔍 Checking for Launch button...`);

            // Try to find Launch button with multiple selectors
            const launchSelectors = [
                'button:text("Launch")',
                'button:has-text("Launch")',
                'button[aria-label*="Launch"]',
                'button span:has-text("Launch")',
                'div[role="button"]:has-text("Launch")',
            ];

            let clicked = false;
            for (const selector of launchSelectors) {
                try {
                    const element = page.locator(selector).first();
                    if (await element.isVisible({ timeout: 2000 })) {
                        this.logger.debug(`${logPrefix} Found Launch button with selector: ${selector}`);
                        await element.click({ force: true, timeout: 5000 });
                        this.logger.info(`${logPrefix} Launch button clicked successfully`);
                        clicked = true;
                        await page.waitForTimeout(1000);
                        break;
                    }
                } catch (e) {
                    // Continue to next selector
                }
            }

            if (!clicked) {
                this.logger.info(`${logPrefix} No Launch button found`);
            }
        } catch (error) {
            this.logger.warn(`${logPrefix} ⚠️ Error while checking for Launch button: ${error.message}`);
        }
    }

    /**
     * Feature: Background Health Monitor (The "Scavenger")
     * Periodically cleans up popups and keeps the session alive.
     * In multi-context mode, stores the interval in the context data.
     */
    _startHealthMonitor() {
        const authIndex = this._currentAuthIndex;
        if (authIndex < 0) {
            this.logger.warn("[Browser] Cannot start health monitor: no active auth index");
            return;
        }

        // Get context data
        const contextData = this.contexts.get(authIndex);
        if (!contextData) {
            this.logger.warn(`[Browser] Cannot start health monitor: context #${authIndex} not found`);
            return;
        }

        // Clear existing interval if any
        if (contextData.healthMonitorInterval) {
            clearInterval(contextData.healthMonitorInterval);
        }

        this.logger.info(`[Context#${authIndex}] 🛡️ Background health monitor service (Scavenger) started...`);

        let tickCount = 0;

        // Run every 4 seconds
        contextData.healthMonitorInterval = setInterval(async () => {
            try {
                // Check if this is still the current active account
                // This prevents background contexts from running healthMonitor unnecessarily
                if (this._currentAuthIndex !== authIndex) {
                    // Silently skip - this context is not active
                    return;
                }

                const page = contextData.page;
                // Double check page status
                if (!page || page.isClosed()) {
                    if (contextData.healthMonitorInterval) {
                        clearInterval(contextData.healthMonitorInterval);
                        contextData.healthMonitorInterval = null;
                        this.logger.info(`[HealthMonitor#${authIndex}] Page closed, stopped background task.`);
                    }
                    return;
                }

                tickCount++;

                try {
                    // 1. Keep-Alive: Random micro-actions (30% chance)
                    if (Math.random() < 0.3) {
                        try {
                            // Optimized randomness based on viewport
                            const vp = page.viewportSize() || { height: 1080, width: 1920 };

                            // Scroll
                            // eslint-disable-next-line no-undef
                            await page.evaluate(() => window.scrollBy(0, (Math.random() - 0.5) * 20));
                            // Human-like mouse jitter
                            const x = Math.floor(Math.random() * (vp.width * 0.8));
                            const y = Math.floor(Math.random() * (vp.height * 0.8));
                            await this._simulateHumanMovement(page, x, y);
                        } catch (e) {
                            /* empty */
                        }
                    }

                    // 2. Anti-Timeout: Move to top-left corner (1,1) every ~1 minute (15 ticks)
                    if (tickCount % 15 === 0) {
                        try {
                            await this._simulateHumanMovement(page, 1, 1);
                        } catch (e) {
                            /* empty */
                        }
                    }

                    // 3. Auto-Save Auth: Every ~24 hours (21600 ticks * 4s = 86400s)
                    if (tickCount % 21600 === 0) {
                        try {
                            this.logger.info(
                                `[HealthMonitor#${authIndex}] 💾 Triggering daily periodic auth file update...`
                            );
                            await this._updateAuthFile(authIndex);
                        } catch (e) {
                            this.logger.warn(`[HealthMonitor#${authIndex}] Auth update failed: ${e.message}`);
                        }
                    }

                    // 4. Popup & Overlay Cleanup
                    await page.evaluate(() => {
                        const blockers = [
                            "div.cdk-overlay-backdrop",
                            "div.cdk-overlay-container",
                            "div.cdk-global-overlay-wrapper",
                        ];

                        const targetTexts = ["Reload", "Retry", "Got it", "Dismiss", "Not now", "Continue to the app"];

                        // Remove passive blockers
                        blockers.forEach(selector => {
                            // eslint-disable-next-line no-undef
                            document.querySelectorAll(selector).forEach(el => el.remove());
                        });

                        // Click active buttons if visible
                        // eslint-disable-next-line no-undef
                        document.querySelectorAll("button").forEach(btn => {
                            // Check if the element occupies space (simple visibility check)
                            const rect = btn.getBoundingClientRect();
                            const isVisible = rect.width > 0 && rect.height > 0;

                            if (isVisible) {
                                const text = (btn.innerText || "").trim();
                                const ariaLabel = btn.getAttribute("aria-label");

                                // Match text or aria-label
                                if (targetTexts.includes(text) || ariaLabel === "Close") {
                                    console.log(`[ProxyClient] HealthMonitor clicking: ${text || "Close Button"}`);
                                    btn.click();
                                }
                            }
                        });
                    });
                } catch (err) {
                    // Silent catch to prevent log spamming on navigation
                }
            } catch (globalError) {
                // Catch any other unexpected errors in the interval
                this.logger.warn(`[HealthMonitor#${authIndex}] Detailed error: ${globalError.message}`);
                // If the page is definitely gone, stop the monitor
                if (globalError.message.includes("Target page, context or browser has been closed")) {
                    if (contextData.healthMonitorInterval) {
                        clearInterval(contextData.healthMonitorInterval);
                        contextData.healthMonitorInterval = null;
                        this.logger.info(
                            `[HealthMonitor#${authIndex}] Page closed (detected by error), stopped background task.`
                        );
                    }
                }
            }
        }, 4000);
    }

    /**
     * Helper: Save debug information (screenshot and HTML) to root directory
     * @param {string} suffix - Suffix for the debug file names
     * @param {number} [authIndex] - Optional auth index to get the correct page from contexts Map
     * @param {object} [explicitPage] - Optional explicit page object to use (for cases where page is not yet in contexts)
     */
    async _saveDebugArtifacts(suffix = "final", authIndex = null, explicitPage = null) {
        // Prioritize explicit page, then retrieve from contexts Map, finally fall back to this.page
        let targetPage = explicitPage;
        if (!targetPage) {
            targetPage = this.page;
            if (authIndex !== null && this.contexts.has(authIndex)) {
                const ctxData = this.contexts.get(authIndex);
                if (ctxData && ctxData.page) {
                    targetPage = ctxData.page;
                }
            }
        }
        if (!targetPage || targetPage.isClosed()) return;
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
            const screenshotPath = path.join(process.cwd(), `debug_screenshot_${suffix}_${timestamp}.png`);
            await targetPage.screenshot({
                fullPage: true,
                path: screenshotPath,
            });
            this.logger.info(`[Debug] Failure screenshot saved to: ${screenshotPath}`);

            const htmlPath = path.join(process.cwd(), `debug_page_source_${suffix}_${timestamp}.html`);
            const htmlContent = await targetPage.content();
            fs.writeFileSync(htmlPath, htmlContent);
            this.logger.info(`[Debug] Failure page source saved to: ${htmlPath}`);
        } catch (e) {
            this.logger.error(`[Debug] Failed to save debug artifacts: ${e.message}`);
        }
    }

    async _attemptLaunchWakeup(page, logPrefix = "[Browser]") {
        const targetInfo = await page.evaluate(() => {
            try {
                const preciseCandidates = Array.from(
                    // eslint-disable-next-line no-undef
                    document.querySelectorAll(".interaction-modal p, .interaction-modal button")
                );
                for (const el of preciseCandidates) {
                    if (/Launch|rocket_launch/i.test((el.innerText || "").trim())) {
                        const rect = el.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            return {
                                found: true,
                                tagName: el.tagName,
                                text: (el.innerText || "").trim().substring(0, 15),
                                x: rect.left + rect.width / 2,
                                y: rect.top + rect.height / 2,
                            };
                        }
                    }
                }
            } catch (e) {
                /* empty */
            }

            const MIN_Y = 400;
            const MAX_Y = 800;
            const isValid = rect => rect.width > 0 && rect.height > 0 && rect.top > MIN_Y && rect.top < MAX_Y;

            // eslint-disable-next-line no-undef
            const candidates = Array.from(document.querySelectorAll("button, span, div, a, i"));
            for (const el of candidates) {
                const text = (el.innerText || "").trim();
                if (!/Launch|rocket_launch/i.test(text)) continue;

                let targetEl = el;
                let rect = targetEl.getBoundingClientRect();
                let parentDepth = 0;
                while (parentDepth < 3 && targetEl.parentElement) {
                    if (targetEl.tagName === "BUTTON" || targetEl.getAttribute("role") === "button") break;
                    const parent = targetEl.parentElement;
                    const pRect = parent.getBoundingClientRect();
                    if (isValid(pRect)) {
                        targetEl = parent;
                        rect = pRect;
                    }
                    parentDepth++;
                }

                if (isValid(rect)) {
                    return {
                        found: true,
                        tagName: targetEl.tagName,
                        text: text.substring(0, 15),
                        x: rect.left + rect.width / 2,
                        y: rect.top + rect.height / 2,
                    };
                }
            }
            return { found: false };
        });

        if (!targetInfo.found) {
            return false;
        }

        this.logger.info(`${logPrefix} 🎯 Found Rocket/Launch button [${targetInfo.tagName}], engaging...`);
        await page.mouse.move(targetInfo.x, targetInfo.y, { steps: 5 });
        await new Promise(r => setTimeout(r, 300));
        await page.mouse.down();
        await new Promise(r => setTimeout(r, 400));
        await page.mouse.up();

        this.logger.info(`${logPrefix} 🖱️ Physical click executed. Verifying...`);
        await new Promise(r => setTimeout(r, 1500));

        const isStillThere = await page.evaluate(() => {
            // eslint-disable-next-line no-undef
            const els = Array.from(document.querySelectorAll('button, span, div[role="button"]'));
            return els.some(el => {
                const r = el.getBoundingClientRect();
                return /Launch|rocket_launch/i.test(el.innerText) && r.top > 400 && r.top < 800 && r.height > 0;
            });
        });

        if (isStillThere) {
            this.logger.warn(`${logPrefix} ⚠️ Physical click ineffective, attempting JS force click...`);
            await page.evaluate(() => {
                const candidates = Array.from(
                    // eslint-disable-next-line no-undef
                    document.querySelectorAll('button, span, div[role="button"]')
                );
                for (const el of candidates) {
                    const r = el.getBoundingClientRect();
                    if (/Launch|rocket_launch/i.test(el.innerText) && r.top > 400 && r.top < 800) {
                        (el.closest("button") || el).click();
                        return true;
                    }
                }
                return false;
            });
            await new Promise(r => setTimeout(r, 2000));
        } else {
            this.logger.info(`${logPrefix} ✅ Click successful, button disappeared.`);
        }

        return true;
    }

    /**
     * Feature: Background Wakeup & "Launch" Button Handler
     * Specifically handles the "Rocket/Launch" button which blocks model loading.
     * This service is bound to this.page (instance-level), not individual contexts.
     * Only one instance should run at a time, tracking the current active page.
     */
    async _startBackgroundWakeup() {
        // Prevent multiple instances from running simultaneously
        if (this.backgroundWakeupRunning) {
            this.logger.info("[Browser] BackgroundWakeup already running, skipping duplicate start.");
            return;
        }

        this.logger.debug("[Browser] Starting BackgroundWakeup initialization...");
        this.backgroundWakeupRunning = true;

        // Initial buffer - wait before starting the main loop to let page stabilize
        await new Promise(r => setTimeout(r, 1500));

        // Verify page is still valid after the initial delay
        try {
            if (!this.page || this.page.isClosed()) {
                this.backgroundWakeupRunning = false;
                this.logger.info(
                    "[Browser] BackgroundWakeup stopped: page became null or closed during startup delay."
                );
                return;
            }
        } catch (error) {
            this.backgroundWakeupRunning = false;
            this.logger.warn(`[Browser] BackgroundWakeup stopped: error checking page status: ${error.message}`);
            return;
        }

        this.logger.info("[Browser] 🛡️ Background Wakeup Service (Rocket Handler) started...");

        // Main loop: directly use this.page, automatically follows context switches
        while (this.page && !this.page.isClosed()) {
            try {
                const currentPage = this.page; // Capture for this iteration

                // 1. Force page wake-up
                await currentPage.bringToFront().catch(() => {});

                // Micro-movements to trigger rendering frames in headless mode
                const vp = currentPage.viewportSize() || { height: 1080, width: 1920 };
                const moveX = Math.floor(Math.random() * (vp.width * 0.3));
                const moveY = Math.floor(Math.random() * (vp.height * 0.3));
                await this._simulateHumanMovement(currentPage, moveX, moveY);

                // 2. Intelligent Scan for "Launch" or "Rocket" button
                const handledLaunch = await this._attemptLaunchWakeup(currentPage, "[Browser]");

                // 3. Execute Click if found
                if (handledLaunch) {
                    // Long sleep on success, but check for context switches every second
                    for (let i = 0; i < 60; i++) {
                        if (this.noButtonCount === 0) {
                            this.logger.info(`[Browser] ⚡ Woken up early due to user activity or context switch.`);
                            break; // Wake up early if user activity detected
                        }
                        await new Promise(r => setTimeout(r, 1000));
                    }
                } else {
                    this.noButtonCount++;
                    // Smart Sleep
                    if (this.noButtonCount > 20) {
                        // Long sleep, but check for user activity
                        for (let i = 0; i < 30; i++) {
                            if (this.noButtonCount === 0) break; // Woken up by request
                            await new Promise(r => setTimeout(r, 1000));
                        }
                    } else {
                        await new Promise(r => setTimeout(r, 1500));
                    }
                }
            } catch (e) {
                // Ignore errors during page navigation/reload
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        // Reset flag when loop exits
        this.backgroundWakeupRunning = false;

        // Log the reason for stopping
        if (!this.page) {
            this.logger.info("[Browser] Background Wakeup Service stopped: this.page is null.");
        } else if (this.page.isClosed()) {
            this.logger.info("[Browser] Background Wakeup Service stopped: this.page was closed.");
        } else {
            this.logger.info("[Browser] Background Wakeup Service stopped: unknown reason.");
        }
    }

    /**
     * Preload a pool of contexts at startup
     * Synchronously initializes the first context, then starts remaining in background
     * @param {number[]} startupOrder - Ordered list of auth indices to try
     * @param {number} maxContexts - Max pool size (0 = unlimited)
     * @returns {Promise<{firstReady: number|null}>}
     */
    async preloadContextPool(startupOrder, maxContexts) {
        // Inflate the target pool by rollingPreloadCount so the startup
        // background preload already warms up the "next-rotation" standby
        // slot that rebalanceContextPool will also maintain at runtime.
        const rollingPreload = Math.max(0, this.config.rollingPreloadCount ?? 0);
        const effectiveMax = maxContexts === 0 ? 0 : maxContexts + rollingPreload;
        const poolSize = effectiveMax === 0 ? startupOrder.length : Math.min(effectiveMax, startupOrder.length);
        // How many contexts to bring up synchronously before the system starts
        // accepting traffic. Defaults to the full pool so the user doesn't have
        // to rely on the background preload to eventually catch up.
        const configuredSync = this.config.startupSyncPreloadCount;
        const syncTarget = Math.min(
            typeof configuredSync === "number" && configuredSync > 0 ? configuredSync : poolSize,
            poolSize,
            startupOrder.length
        );
        const parallelLimit = Math.max(1, this.config.startupParallelInitLimit || 3);
        this.logger.info(
            `🚀 [ContextPool] Starting pool preload (pool=${poolSize}, syncTarget=${syncTarget}, parallelLimit=${parallelLimit}, order=[${startupOrder.join(", ")}])...`
        );

        // Abort any existing background preload/rebalance to ensure clean state
        await this.abortBackgroundPreload();

        // Per-account Firefox processes are launched lazily by
        // _initializeContext → _ensureBrowserFor(authIndex). No upfront
        // shared-browser launch is needed here.

        // Init accounts in parallel batches until we either hit the sync target
        // or exhaust the startup order. `firstReady` tracks the first successful
        // index by startupOrder position — used later to activate the primary context.
        let firstReady = null;
        let cursor = 0;

        const markFirstReady = idx => {
            if (firstReady === null) firstReady = idx;
        };

        while (this.contexts.size < syncTarget && cursor < startupOrder.length) {
            // Collect the next batch of fresh accounts to initialize in parallel.
            const budget = Math.max(0, syncTarget - this.contexts.size);
            const batchLimit = Math.min(parallelLimit, budget);
            const batch = [];

            while (batch.length < batchLimit && cursor < startupOrder.length) {
                const authIndex = startupOrder[cursor++];

                if (this.contexts.has(authIndex)) {
                    this.logger.info(`[ContextPool] Context #${authIndex} already exists, reusing`);
                    markFirstReady(authIndex);
                    continue;
                }

                if (this.initializingContexts.has(authIndex)) {
                    this.logger.info(`[ContextPool] Context #${authIndex} being initialized elsewhere, skipping`);
                    continue;
                }

                batch.push(authIndex);
            }

            if (batch.length === 0) continue;

            this.logger.info(
                `[ContextPool] Initializing batch [${batch.join(", ")}] in parallel (${this.contexts.size}/${syncTarget} sync target)`
            );

            // Reserve init slots BEFORE fanning out so that any concurrent
            // launchOrSwitchContext call observes them as "in progress".
            batch.forEach(idx => this.initializingContexts.add(idx));

            const results = await Promise.allSettled(batch.map(idx => this._initializeContext(idx)));

            results.forEach((res, i) => {
                const idx = batch[i];
                if (res.status === "fulfilled") {
                    markFirstReady(idx);
                    this.logger.info(`✅ [ContextPool] Context #${idx} ready (${this.contexts.size}/${syncTarget}).`);
                } else {
                    const reason = res.reason?.message || String(res.reason);
                    this.logger.error(`❌ [ContextPool] Context #${idx} failed: ${reason}`);
                }
            });
        }

        if (firstReady === null) {
            if (this.browsers.size > 0) await this.closeBrowser();
            return { firstReady: null };
        }

        // Ring-activate every sync-loaded context so each page is individually
        // brought to foreground once. Fixes the "preloaded-but-never-activated
        // context stalls in-page fetch" bug — see _ringActivateLoadedContexts
        // docstring. Ends on `firstReady` so the normal activation path that
        // runs right after preloadContextPool is already aligned.
        await this._ringActivateLoadedContexts(firstReady, "[ContextPool]");

        // Early return if pool size is 1 (single context mode) - no need for background preload
        if (poolSize === 1) {
            this.logger.info(`[ContextPool] Single context mode (maxContexts=1), skipping background preload.`);
            return { firstReady };
        }

        if (this.contexts.size >= poolSize) {
            this.logger.info(
                `[ContextPool] Sync preload filled pool (${this.contexts.size}/${poolSize}), skipping background preload.`
            );
            return { firstReady };
        }

        // Background: calculate remaining contexts using rotation order (same logic as rebalanceContextPool)
        // This ensures startup pool matches the rotation order used during account switching
        const rotation = this.authSource.getRotationIndices();
        const currentCanonical = this.authSource.getCanonicalIndex(firstReady);
        const startPos = currentCanonical !== null ? Math.max(rotation.indexOf(currentCanonical), 0) : 0;
        const ordered = [];
        for (let i = 0; i < rotation.length; i++) {
            ordered.push(rotation[(startPos + i) % rotation.length]);
        }

        // Calculate how many more contexts we need to reach poolSize
        const needCount = poolSize - this.contexts.size;
        if (needCount > 0) {
            // Get candidates from ordered list (excluding already initialized contexts)
            // Convert existing contexts to canonical indices to handle duplicate accounts
            const existingCanonical = new Set(
                [...this.contexts.keys()].map(idx => this.authSource.getCanonicalIndex(idx) ?? idx)
            );
            const candidates = ordered.filter(
                idx => !existingCanonical.has(idx) && !this.initializingContexts.has(idx)
            );

            if (candidates.length > 0) {
                this.logger.info(
                    `[ContextPool] Background preload will try [${candidates.join(", ")}] to reach pool size ${poolSize} (need ${needCount} more)`
                );
                // Pass all candidates, not just the first needCount
                // This allows the background task to try subsequent accounts if earlier ones fail
                this._preloadBackgroundContexts(candidates, poolSize);
            }
        }

        return { firstReady };
    }

    /**
     * Launch browser instance if not already running
     */
    /**
     * Launch (or return the already-launched) dedicated Firefox instance for
     * one specific account. Each account gets its own main Firefox process so
     * that its page is the primary tab of its own browser — sidestepping the
     * single-process scheduler hold on non-primary tab fetches we hit under
     * a shared browser.
     *
     * @param {number} authIndex - which account this browser belongs to
     * @returns {Promise<import('playwright').Browser>}
     */
    async _ensureBrowserFor(authIndex) {
        const existing = this.browsers.get(authIndex);
        if (existing) return existing;

        const proxyConfig = parseProxyFromEnv();
        this.logger.info(`🚀 [Browser#${authIndex}] Launching dedicated Firefox instance...`);
        const camouOpts = await _getCamoufoxLaunchOptions({
            args: this.launchArgs,
            firefox_user_prefs: this.firefoxUserPrefs,
            geoip: true,
            headless: true,
            humanize: false,
            i_know_what_im_doing: true,
            ...(this.browserExecutablePath ? { executable_path: this.browserExecutablePath } : {}),
        });
        const browser = await firefox.launch({
            ...camouOpts,
            ...(proxyConfig ? { proxy: proxyConfig } : {}),
        });
        browser.on("disconnected", () => {
            this.browsers.delete(authIndex);
            if (!this.isClosingIntentionally) {
                this.logger.error(`❌ [Browser#${authIndex}] Firefox unexpectedly disconnected!`);
                // Scrub just this account's context rather than wiping the pool —
                // the other accounts have their own Firefox processes and are
                // unaffected.
                this._cleanupSingleContext(authIndex);
            } else {
                this.logger.debug(`[Browser#${authIndex}] Firefox closed intentionally.`);
            }
        });
        this.browsers.set(authIndex, browser);
        this.logger.info(`✅ [Browser#${authIndex}] Firefox launched (${browser.version()}).`);
        return browser;
    }

    /**
     * Cleanup resources for a single auth index without touching other
     * contexts or their per-account browsers.
     */
    _cleanupSingleContext(authIndex) {
        const contextData = this.contexts.get(authIndex);
        if (contextData?.healthMonitorInterval) {
            clearInterval(contextData.healthMonitorInterval);
            contextData.healthMonitorInterval = null;
        }
        this.contexts.delete(authIndex);
        this.initializingContexts.delete(authIndex);
        this.abortedContexts.delete(authIndex);
        this._wsInitState.delete(authIndex);
        if (this._currentAuthIndex === authIndex) {
            this.context = null;
            this.page = null;
            this._currentAuthIndex = -1;
        }
    }

    /**
     * Abort any ongoing background preload task and wait for it to complete
     * This is a public method that encapsulates access to internal preload state
     * @returns {Promise<void>} Resolves when the background task has been aborted and cleaned up
     */
    async abortBackgroundPreload() {
        if (!this._backgroundPreloadTask) {
            this._pendingBackgroundPreloadRequest = null;
            return; // No task to abort
        }

        this.logger.info(`[ContextPool] Aborting background preload task...`);
        this._backgroundPreloadAbort = true;
        this._pendingBackgroundPreloadRequest = null;

        try {
            await this._backgroundPreloadTask;
        } catch (error) {
            // Ignore errors from aborted task
            this.logger.debug(`[ContextPool] Background preload aborted: ${error.message}`);
        }

        this.logger.info(`[ContextPool] Background preload aborted successfully`);
    }

    /**
     * Background sequential initialization of contexts (fire-and-forget)
     * Only one instance should be active at a time. New calls are coalesced
     * into a follow-up request instead of aborting the in-flight task, because
     * repeated rebalance ticks can otherwise keep killing half-finished
     * browser launches before the replacement account ever reaches the pool.
     * @param {number[]} indices - Auth indices to initialize (candidates, may exceed pool size)
     * @param {number} maxPoolSize - Stop when this.contexts.size reaches this limit (0 = no limit)
     */
    async _preloadBackgroundContexts(indices, maxPoolSize = 0) {
        const normalizedIndices = [...new Set(indices)].filter(
            authIndex => !this.contexts.has(authIndex) && !this.initializingContexts.has(authIndex)
        );
        if (normalizedIndices.length === 0) {
            return;
        }

        if (this._backgroundPreloadTask) {
            const existing = this._pendingBackgroundPreloadRequest;
            const mergedIndices = [...new Set([...(existing?.indices || []), ...normalizedIndices])];
            const mergedMaxPoolSize =
                existing && existing.maxPoolSize === 0
                    ? 0
                    : maxPoolSize === 0
                      ? 0
                      : Math.max(existing?.maxPoolSize || 0, maxPoolSize);
            this._pendingBackgroundPreloadRequest = {
                indices: mergedIndices,
                maxPoolSize: mergedMaxPoolSize,
            };
            this.logger.info(
                `[ContextPool] Background preload already running, queued follow-up preload for [${mergedIndices.join(", ")}] (poolCap=${mergedMaxPoolSize || "unlimited"}).`
            );
            return;
        }

        // Reset abort flag and create new background task
        this._backgroundPreloadAbort = false;
        const currentTask = this._executePreloadTask(normalizedIndices, maxPoolSize);
        this._backgroundPreloadTask = currentTask;

        // Don't await here - this is fire-and-forget
        // But ensure we clean up the task reference when done
        currentTask
            .catch(error => {
                this.logger.error(`[ContextPool] Background preload task failed: ${error.message}`);
            })
            .finally(() => {
                // Only clear if this is still the current task
                if (this._backgroundPreloadTask === currentTask) {
                    this._backgroundPreloadTask = null;
                }

                const pending = this._pendingBackgroundPreloadRequest;
                this._pendingBackgroundPreloadRequest = null;
                if (pending) {
                    this._preloadBackgroundContexts(pending.indices, pending.maxPoolSize).catch(error => {
                        this.logger.error(`[ContextPool] Queued background preload task failed: ${error.message}`);
                    });
                }
            });
    }

    /**
     * Internal method to execute the actual preload task
     * @private
     */
    async _executePreloadTask(indices, maxPoolSize) {
        this.logger.info(
            `[ContextPool] Background preload starting for [${indices.join(", ")}] (poolCap=${maxPoolSize || "unlimited"})...`
        );

        const parallelLimit = Math.max(1, this.config.startupParallelInitLimit || 3);
        let aborted = false;
        let cursor = 0;

        while (cursor < indices.length) {
            // Check if abort was requested
            if (this._backgroundPreloadAbort) {
                this.logger.info(`[ContextPool] Background preload aborted by request`);
                aborted = true;
                break;
            }

            // Per-account Firefox processes are launched lazily by
            // _initializeContext → _ensureBrowserFor. Nothing to do upfront.

            // Check pool size limit — bail out if we've reached it.
            if (maxPoolSize > 0 && this.contexts.size >= maxPoolSize) {
                this.logger.info(`[ContextPool] Pool size limit reached, stopping preload`);
                break;
            }

            // Build the next batch respecting both the parallel limit and the
            // remaining pool budget. `initializingContexts.size` counts toward
            // the budget so we don't overshoot while a previous batch is still
            // settling (shouldn't happen here since batches are awaited, but safe).
            const remainingSlots =
                maxPoolSize > 0
                    ? Math.max(0, maxPoolSize - this.contexts.size - this.initializingContexts.size)
                    : parallelLimit;
            const batchLimit = Math.min(parallelLimit, remainingSlots);

            if (batchLimit <= 0) {
                this.logger.info(`[ContextPool] Pool size limit reached while building batch, stopping preload`);
                break;
            }

            const batch = [];
            while (batch.length < batchLimit && cursor < indices.length) {
                if (this._backgroundPreloadAbort) break;
                const authIndex = indices[cursor++];

                if (this.contexts.has(authIndex)) {
                    this.logger.debug(`[ContextPool] Context #${authIndex} already exists, skipping`);
                    continue;
                }
                if (this.initializingContexts.has(authIndex)) {
                    this.logger.info(
                        `[ContextPool] Context #${authIndex} already being initialized by another task, skipping`
                    );
                    continue;
                }

                batch.push(authIndex);
            }

            if (batch.length === 0) continue;

            this.logger.info(
                `[ContextPool] Background preload batch init [${batch.join(", ")}] in parallel (poolCap=${maxPoolSize || "unlimited"})`
            );

            batch.forEach(idx => this.initializingContexts.add(idx));

            const results = await Promise.allSettled(
                batch.map(idx => this._initializeContext(idx, true)) // Mark as background task
            );

            const primeTasks = [];
            results.forEach((res, i) => {
                const idx = batch[i];
                if (res.status === "fulfilled") {
                    this.logger.info(`✅ [ContextPool] Background context #${idx} ready, priming for dispatch...`);
                    const ctxData = this.contexts.get(idx);
                    if (ctxData?.page && !ctxData.page.isClosed?.()) {
                        primeTasks.push(
                            this._primeContextForDispatch(idx, ctxData.page, {
                                logPrefix: `[BackgroundPrime#${idx}]`,
                                totalTimeoutMs: 3000,
                            }).catch(err => {
                                this.logger.warn(`[ContextPool] Background prime for #${idx} failed: ${err.message}`);
                            })
                        );
                    }
                } else {
                    const isAbortError = isContextAbortedError(res.reason);
                    if (isAbortError) {
                        this.logger.info(`[ContextPool] Background context #${idx} aborted as requested`);
                        aborted = true;
                    } else {
                        const reason = res.reason?.message || String(res.reason);
                        this.logger.error(`❌ [ContextPool] Background context #${idx} failed: ${reason}`);
                    }
                }
            });

            // Prime newly-initialized contexts so they become dispatch-ready.
            // Without this, background-preloaded contexts stay dispatchReady=false
            // and _pickDispatchAuthIndex never selects them, causing single-account
            // regression after a 429/503 switch.
            if (primeTasks.length > 0) {
                await Promise.allSettled(primeTasks);
            }
            // Note: initializingContexts and abortedContexts cleanup is handled in _initializeContext's finally block
        }

        if (!aborted) {
            this.logger.info(`[ContextPool] Background preload complete.`);
        }
    }

    /**
     * Pre-cleanup before switching to a new account
     * Removes contexts that will be excess after the switch to avoid exceeding maxContexts
     * @param {number} targetAuthIndex - The account index we're about to switch to
     */
    async preCleanupForSwitch(targetAuthIndex) {
        const maxContexts = this.config.maxContexts;
        const isUnlimited = maxContexts === 0;

        // Abort the background preload ONLY in single-context mode. In multi-context
        // mode the preload's work is valuable — the contexts it is initializing are
        // protected from eviction (see the priority-3 skip and rebalance protection
        // below), so killing it wastes browser setup work and has historically
        // produced orphaned `initializingContexts` entries that blocked every
        // subsequent switch with a fatal pre-cleanup assertion.
        if (maxContexts === 1) {
            await this.abortBackgroundPreload();
        }

        // Defensive: if any orphaned entries remain in `initializingContexts`
        // (stuck `_initializeContext` that never saw the abort signal, finished
        // without cleaning up, etc.), log them and proceed. The downstream
        // switch logic already handles "initializing" entries via
        // `_waitForContextInit` with its own 120s timeout, so a stale entry
        // degrades gracefully instead of aborting the whole switch attempt.
        if (this.initializingContexts.size > 0) {
            const initializingList = [...this.initializingContexts].join(", ");
            this.logger.warn(
                `[ContextPool] Pre-cleanup: initializingContexts still non-empty [${initializingList}]; proceeding anyway (switch target=#${targetAuthIndex}).`
            );
        }

        // In unlimited mode, no need to pre-cleanup
        if (isUnlimited) {
            this.logger.debug(`[ContextPool] Pre-cleanup skipped: unlimited mode`);
            return;
        }

        // If target context already exists or is being initialized, no new context will be created
        if (this.contexts.has(targetAuthIndex)) {
            this.logger.debug(`[ContextPool] Pre-cleanup skipped: target context #${targetAuthIndex} already exists`);
            return;
        }

        if (this.initializingContexts.has(targetAuthIndex)) {
            this.logger.debug(
                `[ContextPool] Pre-cleanup skipped: target context #${targetAuthIndex} is being initialized`
            );
            return;
        }

        // Calculate how many contexts we'll have after adding the new one
        // Include contexts that are currently being initialized in background
        const currentSize = this.contexts.size + this.initializingContexts.size;
        const futureSize = currentSize + 1;

        // If we won't exceed the limit, no cleanup needed
        if (futureSize <= maxContexts) {
            this.logger.debug(
                `[ContextPool] Pre-cleanup skipped: future size ${futureSize} (${this.contexts.size} ready + ${this.initializingContexts.size} initializing + 1 new) <= maxContexts ${maxContexts}`
            );
            return;
        }

        // We need to remove (futureSize - maxContexts) contexts
        const removeCount = futureSize - maxContexts;

        // Build removal priority list (from lowest to highest priority to keep):
        // Priority 1: Old duplicate accounts (removedIndices from duplicateGroups)
        // Priority 2: Expired accounts (not the target if target is expired)
        // Priority 3: Accounts in rotation, ordered by distance from target (farthest first)

        const rotation = this.authSource.getRotationIndices();
        const targetCanonical = this.authSource.getCanonicalIndex(targetAuthIndex);
        const duplicateGroups = this.authSource.getDuplicateGroups();
        const expiredIndices = this.authSource.expiredIndices || [];

        // Get all old duplicate indices (not in rotation)
        const oldDuplicates = new Set();
        for (const group of duplicateGroups) {
            for (const idx of group.removedIndices) {
                oldDuplicates.add(idx);
            }
        }

        // Build rotation order starting from target (accounts closer to target have higher priority)
        // Special case: If target is expired, use targetAuthIndex directly as startPos
        const isTargetExpired = expiredIndices.includes(targetAuthIndex);
        let startPos;
        if (isTargetExpired) {
            // For expired accounts, find rotation position by comparing index values (expired accounts are never in rotation)
            startPos = rotation.indexOf(targetAuthIndex);
            if (startPos === -1) {
                // Target not in rotation (it's expired), find closest position by index value
                startPos = 0;
                for (let i = 0; i < rotation.length; i++) {
                    if (rotation[i] > targetAuthIndex) {
                        startPos = i;
                        break;
                    }
                }
            }
        } else {
            startPos = Math.max(rotation.indexOf(targetCanonical), 0);
        }
        const orderedFromTarget = [];
        for (let i = 0; i < rotation.length; i++) {
            orderedFromTarget.push(rotation[(startPos + i) % rotation.length]);
        }

        // Collect all context indices (existing + initializing)
        const allContextIndices = new Set([...this.contexts.keys(), ...this.initializingContexts]);

        // Build removal priority list
        const removalPriority = [];

        // Special case: If target is an old duplicate, prioritize removing its canonical version
        // Because we're about to create the old duplicate, and they're the same account
        const isTargetOldDuplicate = oldDuplicates.has(targetAuthIndex);
        if (isTargetOldDuplicate) {
            // Find the canonical version of target in existing contexts
            for (const idx of allContextIndices) {
                if (this.authSource.getCanonicalIndex(idx) === targetCanonical && idx === targetCanonical) {
                    removalPriority.push(idx);
                    break;
                }
            }
        }

        // Priority 1: Old duplicate accounts (lowest priority to keep)
        for (const idx of allContextIndices) {
            if (oldDuplicates.has(idx) && !removalPriority.includes(idx)) {
                removalPriority.push(idx);
            }
        }

        // Priority 2: Expired accounts (except target if target is expired)
        for (const idx of allContextIndices) {
            if (expiredIndices.includes(idx) && idx !== targetAuthIndex && !removalPriority.includes(idx)) {
                removalPriority.push(idx);
            }
        }

        // Priority 3: Accounts in rotation, from farthest to closest (reverse rotation order).
        // This IS the LRU eviction step that keeps pool size bounded. In-flight traffic is
        // protected by the graceful-drain path inside closeContext below (it waits for the
        // account's in-flight requests to finish up to CONTEXT_CLOSE_DRAIN_TIMEOUT_MS before
        // tearing the context down), so eviction here no longer abruptly kills live work.
        for (let i = orderedFromTarget.length - 1; i >= 0; i--) {
            const canonical = orderedFromTarget[i];
            // Find all contexts with this canonical index
            for (const idx of allContextIndices) {
                if (this.authSource.getCanonicalIndex(idx) === canonical && !removalPriority.includes(idx)) {
                    removalPriority.push(idx);
                }
            }
        }

        // Remove contexts according to priority until we have enough space
        const toRemove = removalPriority.slice(0, removeCount);

        if (toRemove.length < removeCount) {
            this.logger.warn(
                `[ContextPool] Pre-cleanup: only freed ${toRemove.length}/${removeCount} slot(s) for switch to #${targetAuthIndex}; pool will temporarily exceed maxContexts=${maxContexts}.`
            );
        }

        this.logger.info(
            `[ContextPool] Pre-cleanup: removing ${toRemove.length} contexts before switch to #${targetAuthIndex}: [${toRemove}] (${this.contexts.size} ready + ${this.initializingContexts.size} initializing)`
        );

        for (const idx of toRemove) {
            await this.closeContext(idx, { graceful: true });
        }
    }

    /**
     * Rebalance context pool after account changes
     * Removes excess contexts and starts missing ones in background
     */
    async rebalanceContextPool() {
        const maxContexts = this.config.maxContexts;
        // maxContexts === 0 means unlimited pool size
        const isUnlimited = maxContexts === 0;
        const rollingPreload = Math.max(0, this.config.rollingPreloadCount ?? 0);
        // Effective pool cap = dispatchable hot contexts + rolling pre-warm
        // standby slots. The extra slot(s) give the next-rotation candidate
        // a chance to be fully initialized BEFORE usage-based rotation
        // actually needs it, eliminating the cold-start tail where the
        // last batch of a burst hits an account that has to init from
        // scratch.
        const effectiveMax = isUnlimited ? 0 : maxContexts + rollingPreload;

        // Build full rotation ordered from current account
        const rotation = this.authSource.getRotationIndices();
        const currentCanonical =
            this._currentAuthIndex >= 0 ? this.authSource.getCanonicalIndex(this._currentAuthIndex) : null;
        const startPos = currentCanonical !== null ? Math.max(rotation.indexOf(currentCanonical), 0) : 0;
        const ordered = [];
        for (let i = 0; i < rotation.length; i++) {
            ordered.push(rotation[(startPos + i) % rotation.length]);
        }

        // Targets = first effectiveMax from ordered (or all available if unlimited).
        // In unlimited mode, include all valid accounts (rotation + duplicates), excluding expired.
        let targets;
        if (isUnlimited) {
            // Filter out expired accounts from availableIndices
            const nonExpiredAvailable = this.authSource.availableIndices.filter(idx => !this.authSource.isExpired(idx));
            targets = new Set(nonExpiredAvailable);
        } else {
            targets = new Set(ordered.slice(0, effectiveMax));
        }

        // ROLLING REPLACEMENT: Close loaded contexts that have fallen out of
        // the current rotation window AND have no in-flight requests. This
        // keeps the pool rolling forward as the rotation cursor advances,
        // instead of letting old accounts accumulate indefinitely. Safety
        // guards:
        //   • never retire the currently-active account (UI / routing anchor)
        //   • never retire a context with pending work (in-flight > 0)
        //   • never retire a context still being initialized
        const registry = this.connectionRegistry;
        const retireEligible = [];
        for (const idx of [...this.contexts.keys()]) {
            const canonical = this.authSource.getCanonicalIndex(idx) ?? idx;
            if (targets.has(canonical)) continue;
            if (idx === this._currentAuthIndex) continue;
            if (this.initializingContexts.has(idx)) continue;
            const inflight =
                registry && typeof registry.getInflightCountForAuth === "function"
                    ? registry.getInflightCountForAuth(idx)
                    : 0;
            if (inflight > 0) {
                this.logger.debug(`[ContextPool] Rebalance retire skipped: #${idx} still has ${inflight} in-flight`);
                continue;
            }
            retireEligible.push(idx);
        }

        // Cap actual retire count so post-retire loaded pool never drops
        // below effectiveMax. Retiring a stale context BEFORE its
        // replacement has finished initializing would shrink dispatch
        // parallelism during the burst that's currently hitting the
        // remaining pool. Anything beyond the cap is deferred — it will
        // be picked up on the next rebalance tick (fired either when a
        // new preload completes or via the stalled-rebalance timer).
        const loadedCount = this.contexts.size;
        const maxRetireAllowed = isUnlimited ? retireEligible.length : Math.max(0, loadedCount - effectiveMax);
        const retireCandidates = retireEligible.slice(0, maxRetireAllowed);
        const deferredRetireDueToSize = retireEligible.slice(maxRetireAllowed);

        // Convert active contexts to canonical indices so duplicates collapse.
        const activeCanonical = new Set(
            [...this.contexts.keys(), ...this.initializingContexts].map(
                idx => this.authSource.getCanonicalIndex(idx) ?? idx
            )
        );

        // Missing targets: target rotation entries that are NOT already
        // loaded or being initialized. These must be preloaded even if
        // the pool currently sits at effectiveMax, because some of the
        // loaded contexts may be stale (outside the target window) and
        // stuck waiting for in-flight work to drain before they can be
        // retired. If we gated preload on "pool has free slot" those
        // missing target entries would never get pre-warmed under
        // sustained load, breaking rolling replacement.
        const missingTargets = isUnlimited
            ? ordered.filter(idx => !activeCanonical.has(idx))
            : [...targets].filter(idx => !activeCanonical.has(idx));

        // Stalled retirements: contexts outside the target window that
        // still have in-flight work. We'll schedule another rebalance
        // shortly to pick them up once their queues drain.
        const stalledRetirements = [];
        for (const idx of [...this.contexts.keys()]) {
            const canonical = this.authSource.getCanonicalIndex(idx) ?? idx;
            if (targets.has(canonical)) continue;
            if (idx === this._currentAuthIndex) continue;
            if (this.initializingContexts.has(idx)) continue;
            if (retireCandidates.includes(idx)) continue;
            stalledRetirements.push(idx);
        }

        this.logger.info(
            `[ContextPool] Rebalance: targets=[${[...targets]}], effectiveMax=${isUnlimited ? "∞" : effectiveMax}, currentPool=[${[...this.contexts.keys()]}], missing=[${missingTargets}], retire=[${retireCandidates}], deferredBySize=[${deferredRetireDueToSize}], stalled=[${stalledRetirements}]`
        );

        // Fire retirements in parallel, non-blocking. closeContext is
        // graceful-safe for 0-inflight contexts so this is cheap.
        for (const idx of retireCandidates) {
            this.closeContext(idx, { graceful: false }).catch(err => {
                this.logger.warn(`[ContextPool] Rebalance retire close failed for #${idx}: ${err.message}`);
            });
        }

        // Preload missing target entries. Pass 0 (no cap) because we
        // already filtered to exactly the target-window-minus-loaded
        // set, so the number of inits is bounded. This lets rolling
        // preload proceed even when stale contexts still hold slots.
        if (missingTargets.length > 0) {
            this._preloadBackgroundContexts(missingTargets, 0);
        }

        // If any contexts were stuck waiting for in-flight drain,
        // re-run rebalance shortly so they get retired once their
        // work finishes. Debounced to avoid stacking timers.
        if (stalledRetirements.length > 0) {
            if (this._stalledRebalanceTimer) clearTimeout(this._stalledRebalanceTimer);
            this._stalledRebalanceTimer = setTimeout(() => {
                this._stalledRebalanceTimer = null;
                this.rebalanceContextPool().catch(err => {
                    this.logger.warn(`[ContextPool] Stalled rebalance retry failed: ${err.message}`);
                });
            }, 3000);
            this._stalledRebalanceTimer.unref?.();
        }
    }

    /**
     * Wait for a background context initialization to complete
     * @param {number} authIndex - The auth index to wait for
     * @param {number} timeoutMs - Timeout in milliseconds
     */
    async _waitForContextInit(authIndex, timeoutMs = 120000) {
        const start = Date.now();
        while (this.initializingContexts.has(authIndex)) {
            if (Date.now() - start > timeoutMs) {
                throw new Error(`Timeout waiting for context #${authIndex} initialization`);
            }
            await new Promise(r => setTimeout(r, 500));
        }
    }

    /**
     * Initialize a single context for the given auth index
     * This is a helper method used by both preloadContextPool and launchOrSwitchContext
     * @param {number} authIndex - The auth index to initialize
     * @param {boolean} isBackgroundTask - Whether this is a background preload task (can be aborted by _backgroundPreloadAbort)
     * @returns {Promise<{context, page}>}
     */
    async _initializeContext(authIndex, isBackgroundTask = false) {
        let context = null;
        let page = null;

        try {
            // Check if this context has been marked for abort before starting
            if (this.abortedContexts.has(authIndex)) {
                throw new ContextAbortedError(authIndex, "marked for deletion");
            }

            // Check if background preload was aborted (only for background tasks)
            if (isBackgroundTask && this._backgroundPreloadAbort) {
                throw new ContextAbortedError(authIndex, "background preload aborted");
            }

            // Initialize per-context WebSocket state to ensure clean state for this context
            // Each context gets its own state object, preventing cross-contamination
            // between concurrent init/reconnect operations on different accounts
            this._wsInitState.set(authIndex, { failed: false, success: false });

            const proxyConfig = parseProxyFromEnv();
            const storageStateObject = this.authSource.getAuth(authIndex);
            if (!storageStateObject) {
                throw new Error(`Failed to get or parse auth source for index ${authIndex}.`);
            }

            // Viewport Randomization
            const randomWidth = 1920 + Math.floor(Math.random() * 50);
            const randomHeight = 1080 + Math.floor(Math.random() * 50);

            // Check abort status before expensive operations
            if (this.abortedContexts.has(authIndex) || (isBackgroundTask && this._backgroundPreloadAbort)) {
                throw new ContextAbortedError(authIndex, "marked for deletion");
            }

            // Launch a dedicated Firefox process for this account (or reuse the
            // existing one if it was already launched). Each browser sees only
            // its own single newContext/newPage call, so the Camoufox
            // concurrent-newContext deadlock that used to require shared-lock
            // serialization is no longer reachable — every browser is its own
            // serialization domain.
            const accountBrowser = await this._ensureBrowserFor(authIndex);

            // Check abort status after launch
            if (this.abortedContexts.has(authIndex) || (isBackgroundTask && this._backgroundPreloadAbort)) {
                throw new ContextAbortedError(authIndex, "marked for deletion");
            }

            this.logger.debug(`[Context#${authIndex}] Creating browser context...`);
            context = await accountBrowser.newContext({
                deviceScaleFactor: 1,
                storageState: storageStateObject,
                viewport: { height: randomHeight, width: randomWidth },
                ...(proxyConfig ? { proxy: proxyConfig } : {}),
            });
            this.logger.debug(`[Context#${authIndex}] Context created, injecting privacy script...`);

            // Check abort status after context creation
            if (this.abortedContexts.has(authIndex) || (isBackgroundTask && this._backgroundPreloadAbort)) {
                throw new ContextAbortedError(authIndex, "marked for deletion");
            }

            // Inject Privacy Script immediately after context creation
            const privacyScript = this._getPrivacyProtectionScript(authIndex);
            await context.addInitScript(privacyScript);
            this.logger.debug(`[Context#${authIndex}] Init script injected, opening page...`);

            page = await context.newPage();
            this.logger.debug(`[Context#${authIndex}] Page opened.`);

            const shouldProbeNetwork = url =>
                typeof url === "string" &&
                (url.includes("generativelanguage.googleapis.com") ||
                    url.includes("alkalimakersuite-pa.clients6.google.com"));

            page.on("request", request => {
                const url = request.url();
                if (!shouldProbeNetwork(url)) return;
                if (url.includes("MakerSuiteService/ProxyUnaryCall") && this.connectionRegistry) {
                    this.connectionRegistry.markNextUnissuedRequestForAuthIssued(authIndex);
                    const ctx = this.contexts.get(authIndex);
                    if (ctx) ctx.dispatchReady = true;
                }
                this.logger.info(`[NetProbe#${authIndex}] REQUEST ${request.method()} ${url}`);
            });

            page.on("response", response => {
                const url = response.url();
                if (!shouldProbeNetwork(url)) return;
                this.logger.info(
                    `[NetProbe#${authIndex}] RESPONSE ${response.status()} ${response.request().method()} ${url}`
                );
            });

            page.on("requestfailed", request => {
                const url = request.url();
                if (!shouldProbeNetwork(url)) return;
                const failureText = request.failure()?.errorText || "unknown";
                this.logger.info(`[NetProbe#${authIndex}] FAILED ${request.method()} ${url} error=${failureText}`);
            });

            // NOTE: Removed bringToFront/window.focus/humanMovement wakeup step.
            // In headless Camoufox it has no effect, and under parallel batch
            // initialization it deadlocks: only the last-called page acquires
            // focus while the earlier ones hang indefinitely before goto.

            page.on("console", msg => {
                const msgText = msg.text();
                if (msgText.includes("Content-Security-Policy")) {
                    return;
                }

                // Filter out WebGL not supported warning (expected when GPU is disabled for privacy)
                if (msgText.includes("WebGL not supported")) {
                    return;
                }

                if (msgText.includes("downloadable font: download failed")) {
                    return;
                }

                if (msgText.includes("[ProxyClient]")) {
                    const forwardedMessage = `[Context#${authIndex}] ${msgText.replace("[ProxyClient] ", "")}`;
                    const browserLogType = msg.type();

                    if (browserLogType === "debug") {
                        this.logger.debug(forwardedMessage);
                    } else if (browserLogType === "warning") {
                        this.logger.warn(forwardedMessage);
                    } else if (browserLogType === "error") {
                        this.logger.error(forwardedMessage);
                    } else {
                        this.logger.info(forwardedMessage);
                    }
                } else if (msg.type() === "error") {
                    this.logger.error(`[Context#${authIndex} Page Error] ${msgText}`);
                }

                // Check for WebSocket initialization status
                if (msgText.includes("Connection successful")) {
                    this.logger.debug(
                        `[Context#${authIndex}] ✅ Detected successful WebSocket connection from browser`
                    );
                    const s = this._wsInitState.get(authIndex);
                    if (s) s.success = true;
                } else if (msgText.includes("WebSocket initialization failed")) {
                    this.logger.warn(
                        `[Context#${authIndex}] ❌ Detected WebSocket initialization failure from browser`
                    );
                    const s = this._wsInitState.get(authIndex);
                    if (s) s.failed = true;
                }
            });

            // Check abort status before navigation (most time-consuming part)
            if (this.abortedContexts.has(authIndex) || (isBackgroundTask && this._backgroundPreloadAbort)) {
                throw new ContextAbortedError(authIndex, "marked for deletion");
            }

            await this._navigateAndWakeUpPage(page, `[Context#${authIndex}]`);

            // Check abort status after navigation
            if (this.abortedContexts.has(authIndex) || (isBackgroundTask && this._backgroundPreloadAbort)) {
                throw new ContextAbortedError(authIndex, "marked for deletion");
            }

            await this._checkPageStatusAndErrors(page, `[Context#${authIndex}]`, authIndex);

            if (this.abortedContexts.has(authIndex) || (isBackgroundTask && this._backgroundPreloadAbort)) {
                throw new ContextAbortedError(authIndex, "marked for deletion");
            }

            await this._handlePopups(page, `[Context#${authIndex}]`);

            if (this.abortedContexts.has(authIndex) || (isBackgroundTask && this._backgroundPreloadAbort)) {
                throw new ContextAbortedError(authIndex, "marked for deletion");
            }

            // Try to click Launch button if it exists (not a popup, but a page button)
            await this._tryClickLaunchButton(page, `[Context#${authIndex}]`);

            // Wait for WebSocket initialization (no retry)
            // Check if initialization already succeeded (console listener may have detected it)
            const wsState = this._wsInitState.get(authIndex);
            if (wsState && wsState.success) {
                this.logger.info(`[Context#${authIndex}] ✅ WebSocket already initialized, skipping wait`);
            } else {
                // Wait for WebSocket initialization (60 second timeout)
                // This will throw an abort error if the context is aborted during wait
                const initSuccess = await this._waitForWebSocketInit(
                    page,
                    `[Context#${authIndex}]`,
                    60000,
                    authIndex,
                    isBackgroundTask
                );

                if (!initSuccess) {
                    throw new Error("WebSocket initialization failed. Please check browser logs and page errors.");
                }
            }

            // DEEP ACTIVATE: every pool context must be "launched" before
            // it can process in-page fetches under multi-hot dispatch.
            // Pre-loaded contexts that never became current via a
            // FastSwitch do NOT have their AI Studio Launch button
            // clicked, so their session stays on the welcome / rocket
            // modal — the in-page script receives WS messages fine
            // but its fetch() never hits the wire. This helper polls
            // for the Launch button via page.evaluate and clicks it
            // synthetically (no focus required), so every context
            // enters the pool in a launched-and-ready state.
            await this._deepActivateContext(page, authIndex);

            // Final check before adding to contexts map
            if (this.abortedContexts.has(authIndex) || (isBackgroundTask && this._backgroundPreloadAbort)) {
                throw new ContextAbortedError(authIndex, "marked for deletion");
            }

            // Save to contexts map - with atomic abort check to prevent race condition
            // between the check above and actually adding to the map
            if (!this.abortedContexts.has(authIndex) && !(isBackgroundTask && this._backgroundPreloadAbort)) {
                // Lightweight keep-alive ping loop. Preloaded contexts that
                // are NEVER activated (sitting idle in the pool) fall into
                // a deeply-throttled state where fetch() dispatched via WS
                // later gets stalled for tens of seconds. Calling a trivial
                // page.evaluate every 500ms keeps the page's JS task queue
                // active and makes subsequent WS-triggered fetches respond
                // promptly. Cleared in closeContext.
                const keepAliveInterval = setInterval(() => {
                    if (page.isClosed?.()) return;
                    page.evaluate(() => 1).catch(() => {});
                }, 500);
                keepAliveInterval.unref?.();

                this.contexts.set(authIndex, {
                    context,
                    dispatchReady: false,
                    healthMonitorInterval: null,
                    keepAliveInterval,
                    page,
                });
                // NOTE: we intentionally do NOT fire a rebalance here.
                // The startup `preloadContextPool` loop and the runtime
                // `_preloadBackgroundContexts` path both add contexts
                // this way; a rebalance-on-init hook would race with
                // them. Deferred-size retirements are re-swept by the
                // stalled-rebalance timer scheduled at the bottom of
                // rebalanceContextPool instead.
            } else {
                throw new ContextAbortedError(authIndex, "marked for deletion");
            }

            // Update auth file
            await this._updateAuthFile(authIndex);

            return { context, page };
        } catch (error) {
            // Check if this is an abort error
            const isAbortError = isContextAbortedError(error);
            // Check if this is an auth expiration error
            const isAuthExpired = isAuthExpiredError(error);

            if (isAbortError) {
                this.logger.info(`[Browser] Context #${authIndex} initialization aborted as requested.`);
            } else if (isAuthExpired) {
                this.logger.error(
                    `❌ [Browser] Context initialization failed for index ${authIndex} (auth expired), cleaning up...`
                );
                // Auth is already marked as expired in _checkPageStatusAndErrors
            } else {
                this.logger.error(`❌ [Browser] Context initialization failed for index ${authIndex}, cleaning up...`);
            }

            // Save debug artifacts before closing the page (only for non-abort errors)
            if (!isAbortError && page && !page.isClosed()) {
                await this._saveDebugArtifacts("init_failed", authIndex, page);
            }

            // Remove from contexts map if it was added
            if (this.contexts.has(authIndex)) {
                this.contexts.delete(authIndex);
                this.logger.info(`[Browser] Removed failed context #${authIndex} from contexts map`);
            }

            // Close the per-account Firefox that we launched for this index.
            // There's no point keeping a dedicated Firefox around for a
            // context that failed to initialize.
            const failedBrowser = this.browsers.get(authIndex);
            if (failedBrowser) {
                this.browsers.delete(authIndex);
                failedBrowser.close().catch(() => {});
            }

            // Close context if it was created
            if (context) {
                try {
                    await context.close();
                    if (isAbortError) {
                        this.logger.info(`[Browser] Cleaned up aborted context for index ${authIndex}`);
                    } else {
                        this.logger.info(`[Browser] Cleaned up leaked context for index ${authIndex}`);
                    }
                } catch (closeError) {
                    this.logger.warn(`[Browser] Failed to close context during cleanup: ${closeError.message}`);
                }
            }
            throw error;
        } finally {
            // Ensure cleanup of tracking sets even if error is thrown
            this.initializingContexts.delete(authIndex);
            this.abortedContexts.delete(authIndex);
        }
    }

    async launchOrSwitchContext(authIndex) {
        if (typeof authIndex !== "number" || authIndex < 0) {
            this.logger.error(`[Browser] Invalid authIndex: ${authIndex}. authIndex must be >= 0.`);
            this._currentAuthIndex = -1;
            throw new Error(`Invalid authIndex: ${authIndex}. Must be >= 0.`);
        }

        // [Auth Switch] Fire-and-forget: save current auth data in the
        // background so rapid usage-based switches don't block on storageState.
        if (
            this._currentAuthIndex >= 0 &&
            this._currentAuthIndex !== authIndex &&
            this.contexts.has(this._currentAuthIndex)
        ) {
            const idxToSave = this._currentAuthIndex;
            this._updateAuthFile(idxToSave).catch(e => {
                this.logger.warn(`[Browser] Background auth save for #${idxToSave} failed: ${e.message}`);
            });
        }

        // Wait for background initialization if in progress
        if (this.initializingContexts.has(authIndex)) {
            this.logger.info(`[Browser] Context #${authIndex} is being initialized in background, waiting...`);
            await this._waitForContextInit(authIndex);
        }

        // Per-account Firefox launch happens lazily inside _initializeContext
        // via _ensureBrowserFor(authIndex). No upfront shared-browser check.

        // Check if context already exists (fast switch path)
        if (this.contexts.has(authIndex)) {
            this.logger.info("==================================================");
            this.logger.info(`⚡ [FastSwitch] Switching to pre-loaded context for account #${authIndex}`);
            this.logger.info("==================================================");

            // Validate that the page is still alive before switching
            const contextData = this.contexts.get(authIndex);
            if (!contextData || !contextData.page || contextData.page.isClosed()) {
                this.logger.warn(
                    `[FastSwitch] Page for account #${authIndex} is closed, cleaning up and re-initializing...`
                );
                // Clean up the dead context
                await this.closeContext(authIndex);
                // Fall through to slow path to re-initialize
            } else {
                // Quick auth status check without navigation
                try {
                    const currentUrl = contextData.page.url();
                    const pageTitle = await contextData.page.title();

                    // Check if redirected to login page (auth expired)
                    if (
                        currentUrl.includes("accounts.google.com") ||
                        currentUrl.includes("ServiceLogin") ||
                        pageTitle.includes("Sign in") ||
                        pageTitle.includes("登录")
                    ) {
                        this.logger.error(
                            `[FastSwitch] Account #${authIndex} auth expired (redirected to login), marking as expired...`
                        );
                        // Mark auth as expired
                        await this.authSource.markAsExpired(authIndex);
                        // Clean up the expired context
                        await this.closeContext(authIndex);
                        // Don't retry initialization - auth is expired, it will fail again
                        throw new AuthExpiredError();
                    } else {
                        // Page is alive and auth is valid, proceed with fast switch
                        // If this account was marked as expired but is now valid, restore it
                        if (this.authSource.isExpired(authIndex)) {
                            this.logger.info(
                                `[FastSwitch] Account #${authIndex} was expired but is now valid, restoring...`
                            );
                            await this.authSource.unmarkAsExpired(authIndex);
                            // Note: rebalanceContextPool() will be called by the caller (AuthSwitcher)
                        }

                        // Stop background tasks for old context
                        if (this._currentAuthIndex >= 0 && this.contexts.has(this._currentAuthIndex)) {
                            const oldContextData = this.contexts.get(this._currentAuthIndex);
                            if (oldContextData.healthMonitorInterval) {
                                clearInterval(oldContextData.healthMonitorInterval);
                                oldContextData.healthMonitorInterval = null;
                            }
                        }

                        // === DEBUG: capture pre-swap state ===
                        const oldIdxForDebug = this._currentAuthIndex;
                        const oldPendingBefore =
                            oldIdxForDebug >= 0 ? this._countPendingRequestsByAuth(oldIdxForDebug) : 0;
                        const newPendingBefore = this._countPendingRequestsByAuth(authIndex);
                        this.logger.info(
                            `🔍 [FastSwitch-DBG] Pre-swap: rolling off #${oldIdxForDebug} (pending=${oldPendingBefore}), activating #${authIndex} (pending=${newPendingBefore})`
                        );

                        // Switch to new context
                        this._activateContext(contextData.context, contextData.page, authIndex);

                        // Kick off a DEBUG monitor on the rolled-off page to
                        // trace whether its queued fetches actually run.
                        if (oldIdxForDebug >= 0 && oldIdxForDebug !== authIndex) {
                            this._monitorRolledOffContext(oldIdxForDebug, oldPendingBefore);
                        }

                        this.logger.info(`✅ [FastSwitch] Switched to account #${authIndex} instantly!`);
                        return;
                    }
                } catch (error) {
                    // Check if this is an auth expiration error
                    const isAuthExpired = isAuthExpiredError(error);

                    if (isAuthExpired) {
                        // Auth is expired, don't retry - just throw the error
                        throw error;
                    }

                    // For other errors, clean up and retry with slow path
                    this.logger.warn(
                        `[FastSwitch] Failed to check auth status for account #${authIndex}: ${error.message}, cleaning up and re-initializing...`
                    );
                    // Clean up the problematic context
                    await this.closeContext(authIndex);
                    // Fall through to slow path to re-initialize
                }
            }
        }

        // Context doesn't exist, need to initialize it (slow path)
        this.logger.info("==================================================");
        this.logger.info(`🔄 [Browser] Context for account #${authIndex} not found, initializing...`);
        this.logger.info("==================================================");

        // Check again if another caller started initializing while we were checking
        // This protects against race condition where multiple callers finish waiting
        // at the same time and all try to initialize the same context
        if (this.initializingContexts.has(authIndex)) {
            this.logger.info(`[Browser] Another caller is initializing context #${authIndex}, waiting...`);
            await this._waitForContextInit(authIndex);
            // After waiting, recursively call to use the fast path or retry
            return await this.launchOrSwitchContext(authIndex);
        }

        this.initializingContexts.add(authIndex);

        try {
            // Stop background tasks for old context
            if (this._currentAuthIndex >= 0 && this.contexts.has(this._currentAuthIndex)) {
                const oldContextData = this.contexts.get(this._currentAuthIndex);
                if (oldContextData.healthMonitorInterval) {
                    clearInterval(oldContextData.healthMonitorInterval);
                    oldContextData.healthMonitorInterval = null;
                }
            }

            // Initialize new context (isBackgroundTask=false for foreground initialization)
            const { context, page } = await this._initializeContext(authIndex, false);

            this._activateContext(context, page, authIndex);

            // If this account was marked as expired but login succeeded, restore it
            if (this.authSource.isExpired(authIndex)) {
                this.logger.info(`[Browser] Account #${authIndex} was expired but login succeeded, restoring...`);
                await this.authSource.unmarkAsExpired(authIndex);
                // Note: rebalanceContextPool() will be called by the caller (AuthSwitcher)
            }

            this.logger.info("==================================================");
            this.logger.info(`✅ [Browser] Account ${authIndex} context initialized successfully!`);
            this.logger.info("✅ [Browser] Browser client is ready.");
            this.logger.info("==================================================");
        } catch (error) {
            this.logger.error(`❌ [Browser] Account ${authIndex} context initialization failed: ${error.message}`);
            // Debug artifacts are already saved in _initializeContext's catch block

            // Clean up if HealthMonitor was started
            if (this.contexts.has(authIndex)) {
                const contextData = this.contexts.get(authIndex);
                if (contextData.healthMonitorInterval) {
                    clearInterval(contextData.healthMonitorInterval);
                    this.logger.info(`[Browser] Cleaned up health monitor for failed context #${authIndex}`);
                }
            }

            // Reset state
            this.context = null;
            this.page = null;
            this._currentAuthIndex = -1;
            // DO NOT reset backgroundWakeupRunning here!
            // If a BackgroundWakeup was running, it will detect this.page === null and exit on its own.
            // Resetting the flag here could allow a new instance to start before the old one exits.

            throw error;
        }
    }

    /**
     * Lightweight Reconnect: Refreshes the page and clicks "Continue to the app" button
     * without restarting the entire browser instance.
     *
     * This method is called when WebSocket connection is lost but the browser
     * process is still running. It's much faster than a full browser restart.
     *
     * @returns {Promise<boolean>} true if reconnect was successful, false otherwise
     */
    /**
     * Attempt lightweight reconnect for a specific account
     * Refreshes the page and re-injects the proxy script without restarting the browser
     * @param {number} authIndex - The auth index to reconnect (defaults to current if not specified)
     * @returns {Promise<boolean>} true if reconnect was successful, false otherwise
     */
    async attemptLightweightReconnect(authIndex = null) {
        // Use provided authIndex or fall back to current
        const targetAuthIndex = authIndex !== null ? authIndex : this._currentAuthIndex;

        if (targetAuthIndex < 0) {
            this.logger.warn("[Reconnect] Invalid auth index, cannot perform lightweight reconnect.");
            return false;
        }

        // Get the context data for this account
        const contextData = this.contexts.get(targetAuthIndex);
        if (!contextData || !contextData.page) {
            this.logger.warn(
                `[Reconnect] No context found for account #${targetAuthIndex}, cannot perform lightweight reconnect.`
            );
            return false;
        }

        const page = contextData.page;

        // Verify per-account browser and page are still valid
        if (!this.browsers.has(targetAuthIndex) || !page) {
            this.logger.warn(
                `[Reconnect] Browser or page is not available for account #${targetAuthIndex}, cannot perform lightweight reconnect.`
            );
            return false;
        }

        // Check if page is closed
        if (page.isClosed()) {
            this.logger.warn(
                `[Reconnect] Page is closed for account #${targetAuthIndex}, cannot perform lightweight reconnect.`
            );
            return false;
        }

        this.logger.info("==================================================");
        this.logger.info(`🔄 [Reconnect] Starting lightweight reconnect for account #${targetAuthIndex}...`);
        this.logger.info("==================================================");

        // Stop existing background tasks only if this is the current account
        const isCurrentAccount = targetAuthIndex === this._currentAuthIndex;
        if (isCurrentAccount) {
            const ctxData = this.contexts.get(targetAuthIndex);
            if (ctxData && ctxData.healthMonitorInterval) {
                clearInterval(ctxData.healthMonitorInterval);
                ctxData.healthMonitorInterval = null;
                this.logger.info("[Reconnect] Stopped background health monitor.");
            }
        }

        try {
            // Reset per-context WebSocket state to ensure clean state for reconnection
            this._wsInitState.set(targetAuthIndex, { failed: false, success: false });
            this.logger.info("[Reconnect] Reset WebSocket initialization state");

            // Navigate to target page and wake it up
            await this._navigateAndWakeUpPage(page, "[Reconnect]");

            // Check for cookie expiration, region restrictions, and other errors
            await this._checkPageStatusAndErrors(page, "[Reconnect]", targetAuthIndex);

            // Handle various popups (Cookie consent, Got it, Onboarding, etc.)
            await this._handlePopups(page, "[Reconnect]");

            // Try to click Launch button if it exists (not a popup, but a page button)
            await this._tryClickLaunchButton(page, "[Reconnect]");

            // Wait for WebSocket initialization (no retry)
            // Check if initialization already succeeded (console listener may have detected it)
            const wsState = this._wsInitState.get(targetAuthIndex);
            if (wsState && wsState.success) {
                this.logger.info(`[Reconnect] ✅ WebSocket already initialized, skipping wait`);
            } else {
                // Wait for WebSocket initialization (60 second timeout)
                const initSuccess = await this._waitForWebSocketInit(
                    page,
                    "[Reconnect]",
                    60000,
                    targetAuthIndex,
                    false
                );

                if (!initSuccess) {
                    this.logger.error("[Reconnect] WebSocket initialization failed.");
                    return false;
                }
            }

            this._sendActiveTrigger("[Reconnect]", page);

            // [Auth Update] Save the refreshed cookies to the auth file immediately
            await this._updateAuthFile(targetAuthIndex);

            this.logger.info("==================================================");
            this.logger.info(`✅ [Reconnect] Lightweight reconnect successful for account #${targetAuthIndex}!`);
            this.logger.info("==================================================");

            // Restart background tasks only if this is the current account
            if (isCurrentAccount) {
                // Reset BackgroundWakeup state after reconnect
                this.noButtonCount = 0;
                this._startHealthMonitor();
                this._startBackgroundWakeup(); // Internal check prevents duplicate instances
            }

            return true;
        } catch (error) {
            // Check if this is an abort error (context was deleted during reconnect)
            const isAbortError = isContextAbortedError(error);
            // Check if this is an auth expiration error
            const isAuthExpired = isAuthExpiredError(error);

            if (isAbortError) {
                this.logger.info(
                    `[Reconnect] Lightweight reconnect aborted for account #${targetAuthIndex} (context deleted)`
                );
                return false;
            }

            if (isAuthExpired) {
                this.logger.error(
                    `❌ [Reconnect] Lightweight reconnect failed for account #${targetAuthIndex} (auth expired)`
                );
                // Auth is already marked as expired in _checkPageStatusAndErrors
                await this._saveDebugArtifacts("reconnect_expired", targetAuthIndex, page);
                // Close context for expired auth - it needs full re-initialization
                await this.closeContext(targetAuthIndex);
                return false;
            }

            this.logger.error(
                `❌ [Reconnect] Lightweight reconnect failed for account #${targetAuthIndex}: ${error.message}`
            );
            await this._saveDebugArtifacts("reconnect_failed", targetAuthIndex, page);
            // Keep context for non-expired failures - next request will try to refresh the page
            return false;
        }
    }

    /**
     * Close a single context for a specific account
     *
     * IMPORTANT: When deleting an account, always call this method BEFORE closeConnectionByAuth()
     * Calling order: closeContext() -> closeConnectionByAuth()
     *
     * Reason: This method removes the context from the contexts Map BEFORE closing it.
     * When context.close() triggers WebSocket disconnect, ConnectionRegistry._removeConnection()
     * will check if the context still exists. If not found, it skips reconnect logic.
     * If you call closeConnectionByAuth() first, _removeConnection() will see the context
     * still exists and may trigger unnecessary reconnect attempts.
     *
     * @param {number} authIndex - The auth index to close
     * @param {object} [options]
     * @param {boolean} [options.graceful=false] - When true and the pool has room for multiple
     *     contexts (maxContexts !== 1), wait for any in-flight requests routed to this authIndex
     *     to drain before tearing down. After the drain budget elapses, fall through to the
     *     existing force-close path.
     * @param {number} [options.drainTimeoutMs] - Override the default drain timeout (ms).
     */
    async closeContext(authIndex, options = {}) {
        const { drainTimeoutMs, graceful = false } = options;

        // If context is being initialized in background, signal abort and wait
        if (this.initializingContexts.has(authIndex)) {
            this.logger.info(`[Browser] Context #${authIndex} is being initialized, marking for abort and waiting...`);
            this.abortedContexts.add(authIndex);
            await this._waitForContextInit(authIndex);
            this.abortedContexts.delete(authIndex);
        }

        // Graceful drain: only applies when the pool can hold more than one account
        // (maxContexts === 0 means unlimited, which also qualifies). Skip when the context
        // is no longer tracked here — nothing to drain.
        if (graceful && this.contexts.has(authIndex) && this.connectionRegistry && this.config.maxContexts !== 1) {
            const timeoutMs =
                typeof drainTimeoutMs === "number" && drainTimeoutMs >= 0
                    ? drainTimeoutMs
                    : this.config.contextCloseDrainTimeoutMs;
            if (timeoutMs > 0) {
                const inflight = this.connectionRegistry.getInflightCountForAuth(authIndex);
                if (inflight > 0) {
                    this.logger.info(
                        `[Browser] Graceful close for account #${authIndex}: waiting up to ${timeoutMs}ms for ${inflight} in-flight request(s) to finish...`
                    );
                    try {
                        const result = await this.connectionRegistry.waitForAuthDrain(authIndex, timeoutMs);
                        if (!result.drained) {
                            this.logger.warn(
                                `[Browser] Graceful close for account #${authIndex} timed out with ${result.remaining} in-flight request(s) remaining — falling back to force close.`
                            );
                        }
                    } catch (e) {
                        this.logger.warn(`[Browser] waitForAuthDrain failed for account #${authIndex}: ${e.message}`);
                    }
                }
            }
        }

        if (!this.contexts.has(authIndex)) {
            // Context doesn't exist (was never initialized or was aborted).
            // If there's a stray per-account Firefox for this index (e.g., launched
            // then aborted before context insertion), close it.
            const strayBrowser = this.browsers.get(authIndex);
            if (strayBrowser) {
                this.browsers.delete(authIndex);
                strayBrowser.close().catch(() => {});
            }
            return;
        }

        const contextData = this.contexts.get(authIndex);

        // Stop keep-alive ping for this context
        if (contextData.keepAliveInterval) {
            clearInterval(contextData.keepAliveInterval);
            contextData.keepAliveInterval = null;
        }

        // Stop health monitor for this context
        if (contextData.healthMonitorInterval) {
            clearInterval(contextData.healthMonitorInterval);
            contextData.healthMonitorInterval = null;
            this.logger.info(`[Browser] Stopped health monitor for context #${authIndex}`);
        }

        // Remove from contexts map FIRST, before closing context
        // This ensures that when context.close() triggers WebSocket disconnect,
        // _removeConnection will see that the context is already gone and skip reconnect logic
        this.contexts.delete(authIndex);

        // Proactively close message queues BEFORE closing context to prevent race condition
        // Race condition: context.close() triggers async WebSocket 'close' event, which calls _removeConnection()
        // But _removeConnection() executes later in event loop, after switchAccount() may have updated currentAuthIndex
        // So we must close queues NOW for ANY account being closed (current or not)
        if (this.connectionRegistry) {
            const isCurrent = this._currentAuthIndex === authIndex;
            this.logger.info(
                `[Browser] Proactively closing message queues for account #${authIndex}${isCurrent ? " (current account)" : ""}`
            );
            this.connectionRegistry.closeMessageQueuesForAuth(authIndex, "context_closed");
        }

        // If this was the current context, reset current references
        if (this._currentAuthIndex === authIndex) {
            this.context = null;
            this.page = null;
            this._currentAuthIndex = -1;
            // DO NOT reset backgroundWakeupRunning here!
            // If a BackgroundWakeup was running, it will detect this.page === null and exit on its own.
            // Resetting the flag here could allow a new instance to start before the old one exits.
            this.logger.debug(`[Browser] Current context was closed, currentAuthIndex reset to -1.`);
        }

        // Close the context AFTER removing from map
        try {
            if (contextData.context) {
                await contextData.context.close();
                this.logger.info(`[Browser] Context #${authIndex} closed.`);
            }
        } catch (e) {
            this.logger.warn(`[Browser] Error closing context #${authIndex}: ${e.message}`);
        }

        // Each account owns its own Firefox process. Tearing down this
        // context also closes its dedicated browser — there's nothing else
        // inside it that other accounts rely on.
        const accountBrowser = this.browsers.get(authIndex);
        if (accountBrowser) {
            this.browsers.delete(authIndex);
            try {
                const closePromise = accountBrowser.close();
                closePromise.catch(() => {});
                await Promise.race([closePromise, new Promise(resolve => setTimeout(resolve, 5000))]);
                this.logger.info(`[Browser#${authIndex}] Dedicated Firefox closed.`);
            } catch (e) {
                this.logger.warn(`[Browser#${authIndex}] Error closing Firefox: ${e.message}`);
            }
        }
    }

    /**
     * Helper: Clean up all context resources (health monitors, etc.)
     * Called when browser is closing or has disconnected
     */
    _cleanupAllContexts() {
        // Clean up all context health monitors
        for (const [authIndex, contextData] of this.contexts.entries()) {
            if (contextData.healthMonitorInterval) {
                clearInterval(contextData.healthMonitorInterval);
                contextData.healthMonitorInterval = null;
                this.logger.info(`[Browser] Stopped health monitor for context #${authIndex}`);
            }
        }

        // Reset all references
        this.contexts.clear();
        this.initializingContexts.clear();
        this.abortedContexts.clear();
        this._wsInitState.clear();
        this.context = null;
        this.page = null;
        this._currentAuthIndex = -1;
        // DO NOT reset backgroundWakeupRunning here!
        // If a BackgroundWakeup was running, it will detect this.page === null and exit on its own.
        // Resetting the flag here could allow a new instance to start before the old one exits.
    }

    /**
     * Unified cleanup method for the main browser instance.
     * Handles intervals, timeouts, and resetting all references.
     * In multi-context mode, cleans up all contexts.
     */
    async closeBrowser() {
        // Set flag to indicate intentional close - prevents ConnectionRegistry from
        // attempting lightweight reconnect when WebSocket disconnects
        this.isClosingIntentionally = true;

        // Legacy single health monitor cleanup (for backward compatibility)
        if (this.healthMonitorInterval) {
            clearInterval(this.healthMonitorInterval);
            this.healthMonitorInterval = null;
        }

        if (this.browsers.size > 0) {
            this.logger.debug(
                `[Browser] Closing ${this.browsers.size} per-account Firefox instance(s) and all contexts...`
            );
            // Close every per-account Firefox in parallel with a 5s race per browser.
            const closeTasks = [];
            for (const [idx, browser] of this.browsers.entries()) {
                const task = (async () => {
                    try {
                        const closePromise = browser.close();
                        closePromise.catch(() => {});
                        await Promise.race([closePromise, new Promise(resolve => setTimeout(resolve, 5000))]);
                    } catch (e) {
                        this.logger.warn(`[Browser#${idx}] Error during close (ignored): ${e.message}`);
                    }
                })();
                closeTasks.push(task);
            }
            await Promise.all(closeTasks);

            this.browsers.clear();
            this._cleanupAllContexts();
            this.logger.debug("[Browser] All per-account Firefox instances closed, currentAuthIndex reset to -1.");
        }

        // Reset flag after close is complete
        this.isClosingIntentionally = false;
    }

    async switchAccount(newAuthIndex) {
        this.logger.info(`🔄 [Browser] Starting account switch: from ${this._currentAuthIndex} to ${newAuthIndex}`);
        await this.launchOrSwitchContext(newAuthIndex);
        this.logger.info(`✅ [Browser] Account switch completed, current account: ${this._currentAuthIndex}`);
    }

    /**
     * Report whether the pool can accept a switch to `authIndex` without
     * evicting any existing context. Used by the capacity-aware switch flow:
     * if this returns { ok: false }, the UI should prompt the user to close
     * a session first instead of silently dropping one.
     * @param {number} authIndex
     * @returns {{ok:true}|{ok:false, reason:'pool_full', openContexts:number[]}}
     */
    canAccommodate(authIndex) {
        const maxContexts = this.config.maxContexts;
        if (!maxContexts || maxContexts === 0) return { ok: true };
        if (this.contexts.has(authIndex)) return { ok: true };
        if (this.initializingContexts.has(authIndex)) return { ok: true };
        const used = this.contexts.size + this.initializingContexts.size;
        if (used < maxContexts) return { ok: true };
        return {
            ok: false,
            openContexts: [...this.contexts.keys()],
            reason: "pool_full",
        };
    }

    /**
     * Close a single context without touching the rest of the pool. Used by
     * the WebUI "Close session" button. When called for the currently-active
     * account, transparently FastSwitches to another already-loaded context
     * first; if none exist the active pointer is reset to -1 and subsequent
     * requests will fail until the user switches manually.
     *
     * @param {number} authIndex
     * @returns {Promise<{closed:boolean, switchedTo:number|null}>}
     */
    async closeSpecificContext(authIndex) {
        if (!this.contexts.has(authIndex) && !this.initializingContexts.has(authIndex)) {
            return { closed: false, reason: "not_present", switchedTo: null };
        }

        let switchedTo = null;
        if (this._currentAuthIndex === authIndex) {
            // Pick any other ready context to FastSwitch into. Skip entries
            // whose page is already closed (stale map entries).
            for (const [idx, data] of this.contexts.entries()) {
                if (idx === authIndex) continue;
                if (!data || !data.page || data.page.isClosed?.()) continue;
                switchedTo = idx;
                break;
            }

            if (switchedTo !== null) {
                this.logger.info(
                    `[Browser] Closing active context #${authIndex}; FastSwitching to already-loaded account #${switchedTo} first.`
                );
                try {
                    await this.launchOrSwitchContext(switchedTo);
                } catch (e) {
                    this.logger.warn(
                        `[Browser] FastSwitch to #${switchedTo} while closing #${authIndex} failed: ${e.message}. Proceeding with close anyway.`
                    );
                    switchedTo = null;
                }
            } else {
                this.logger.warn(
                    `[Browser] Closing active context #${authIndex} but no other loaded context is available; currentAuthIndex will be reset to -1.`
                );
            }
        }

        // Notify the matching message queue so in-flight requests get a clean
        // error instead of hanging, then tear down the Playwright context.
        if (this.connectionRegistry) {
            try {
                this.connectionRegistry.closeConnectionByAuth(authIndex);
            } catch (e) {
                this.logger.debug(`[Browser] closeConnectionByAuth(${authIndex}) during manual close: ${e.message}`);
            }
        }
        await this.closeContext(authIndex, { graceful: true });

        if (this._currentAuthIndex === authIndex) {
            this._currentAuthIndex = -1;
        }

        return { closed: true, switchedTo };
    }

    /**
     * Called by WebUI account-related route handlers to reset the idle auto-
     * refill timer. When the user stops touching account state for 5 seconds,
     * we fill any free pool slots with the next rotation candidates.
     */
    notifyWebUIActivity() {
        this._scheduleIdleRefill();
    }

    /**
     * Usage-based auto-switch just rolled OFF `usedAuthIndex` (it hit the
     * SWITCH_ON_USES threshold). In a rolling-window pool we want to:
     *   1. Close that used context (gracefully, draining any in-flight work)
     *   2. Preload the next rotation candidate to fill the freed slot
     *
     * This runs fire-and-forget from the AuthSwitcher callsite so the switch
     * itself stays on the fast path. Steps 1 and 2 run sequentially in the
     * background: close → open-next, so the pool size briefly dips to
     * maxContexts-1 rather than ever exceeding maxContexts.
     */
    async evictUsedAccountAndPreloadNext(usedAuthIndex) {
        if (typeof usedAuthIndex !== "number" || usedAuthIndex < 0) return;
        if (usedAuthIndex === this._currentAuthIndex) {
            this.logger.warn(`[ContextPool] Refusing to evict #${usedAuthIndex}: it is still the active account.`);
            return;
        }
        if (!this.contexts.has(usedAuthIndex) && !this.initializingContexts.has(usedAuthIndex)) {
            this.logger.debug(`[ContextPool] Rolling evict: #${usedAuthIndex} not in pool, nothing to close.`);
        } else {
            // Pre-drain grace window: under rapid usage-based switches the
            // same brief moment where we call closeContext would land while
            // the just-rolled-off account still has in-flight fetches that
            // simply need a few seconds to complete on the browser side. If
            // we enter graceful-drain (and closeContext) immediately those
            // fetches can get starved (observed: 10/22 requests timed out
            // at exactly 60s). Waiting ~5s lets most legitimate in-flight
            // requests finish naturally before drain even starts.
            const preDrainDelayMs = 5000;
            this.logger.info(
                `[ContextPool] Rolling evict: #${usedAuthIndex} scheduled for close after ${preDrainDelayMs}ms grace window (then drain up to ${this.config.contextCloseDrainTimeoutMs}ms), preloading next rotation candidate afterward...`
            );
            await new Promise(resolve => setTimeout(resolve, preDrainDelayMs));

            // Short-circuit: the account may have been revived as current
            // again (a request-triggered switch back) during the grace
            // window; skip the close in that case.
            if (usedAuthIndex === this._currentAuthIndex) {
                this.logger.info(
                    `[ContextPool] Rolling evict: #${usedAuthIndex} became active again during grace window, skipping close.`
                );
                return;
            }

            // IMPORTANT: do NOT call closeConnectionByAuth() here. That
            // closes every MessageQueue bound to this authIndex with
            // reason "reconnect_cleanup", which aborts any in-flight
            // dequeue() and fails the request. Instead, let
            // closeContext(graceful:true) drain the in-flight requests
            // first — only after the drain window closes does it tear
            // down the Playwright context, and the WS disconnect it
            // triggers then closes any still-open queues via the
            // normal grace-period path.
            try {
                await this.closeContext(usedAuthIndex, { graceful: true });
            } catch (e) {
                this.logger.warn(`[ContextPool] Rolling evict close failed for #${usedAuthIndex}: ${e.message}`);
            }
        }

        // Now preload the next rotation candidate that isn't already in the pool.
        const maxContexts = this.config.maxContexts;
        if (!maxContexts || maxContexts === 0) return;
        const used = this.contexts.size + this.initializingContexts.size;
        if (used >= maxContexts) {
            this.logger.debug(`[ContextPool] Rolling preload skipped: pool already at ${used}/${maxContexts}.`);
            return;
        }

        const rotation = this.authSource.getRotationIndices();
        if (!rotation || rotation.length === 0) return;

        const currentCanonical =
            this._currentAuthIndex >= 0 ? this.authSource.getCanonicalIndex(this._currentAuthIndex) : null;
        const startPos = currentCanonical !== null ? Math.max(rotation.indexOf(currentCanonical), 0) : 0;
        const activeCanonical = new Set(
            [...this.contexts.keys(), ...this.initializingContexts].map(
                idx => this.authSource.getCanonicalIndex(idx) ?? idx
            )
        );

        const candidates = [];
        for (let i = 1; i <= rotation.length; i++) {
            const idx = rotation[(startPos + i) % rotation.length];
            if (!activeCanonical.has(idx)) candidates.push(idx);
        }
        if (candidates.length === 0) return;

        this.logger.info(
            `[ContextPool] Rolling preload: loading next candidate #${candidates[0]} into slot freed by #${usedAuthIndex}.`
        );
        this._preloadBackgroundContexts(candidates, maxContexts);
    }

    _scheduleIdleRefill() {
        if (this._idleRefillTimer) {
            clearTimeout(this._idleRefillTimer);
            this._idleRefillTimer = null;
        }
        const maxContexts = this.config.maxContexts;
        if (!maxContexts || maxContexts === 0) return;
        this._idleRefillTimer = setTimeout(() => {
            this._idleRefillTimer = null;
            this._runIdleRefill().catch(err => {
                this.logger.warn(`[ContextPool] Idle refill failed: ${err.message}`);
            });
        }, this._idleRefillDelayMs);
        if (this._idleRefillTimer.unref) this._idleRefillTimer.unref();
    }

    async _runIdleRefill() {
        const maxContexts = this.config.maxContexts;
        if (!maxContexts || maxContexts === 0) return;

        const used = this.contexts.size + this.initializingContexts.size;
        if (used >= maxContexts) {
            this.logger.debug(`[ContextPool] Idle refill skipped: pool already at ${used}/${maxContexts}.`);
            return;
        }

        if (this._backgroundPreloadTask) {
            this.logger.debug("[ContextPool] Idle refill skipped: background preload already running.");
            return;
        }

        const rotation = this.authSource.getRotationIndices();
        if (!rotation || rotation.length === 0) return;

        const currentCanonical =
            this._currentAuthIndex >= 0 ? this.authSource.getCanonicalIndex(this._currentAuthIndex) : null;
        const startPos = currentCanonical !== null ? Math.max(rotation.indexOf(currentCanonical), 0) : 0;

        // Build an ordered candidate list starting AFTER the current account,
        // wrapping around, skipping anything already present/initializing.
        const activeCanonical = new Set(
            [...this.contexts.keys(), ...this.initializingContexts].map(
                idx => this.authSource.getCanonicalIndex(idx) ?? idx
            )
        );
        const candidates = [];
        for (let i = 1; i <= rotation.length; i++) {
            const idx = rotation[(startPos + i) % rotation.length];
            if (!activeCanonical.has(idx)) candidates.push(idx);
        }
        if (candidates.length === 0) return;

        this.logger.info(
            `[ContextPool] Idle refill: pool at ${used}/${maxContexts}, preloading next candidates [${candidates.slice(0, maxContexts - used).join(", ")}]...`
        );
        this._preloadBackgroundContexts(candidates, maxContexts);
    }
}

module.exports = BrowserManager;
