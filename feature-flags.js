const debug = require('debug')('posthog-node')
const crypto = require('crypto')
const ms = require('ms')
const version = require('./package.json').version
const { Headers } = require('undici')

const LONG_SCALE = 0xfffffffffffffff

/**
 * @private
 * Decorate the default fetch with timeout and retry functionality
 */
const decoratedFetch = require('./decoratedFetch')

class ClientError extends Error {
    constructor(message, extra) {
        super()
        Error.captureStackTrace(this, this.constructor)
        this.name = 'ClientError'
        this.message = message
        if (extra) {
            this.extra = extra
        }
    }
}

class FeatureFlagsPoller {
    constructor({ pollingInterval, personalApiKey, projectApiKey, timeout, host, featureFlagCalledCallback }) {
        this.pollingInterval = pollingInterval
        this.personalApiKey = personalApiKey
        this.featureFlags = []
        this.loadedSuccessfullyOnce = false
        this.timeout = timeout
        this.projectApiKey = projectApiKey
        this.featureFlagCalledCallback = featureFlagCalledCallback
        this.host = host
        this.poller = null

        void this.loadFeatureFlags()
    }

    async isFeatureEnabled(key, distinctId, defaultResult = false, groups = {}) {
        await this.loadFeatureFlags()
        // console.log(`loadedSuccessfullyOnce:`, this.loadedSuccessfullyOnce)

        if (!this.loadedSuccessfullyOnce) {
            return defaultResult
        }

        let featureFlag = null

        for (const flag of this.featureFlags) {
            if (key === flag.key) {
                featureFlag = flag
                break
            }
        }
        if (!featureFlag) {
            return defaultResult
        }

        let isFlagEnabledResponse

        if (featureFlag.is_simple_flag) {
            isFlagEnabledResponse = this._isSimpleFlagEnabled({
                key,
                distinctId,
                rolloutPercentage: featureFlag.rollout_percentage,
            })
        } else {
            // console.log(`isFeatureEnabled() featureFlag:`, featureFlag)

            try {
                const requestBody = { groups, distinct_id: distinctId }
                // console.log(`isFeatureEnabled() requestBody:`, requestBody)

                const stringifiedRequestBody = JSON.stringify(requestBody)

                const res = await this._request({
                    path: 'decide',
                    method: 'POST',
                    body: requestBody,
                })
                // console.log(`isFeatureEnabled() response:`, res)
                // console.log(`isFeatureEnabled() isResponseOK:`, res.ok, res.status)

                if (res.ok) {
                    const json = await res.json()
                    // console.log(`isFeatureEnabled() json:`, json)

                    isFlagEnabledResponse = json.featureFlags.indexOf(key) >= 0
                } else {
                    // console.log(`isFeatureEnabled() failed response`)

                    isFlagEnabledResponse = defaultResult
                }
            } catch (err) {
                // console.log(`isFeatureEnabled() err:`, err)

                isFlagEnabledResponse = defaultResult
            }
        }

        this.featureFlagCalledCallback(key, distinctId, isFlagEnabledResponse)
        return isFlagEnabledResponse
    }

    async loadFeatureFlags(forceReload = false) {
        if (!this.loadedSuccessfullyOnce || forceReload) {
            await this._loadFeatureFlags()
        }
    }

    /* istanbul ignore next */
    async _loadFeatureFlags() {
        if (this.poller) {
            clearTimeout(this.poller)
            this.poller.unref()
            this.poller = null
        }

        this.poller = setTimeout(() => this._loadFeatureFlags(), this.pollingInterval).unref()

        try {
            const requestResponse = await this._request({ path: 'api/feature_flag', usePersonalApiKey: true })
            if (requestResponse && requestResponse.status === 401) {
                throw new ClientError(
                    `Your personalApiKey is invalid. Are you sure you're not using your Project API key? More information: https://posthog.com/docs/api/overview`
                )
            }

            const json = await requestResponse.json()

            if (requestResponse.ok) {
                this.featureFlags = json.results.concat().filter((flag) => flag.active)

                this.loadedSuccessfullyOnce = true
            } else {
                debug(requestResponse.status, requestResponse.statusText, json)
                throw new Error('Failed to fetch feature flags')
            }
        } catch (err) {
            // console.log(`Error occurred:`, err)

            // if an error that is not an instance of ClientError is thrown
            // we silently ignore the error when reloading feature flags
            if (err instanceof ClientError) {
                throw err
            }
        }
    }

    // sha1('a.b') should equal '69f6642c9d71b463485b4faf4e989dc3fe77a8c6'
    // integerRepresentationOfHashSubset / LONG_SCALE for sha1('a.b') should equal 0.4139158829615955
    _isSimpleFlagEnabled({ key, distinctId, rolloutPercentage }) {
        if (!rolloutPercentage) {
            // console.info(`FeatureFlagPoller._isSimpleFlagEnabled() Missing rolloutPercentage`)
            return true
        }

        const sha1Hash = crypto.createHash('sha1')
        sha1Hash.update(`${key}.${distinctId}`)
        const integerRepresentationOfHashSubset = parseInt(sha1Hash.digest('hex').slice(0, 15), 16)

        return integerRepresentationOfHashSubset / LONG_SCALE <= rolloutPercentage / 100
    }

    /* istanbul ignore next */
    async _request({ path, method = 'GET', usePersonalApiKey = false, headers = {}, body = {} }) {
        let url = `${this.host}/${path}/`

        if (usePersonalApiKey) {
            headers = { ...headers, Authorization: `Bearer ${this.personalApiKey}` }
            url = url + `?token=${this.projectApiKey}`
        } else {
            body = { ...body, token: this.projectApiKey }
        }

        if (typeof window === 'undefined') {
            headers['user-agent'] = `posthog-node/${version}`
        }

        const requestBody = ['GET', 'HEAD'].includes(method) ? undefined : JSON.stringify(body)

        const requestHeaders = new Headers(headers)
        requestHeaders.set('Content-Type', 'application/json')
        requestHeaders.set('Content-Length', Buffer.byteLength(requestBody ?? ''))

        const req = {
            method: method,
            headers: requestHeaders,
            body: requestBody,
        }

        let res
        try {
            // console.log(`decoratedFetch:`, decoratedFetch)
            res = await decoratedFetch(url, {
                ...req,
                retry: {
                    retries: this.retryCount,
                    factor: 2,
                    randomize: true,
                    onRetry: this._isErrorRetryable,
                },
                timeout: typeof this.timeout === 'string' ? ms(this.timeout) : this.timeout,
            })
            // console.log(`response:`, res)

            if (!res.ok) {
                throw new Error('Failed to fetch request')
            }
        } catch (err) {
            throw new Error(`Request to ${path} failed with error: ${err.message}`)
        }

        return res
    }

    stopPoller() {
        clearTimeout(this.poller)
        this.poller.unref()
        this.poller = null
    }
}

module.exports = {
    FeatureFlagsPoller,
}
