'use strict';

function operationError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function withTimeout(operation, timeoutMs = 30000, label = 'Operation', { signal } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
        return Promise.reject(new RangeError('A positive operation timeout is required.'));
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            if (error) reject(error);
            else resolve(value);
        };
        const abort = () => finish(operationError(label + ' was cancelled.', 'ABORT_ERR'));
        if (signal?.aborted) return abort();
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => finish(operationError(label + ' timed out.', 'ETIMEDOUT')), timeoutMs);
        try {
            const returned = typeof operation === 'function' ? operation(finish) : operation;
            if (returned && typeof returned.then === 'function') {
                returned.then(value => finish(null, value), finish);
            } else if (typeof operation !== 'function') {
                finish(null, returned);
            }
        } catch (error) {
            finish(error);
        }
    });
}

function sleep(ms, { signal } = {}) {
    if (!Number.isSafeInteger(ms) || ms < 0 || ms > 2147483647) {
        return Promise.reject(new RangeError('A valid delay is required.'));
    }
    return new Promise((resolve, reject) => {
        let timer;
        const abort = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            reject(operationError('Delay was cancelled.', 'ABORT_ERR'));
        };
        if (signal?.aborted) return abort();
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => {
            signal?.removeEventListener('abort', abort);
            resolve();
        }, ms);
    });
}

module.exports = { withTimeout, sleep };
