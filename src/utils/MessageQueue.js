/**
 * File: src/utils/MessageQueue.js
 * Description: Asynchronous message queue for managing request/response communication between server and browser client
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

const { EventEmitter } = require("events");

/**
 * Custom error class for queue closed errors
 */
class QueueClosedError extends Error {
    constructor(message = "Queue is closed", reason = "unknown") {
        super(message);
        this.name = "QueueClosedError";
        this.code = "QUEUE_CLOSED";
        this.reason = reason;
    }
}

/**
 * Custom error class for queue timeout errors
 */
class QueueTimeoutError extends Error {
    constructor(message = "Queue timeout") {
        super(message);
        this.name = "QueueTimeoutError";
        this.code = "QUEUE_TIMEOUT";
    }
}

/**
 * Message Queue Module
 * Responsible for managing asynchronous message enqueue and dequeue
 */
class MessageQueue extends EventEmitter {
    constructor(timeoutMs = 300000) {
        super();
        this.messages = [];
        this.waitingResolvers = [];
        this.defaultTimeout = timeoutMs;
        this.closed = false;
        this.closeReason = null;
    }

    enqueue(message) {
        if (this.closed) return;
        if (this.waitingResolvers.length > 0) {
            const resolver = this.waitingResolvers.shift();
            // Check if resolver is still valid (not timed out). `valid` decouples
            // the "still waiting" state from the presence of a timeout timer, so
            // infinite-wait resolvers (no timeoutId) are still recognized as valid.
            if (resolver && resolver.valid) {
                resolver.valid = false;
                if (resolver.timeoutId) clearTimeout(resolver.timeoutId);
                resolver.resolve(message);
            } else {
                // Resolver already timed out, push message to queue instead
                this.messages.push(message);
            }
        } else {
            this.messages.push(message);
        }
    }

    /**
     * Wait for the next message.
     * @param {number} [timeoutMs] - Wait deadline in milliseconds. Pass `0` or a
     *     negative / non-finite value to wait indefinitely (cleanup still happens
     *     via `close()`).
     */
    async dequeue(timeoutMs = this.defaultTimeout) {
        if (this.closed) {
            const reason = this.closeReason || "unknown";
            throw new QueueClosedError(`Queue is closed (reason: ${reason})`, reason);
        }
        return new Promise((resolve, reject) => {
            // Check if there are already queued messages
            if (this.messages.length > 0) {
                resolve(this.messages.shift());
                return;
            }

            // Create resolver; `valid` flag gates both the timeout and enqueue paths.
            const resolver = { reject, resolve, timeoutId: null, valid: true };

            const hasFiniteTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
            if (hasFiniteTimeout) {
                resolver.timeoutId = setTimeout(() => {
                    if (!resolver.valid) return;
                    resolver.valid = false;
                    resolver.timeoutId = null;
                    const index = this.waitingResolvers.indexOf(resolver);
                    if (index !== -1) {
                        this.waitingResolvers.splice(index, 1);
                    }
                    reject(new QueueTimeoutError());
                }, timeoutMs);
            }

            // Now push to waitingResolvers - resolver is fully initialized
            this.waitingResolvers.push(resolver);

            // CRITICAL: Check again if messages arrived during initialization
            // This handles the race where enqueue() was called between the initial
            // check and push
            if (this.messages.length > 0 && this.waitingResolvers[0] === resolver) {
                // We're still the first waiter, consume the message
                this.waitingResolvers.shift();
                resolver.valid = false;
                if (resolver.timeoutId) clearTimeout(resolver.timeoutId);
                resolve(this.messages.shift());
            }
        });
    }

    close(reason = "unknown") {
        this.closed = true;
        this.closeReason = reason;
        this.waitingResolvers.forEach(resolver => {
            if (!resolver.valid) return;
            resolver.valid = false;
            if (resolver.timeoutId) clearTimeout(resolver.timeoutId);
            resolver.reject(new QueueClosedError(`Queue is closed (reason: ${reason})`, reason));
        });
        this.waitingResolvers = [];
        this.messages = [];
    }
}

module.exports = MessageQueue;
module.exports.QueueClosedError = QueueClosedError;
module.exports.QueueTimeoutError = QueueTimeoutError;
