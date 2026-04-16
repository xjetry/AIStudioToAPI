const test = require("node:test");
const assert = require("node:assert/strict");

const BrowserManager = require("../src/core/BrowserManager");

function createLogger() {
    const noop = () => {};
    return {
        debug: noop,
        error: noop,
        info: noop,
        warn: noop,
    };
}

function createBrowserManager() {
    const config = {
        maxContexts: 4,
        rollingPreloadCount: 0,
        startupParallelInitLimit: 3,
    };
    const authSource = {
        getCanonicalIndex(idx) {
            return idx;
        },
    };
    return new BrowserManager(createLogger(), config, authSource);
}

test("background preload follow-up should not block on an in-flight preload task", async () => {
    const browserManager = createBrowserManager();
    const taskResolvers = [];
    const taskCalls = [];

    browserManager._executePreloadTask = (indices, maxPoolSize) => {
        taskCalls.push({ indices: [...indices], maxPoolSize });
        return new Promise(resolve => {
            taskResolvers.push(resolve);
        });
    };

    await browserManager._preloadBackgroundContexts([17], 0);
    assert.equal(taskCalls.length, 1);
    assert.deepEqual(taskCalls[0], { indices: [17], maxPoolSize: 0 });

    const secondCall = browserManager._preloadBackgroundContexts([18], 0).then(() => "resolved");
    const secondCallState = await Promise.race([
        secondCall,
        new Promise(resolve => setTimeout(() => resolve("timeout"), 50)),
    ]);

    assert.notEqual(secondCallState, "timeout");
    assert.equal(taskCalls.length, 1);

    taskResolvers.shift()();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(taskCalls.length, 2);
    assert.deepEqual(taskCalls[1], { indices: [18], maxPoolSize: 0 });

    taskResolvers.shift()();
    await new Promise(resolve => setImmediate(resolve));
});
