const isRetryAllowed = require('is-retry-allowed')
const debug = require('debug')('fetch-timeout')

const DEFAULT_TIMEOUT = 0

/**
 * Decorate the given `fetch`-function with timeout functionality
 * @param fetch the Fetch implementation
 */
function setup(fetch) {
    // Check if the automatically back exists, if not fail hard
    if (!fetch) {
        throw new Error('Missing fetch implementaiton')
    }

    function fetchTimeout(url, options) {
        const requestTimeout = options.timeout || 0
        const shouldTimeout = requestTimeout > 0

        return new Promise((resolve, reject) => {
            let timeoutId = undefined
            if (shouldTimeout) {
                setTimeout(() => {
                    reject(new TypeError('Network request timeout'))
                }, requestTimeout)
            }

            fetch(url, options)
                .then((response) => {
                    if (timeoutId) {
                        clearTimeout(timeoutId)
                        timeoutId.unref()
                    }
                    resolve(response)
                })
                .catch((err) => {
                    if (timeoutId) {
                        clearTimeout(timeoutId)
                        timeoutId.unref()
                    }
                    reject(err)
                })
        })
    }

    return fetchTimeout
}

module.exports = exports = setup
