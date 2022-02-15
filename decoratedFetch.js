const undici = require('undici')
const setupRetry = require('./fetchRetry')
const setupTimeout = require('./fetchTimeout')

/**
 *
 */
module.exports = setupRetry(setupTimeout(undici.fetch))
