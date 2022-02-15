const undici = require('undici')
const setupRetry = require('./fetchRetry')
const setupTimeout = require('./fetchTimeout')

/**
 * Decorate the `fetch`-function with timeout and rety functionality
 */
module.exports = setupRetry(setupTimeout(undici.fetch))
