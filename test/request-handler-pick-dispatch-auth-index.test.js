const test = require("node:test");
const assert = require("node:assert/strict");

const RequestHandler = require("../src/core/RequestHandler");

function createLogger() {
    const noop = () => {};
    return {
        debug: noop,
        error: noop,
        info: noop,
        warn: noop,
    };
}

function createHandler({ browserManager, connectionRegistry }) {
    const serverSystem = {
        usageStatsService: null,
        webRoutes: {
            authRoutes: {
                getClientIP() {
                    return "127.0.0.1";
                },
            },
        },
    };
    const config = { maxRetries: 1, retryDelay: 1 };
    const authSource = { accountNameMap: new Map() };
    return new RequestHandler(serverSystem, connectionRegistry, createLogger(), browserManager, config, authSource);
}

test("pickDispatchAuthIndex should ignore contexts that are not ready for dispatch", () => {
    const browserManager = {
        contexts: new Map([
            [13, { dispatchReady: true, page: { isClosed: () => false } }],
            [14, { dispatchReady: false, page: { isClosed: () => false } }],
            [15, { dispatchReady: false, page: { isClosed: () => false } }],
            [16, { dispatchReady: false, page: { isClosed: () => false } }],
        ]),
        currentAuthIndex: 14,
    };
    const connectionRegistry = {
        getInflightCountForAuth(authIndex) {
            return authIndex === 13 ? 0 : 0;
        },
    };
    const handler = createHandler({ browserManager, connectionRegistry });

    assert.equal(handler._pickDispatchAuthIndex(), 13);
});
