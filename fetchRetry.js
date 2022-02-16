const retry = require('async-retry')
const isRetryAllowed = require('is-retry-allowed')
const debug = require('debug')('fetch-retry')

// retry settings
const MIN_TIMEOUT = 10
const MAX_RETRIES = 5
const MAX_RETRY_AFTER = 20
const FACTOR = 6

/**
 * @private
 * Returns whether the error is a client error or not
 */
function isClientError(err) {
    if (!err) return false
    return err.code === 'ERR_UNESCAPED_CHARACTERS' || err.message === 'Request path contains unescaped characters'
}

/**
 * Decorate the given `fetch`-function with retry functionality
 * @param fetch the Fetch implementation
 */
function setup(fetch) {
    // Check if the automatically back exists, if not fail hard
    if (!fetch) {
        throw new Error('Missing fetch implementaiton')
    }

    async function fetchRetry(url, opts = {}) {
        const retryOpts = Object.assign(
            {
                // timeouts will be [10, 60, 360, 2160, 12960]
                // (before randomization is added)
                minTimeout: MIN_TIMEOUT,
                retries: MAX_RETRIES,
                factor: FACTOR,
                maxRetryAfter: MAX_RETRY_AFTER,
            },
            opts.retry
        )

        if (opts.onRetry) {
            retryOpts.onRetry = (error) => {
                opts.onRetry(error, opts)
                if (opts.retry && opts.retry.onRetry) {
                    opts.retry.onRetry(error)
                }
            }
        }

        try {
            return await retry(async (bail, attempt) => {
                const { method = 'GET' } = opts
                try {
                    // this will be retried
                    const res = await fetch(url, opts)
                    debug('status %d', res.status)

                    if ((res.status >= 500 && res.status < 600) || res.status === 429) {
                        // NOTE: doesn't support http-date format
                        const retryAfter = parseInt(res.headers.get('retry-after'), 10)
                        if (retryAfter) {
                            if (retryAfter > retryOpts.maxRetryAfter) {
                                return res
                            } else {
                                await new Promise((r) => setTimeout(r, retryAfter * 1e3).unref())
                            }
                        }

                        throw new ResponseError(res)
                    } else {
                        return res
                    }
                } catch (err) {
                    if (err.type === 'aborted') {
                        return bail(err)
                    }

                    const clientError = isClientError(err)
                    const isRetry = !clientError && attempt <= retryOpts.retries
                    debug(`${method} ${url} error (status = ${err.status}). ${isRetry ? 'retrying' : ''}`, err)
                    if (clientError) {
                        return bail(err)
                    }

                    throw err
                }
            }, retryOpts)
        } catch (err) {
            if (err instanceof ResponseError) {
                return err.response
            }

            throw err
        }
    }

    return fetchRetry
}

module.exports = exports = setup

/**
 * ResponseError
 */
class ResponseError extends Error {
    constructor(response) {
        super(response.statusText)

        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, ResponseError)
        }

        this.name = this.constructor.name
        this.response = response

        this.code = this.status = this.statusCode = response.status
        this.url = response.url
    }
}

/**
 * Returns whether the given error is a network-related error
 * @param {*} error the error to check against
 * @returns boolean
 */
function isNetworkError(error) {
    return (
        !error.response &&
        Boolean(error.code) && // Prevents retrying cancelled requests
        error.code !== 'ECONNABORTED' && // Prevents retrying timed out requests
        isRetryAllowed(error)
    ) // Prevents retrying unsafe errors
}

exports.ResponseError = ResponseError
exports.isNetworkError = isNetworkError
