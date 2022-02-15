const { version } = require('../package')
const pify = require('pify')
const createNetworkMocking = require('./assets/networkMock')
const delay = require('delay')
const decoratedFetch = require('../decoratedFetch')

// Mock requests
const { MockAgent, Agent, setGlobalDispatcher } = require('undici')

const agent = new Agent({
    keepAliveTimeout: 10,
    keepAliveMaxTimeout: 10,
})
const mockAgent = new MockAgent({
    agent
})
setGlobalDispatcher(mockAgent)
mockAgent.disableNetConnect()

const port = 6042
const mockPool = mockAgent.get(`http://localhost:${port}`)

const PostHog = require('../index')

/**
 *
 */
const createClient = (options) => {
    options = Object.assign(
        {
            host: `http://localhost:${port}`,
        },
        options
    )

    const client = new PostHog('key', options)
    client.flush = pify(client.flush.bind(client))
    client.flushed = true
    return client
}

const noop = () => {}

/**
 *
 * @param {*} expectedData
 * @returns
 */
function getRequestConfig(expectedData) {
    const config = {
        method: 'POST',
    }
    if (expectedData) {
        config.body = JSON.stringify(expectedData)
    }

    return [expect.stringContaining('http://localhost:6042/decide'), expect.objectContaining(config)]
}

//
jest.mock('../decoratedFetch')

//
describe('featureFlags', () => {
    beforeAll(() => {
        createNetworkMocking(mockPool)
    })

    beforeEach(() => {
        decoratedFetch.mockRestore()
        decoratedFetch.mockImplementation(jest.requireActual('../decoratedFetch'))
    })

    afterAll(() => {
        mockPool.close()
    })

    it('requires personalApiKey', async () => {
        const client = createClient()

        await expect(async () => {
            await client.isFeatureEnabled('simpleFlag', 'some id')
        }).rejects.toThrowError('You have to specify the option personalApiKey to use feature flags.')

        client.shutdown()
    })

    it('require key, distinctId, defaultValue', async () => {
        const client = createClient({ personalApiKey: 'my very secret key' })

        await expect(async () => {
            await client.isFeatureEnabled()
        }).rejects.toThrowError('You must pass a "key".')
        await expect(async () => {
            await client.isFeatureEnabled(null)
        }).rejects.toThrowError('You must pass a "key".')
        await expect(async () => {
            await client.isFeatureEnabled('my-flag')
        }).rejects.toThrowError('You must pass a "distinctId".')
        await expect(async () => {
            await client.isFeatureEnabled('my-flag', 'some-id', 'default-value')
        }).rejects.toThrowError('"defaultResult" must be a boolean.')
        await expect(async () => {
            await client.isFeatureEnabled('my-flag', 'some-id', false, 'foobar')
        }).rejects.toThrowError('You must pass an object for "groups".')

        client.shutdown()
    })

    it('isSimpleFlag', async () => {
        const client = createClient({ personalApiKey: 'my very secret key' })

        const isEnabled = await client.isFeatureEnabled('simpleFlag', 'some id')

        expect(isEnabled).toBe(true)

        expect(decoratedFetch).toHaveBeenCalledWith(
            expect.stringContaining('http://localhost:6042/api/feature_flag/?token=key'),
            expect.objectContaining({
                body: undefined,
                method: 'GET',
            })
        )
    })

    it('complex flags', async () => {
        const client = createClient({ personalApiKey: 'my very secret key' })
        const expectedEnabledFlag = await client.isFeatureEnabled('enabled-flag', 'some id')
        const expectedDisabledFlag = await client.isFeatureEnabled('disabled-flag', 'some id')
        expect(expectedEnabledFlag).toBe(true)
        expect(expectedDisabledFlag).toBe(false)

        const lastCall = decoratedFetch.mock.calls.length - 1
        const lastCallInfo = decoratedFetch.mock.calls[decoratedFetch.mock.calls.length - 1]
        expect(lastCallInfo[0]).toBe('http://localhost:6042/decide/')
        expect(lastCallInfo[1]).toEqual(
            expect.objectContaining({
                method: 'POST',
            })
        )

        client.shutdown()
    })

    it('group analytics', async () => {
        const client = createClient({ personalApiKey: 'my very secret key' })

        const expectedEnabledFlag = await client.isFeatureEnabled('enabled-flag', 'some id', false, { company: 'id:5' })

        expect(expectedEnabledFlag).toBe(true)
        expect(decoratedFetch).toHaveBeenLastCalledWith(
            ...getRequestConfig({ groups: { company: 'id:5' }, distinct_id: 'some id', token: 'key' })
        )

        client.shutdown()
    })

    it('default override', async () => {
        const client = createClient({ personalApiKey: 'my very secret key' })

        let flagEnabled = await client.isFeatureEnabled('i-dont-exist', 'some id')
        expect(flagEnabled).toBe(false)

        flagEnabled = await client.isFeatureEnabled('i-dont-exist', 'some id', true)
        expect(flagEnabled).toBe(true)

        client.shutdown()
    })

    it('simple flag calculation', async () => {
        const client = createClient({ personalApiKey: 'my very secret key' })

        // This tests that the hashing + mathematical operations across libs are consistent
        let flagEnabled = client.featureFlagsPoller._isSimpleFlagEnabled({
            key: 'a',
            distinctId: 'b',
            rolloutPercentage: 42,
        })
        expect(flagEnabled).toBe(true)

        flagEnabled = client.featureFlagsPoller._isSimpleFlagEnabled({
            key: 'a',
            distinctId: 'b',
            rolloutPercentage: 40,
        })
        expect(flagEnabled).toBe(false)

        client.shutdown()
    })

    it('handles errors when flag reloads', async () => {
        const client = createClient({ personalApiKey: 'my very secret key for error' })

        expect(() => client.featureFlagsPoller.loadFeatureFlags(true)).not.toThrowError()
    })

    it('ignores logging errors when posthog:node is not set', () => {
        process.env.DEBUG = undefined

        const loggerSpy = jest.spyOn(console, 'log')

        const client = createClient({ personalApiKey: 'my very secret key for error' })

        expect(() => client.featureFlagsPoller.loadFeatureFlags(true)).not.toThrowError()

        expect(loggerSpy).not.toHaveBeenCalled()

        client.shutdown()
        loggerSpy.mockRestore()
    })
})
