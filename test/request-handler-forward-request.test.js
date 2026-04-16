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

test("forwardRequest should prepare a non-current dispatch target before sending the proxy request", async () => {
    const callOrder = [];
    const connection = {
        send(payload) {
            callOrder.push({ type: "send", payload: JSON.parse(payload) });
        },
    };
    const connectionRegistry = {
        getAuthIndexForRequest() {
            return 15;
        },
        getConnectionByAuth(authIndex) {
            assert.equal(authIndex, 15);
            return connection;
        },
    };
    const browserManager = {
        currentAuthIndex: 13,
        async prepareContextForDispatch(authIndex) {
            callOrder.push({ authIndex, type: "prepare" });
        },
    };
    const handler = createHandler({ browserManager, connectionRegistry });

    await handler._forwardRequest({
        method: "POST",
        path: "/v1beta/models/gemini-3-flash-preview:generateContent",
        request_attempt_id: "attempt-1",
        request_id: "req-1",
    });

    assert.deepEqual(callOrder.map(entry => entry.type), ["prepare", "send"]);
    assert.equal(callOrder[0].authIndex, 15);
    assert.equal(callOrder[1].payload.request_id, "req-1");
});
