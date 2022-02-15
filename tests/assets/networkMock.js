const { mockSimpleFlagResponse } = require('./mockFlagsResponse')

/**
 *
 * @param {MockPool} mockPool
 */
function createNetworkMocking(mockPool) {
    mockPool
        .intercept({
            path: (path) => path.startsWith('/api/feature_flag'),
            method: 'GET',
            headers: {
                authorization: 'Bearer my very secret key for error',
            },
        })
        .defaultReplyHeaders({ 'Content-Type': 'application/json' })
        .reply(502, JSON.stringify({ error: { message: 'internal server error' } }))
        .persist()

    mockPool
        .intercept({
            path: (path) => path.startsWith('/api/feature_flag'),
            method: 'GET',
            headers: {
                authorization: 'Bearer my very secret key',
            },
        })
        .reply(200, JSON.stringify(mockSimpleFlagResponse))
        .persist()

    mockPool
        .intercept({
            path: (path) => path.startsWith('/batch'),
            method: 'POST',
            headers: (headers) => {
                const userAgent = headers['user-agent']
                if (userAgent !== `posthog-node/${version}`) {
                    return true
                }
                return false
            },
        })
        .defaultReplyHeaders({ 'Content-Type': 'application/json' })
        .reply(400, JSON.stringify({ error: { message: 'invalid user-agent' } }))
        .persist()

    mockPool
        .intercept({
            path: (path) => path.startsWith('/batch'),
            method: 'POST',
            body: (body) => {
                try {
                    const json = JSON.parse(body)
                    const { api_key: apiKey } = json
                    if (!apiKey) {
                        return true
                    }
                    return false
                } catch (err) {
                    return false
                }
            },
        })
        .defaultReplyHeaders({ 'Content-Type': 'application/json' })
        .reply(400, JSON.stringify({ error: { message: 'missing api-key' } }))
        .persist()

    mockPool
        .intercept({
            path: (path) => path.startsWith('/batch'),
            method: 'POST',
            body: (body) => {
                try {
                    const json = JSON.parse(body)
                    const { batch } = json

                    if (batch[0] === 'error') {
                        return true
                    }
                    return false
                } catch (err) {
                    return false
                }
            },
        })
        .defaultReplyHeaders({ 'Content-Type': 'application/json' })
        .reply(400, JSON.stringify({ error: { message: 'error' } }))
        .persist()

    mockPool
        .intercept({
            path: (path) => path.startsWith('/batch'),
            method: 'POST',
            body: (body) => {
                try {
                    const json = JSON.parse(body)
                    const { batch } = json

                    if (batch[0] === 'timeout') {
                        return true
                    }
                    return false
                } catch (err) {
                    return false
                }
            },
        })
        .defaultReplyHeaders({ 'Content-Type': 'application/json' })
        .reply(500, 'Timeout')
        .delay(5000)
        .persist()

    mockPool
        .intercept({
            path: (path) => path.startsWith('/batch'),
            method: 'POST',
        })
        .defaultReplyHeaders({ 'Content-Type': 'application/json' })
        .reply(200, JSON.stringify({}))
        .persist()

    mockPool
        .intercept({
            path: (path) => path.startsWith('/decide'),
            method: 'POST',
        })
        .defaultReplyHeaders({ 'Content-Type': 'application/json' })
        .reply(
            200,
            JSON.stringify({
                featureFlags: ['enabled-flag'],
            })
        )
        .persist()
}

module.exports = createNetworkMocking
