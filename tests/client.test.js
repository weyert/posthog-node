const { version } = require('../package')
const pify = require('pify')
const createNetworkMocking = require('./assets/networkMock')
const delay = require('delay')

// Mock requests
const { MockAgent, setGlobalDispatcher } = require('undici')
const mockAgent = new MockAgent()
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

describe('Client', () => {
    beforeAll(() => {
        createNetworkMocking(mockPool)
    })

    afterAll(() => {
        mockPool.close()
    })

    afterEach(() => {
        jest.useRealTimers()
    })

    it('expose a constructor', () => {
        expect(typeof PostHog).toBe('function')
    })

    it('requires a api key', () => {
        expect(() => new PostHog()).toThrowError("You must pass your PostHog project's api key.")
    })

    it('create a queue', () => {
        const client = createClient()
        expect(client.queue).toEqual([])
        client.shutdown()
    })

    it('default options', () => {
        const client = new PostHog('key')
        jest.spyOn(client, 'flush').mockImplementation(() => {})

        expect(client.apiKey).toBe('key')
        expect(client.host).toBe('https://app.posthog.com')
        expect(client.flushAt).toBe(20)
        expect(client.flushInterval).toBe(10000)
        client.shutdown()
    })

    it('keep the flushAt option above zero', () => {
        const client = createClient({ flushAt: 0 })
        jest.spyOn(client, 'flush').mockImplementation(() => {})

        expect(client.flushAt).toBe(1)
        client.shutdown()
    })

    describe('Enqueue', () => {
        it('enqueue - add a message to the queue', () => {
            const client = createClient()
            jest.spyOn(client, 'flush').mockImplementation(() => {})

            const timestamp = new Date()
            client.enqueue('type', { timestamp }, noop)
            expect(client.queue).toHaveLength(1)
            const item = client.queue.pop()
            expect(item).toEqual({
                message: {
                    timestamp,
                    library: 'posthog-node',
                    library_version: version,
                    type: 'type',
                },
                callback: noop,
            })
            client.shutdown()
        })

        it(`enqueue - don't modify the original message`, () => {
            const client = createClient()
            jest.spyOn(client, 'flush').mockImplementation(() => {})

            const message = { event: 'test' }
            client.enqueue('type', message)
            expect(message).toEqual({ event: 'test' })
            client.shutdown()
        })

        it('enqueue - flush on first message', () => {
            const client = createClient({ flushAt: 2 })
            client.flushed = false
            jest.spyOn(client, 'flush')

            client.enqueue('type', {})
            expect(client.flush).toHaveBeenCalledTimes(1)

            client.enqueue('type', {})
            expect(client.flush).toHaveBeenCalledTimes(1)

            client.enqueue('type', {})
            expect(client.flush).toHaveBeenCalledTimes(2)

            client.shutdown()
        })

        it('enqueue - flush the queue if it hits the max length', () => {
            const client = createClient({
                flushAt: 1,
                flushInterval: null,
            })

            jest.spyOn(client, 'flush')

            client.enqueue('type', {})

            expect(client.flush).toHaveBeenCalledTimes(1)
        })

        it('enqueue - flush after a period of time', async () => {
            jest.useFakeTimers('modern')

            const client = createClient({ flushInterval: 10 })

            jest.spyOn(client, 'flush')
            expect(client.flush).toHaveBeenCalledTimes(0)

            client.enqueue('type', {})

            jest.runOnlyPendingTimers()

            expect(client.flush).toHaveBeenCalledTimes(1)
        }, 5000)

        it(`enqueue - don't reset an existing timer`, async () => {
            jest.useFakeTimers('modern')

            const client = createClient({ flushInterval: 10 })
            jest.spyOn(client, 'flush')

            client.enqueue('type', {})
            jest.advanceTimersByTime(5)
            expect(client.flush).not.toHaveBeenCalled()
            client.enqueue('type', {})
            jest.advanceTimersByTime(5)

            expect(client.flush).toHaveBeenCalledTimes(1)
        })

        it('enqueue - skip when client is disabled', async () => {
            const client = createClient({ enable: false })
            jest.spyOn(client, 'flush')

            const callback = jest.fn()
            client.enqueue('type', {}, callback)
            expect(callback).toHaveBeenCalledTimes(0)

            await delay(5)

            expect(callback).toHaveBeenCalledTimes(1)
            expect(client.flush).not.toHaveBeenCalled()
        })
    })

    describe('Flush', () => {
        it(`flush - don't fail when queue is empty`, async () => {
            const client = createClient()
            await expect(() => client.flush()).not.toThrowError()
        })

        it(`flush - send messages`, async () => {
            const client = createClient({ flushAt: 2 })
            const callbackA = jest.fn()
            const callbackB = jest.fn()
            const callbackC = jest.fn()

            client.queue = [
                {
                    message: 'a',
                    callback: callbackA,
                },
                {
                    message: 'b',
                    callback: callbackB,
                },
                {
                    message: 'c',
                    callback: callbackC,
                },
            ]

            const data = await client.flush()
            expect(Object.keys(data)).toStrictEqual(['api_key', 'batch'])
            expect(data.batch).toStrictEqual(['a', 'b'])
            expect(callbackA).toHaveBeenCalled()
            expect(callbackB).toHaveBeenCalled()
            expect(callbackC).not.toHaveBeenCalled()
        })

        it(`flush - respond with an error`, async () => {
            const client = createClient()
            const callback = jest.fn()

            client.queue = [
                {
                    message: 'error',
                    callback,
                },
            ]

            await expect(async () => {
                await client.flush()
            }).rejects.toThrowError('Error')
        })

        it(`flush - time out if configured`, async () => {
            const client = createClient({ timeout: 500, retryCount: 1 })
            const callback = jest.fn()
            client.queue = [
                {
                    message: 'timeout',
                    callback,
                },
            ]

            await expect(async () => {
                await client.flush()
            }).rejects.toThrowError('Network request timeout')

            expect(callback).toHaveBeenCalled()
        }, 10000)

        it(`flush - skip when client is disabled`, async () => {
            const client = createClient({ enable: false })
            const callback = jest.fn()

            client.queue = [
                {
                    message: 'test',
                    callback,
                },
            ]

            await client.flush()

            expect(callback).not.toHaveBeenCalled()
        })
    })

    describe(`Identify`, () => {
        it(`enqueue a message`, () => {
            const client = createClient()
            jest.spyOn(client, 'enqueue')

            const message = { distinctId: 'id', properties: { fish: 'swim in the sea' } }
            client.identify(message, noop)

            const apiMessage = {
                distinctId: 'id',
                $set: { fish: 'swim in the sea' },
                event: '$identify',
                properties: { $lib: 'posthog-node', $lib_version: version },
            }

            expect(client.enqueue).toHaveBeenCalledWith('identify', apiMessage, noop)
        })
        it(`require a distinctId or alias`, () => {
            const client = createClient()
            jest.spyOn(client, 'enqueue')

            expect(() => client.identify()).toThrowError({ message: 'You must pass a message object.' })
            expect(() => client.identify({})).toThrowError({ message: 'You must pass a "distinctId".' })
            expect(() => client.identify({ distinctId: 'id' })).not.toThrowError()
        })
    })

    describe('Capture', () => {
        it('enqueue a message', () => {
            const client = createClient()
            jest.spyOn(client, 'enqueue')

            const message = { distinctId: '1', event: 'event' }

            const apiMessage = {
                distinctId: '1',
                properties: { $lib: 'posthog-node', $lib_version: version },
                event: 'event',
            }

            client.capture(message, noop)

            expect(client.enqueue).toHaveBeenCalledTimes(1)
            expect(client.enqueue).toHaveBeenCalledWith('capture', apiMessage, noop)
        })
        it('enqueue a message with groups', () => {
            const client = createClient()
            jest.spyOn(client, 'enqueue')

            const message = {
                distinctId: '1',
                event: 'event',
                groups: { company: 'id 5' },
            }

            const apiMessage = {
                distinctId: '1',
                properties: {
                    $groups: { company: 'id 5' },
                    $lib: 'posthog-node',
                    $lib_version: version,
                },
                event: 'event',
            }

            client.capture(message, noop)

            expect(client.enqueue).toHaveBeenCalledTimes(1)
            expect(client.enqueue).toHaveBeenCalledWith('capture', apiMessage, noop)
        })

        it('enqueue - require event and either distinctId or alias', () => {
            const client = createClient()
            jest.spyOn(client, 'enqueue')

            expect(() => client.capture()).toThrowError({ message: 'You must pass a message object.' })
            expect(() => client.capture({})).toThrowError({ message: 'You must pass a "distinctId".' })
            expect(() => client.capture({ distinctId: 'id' })).toThrowError({ message: 'You must pass an "event".' })
            expect(() => client.capture({ distinctId: 'id', event: 'event' })).not.toThrowError()
        })
    })

    describe('alias', () => {
        it('enqueue a message', () => {
            const client = createClient()
            jest.spyOn(client, 'enqueue')

            const message = { distinctId: 'id', alias: 'id' }

            const apiMessage = {
                properties: { distinct_id: 'id', alias: 'id', $lib: 'posthog-node', $lib_version: version },
                event: '$create_alias',
                distinct_id: 'id',
            }

            client.alias(message, noop)

            expect(client.enqueue).toHaveBeenCalledTimes(1)
            expect(client.enqueue).toHaveBeenCalledWith('alias', apiMessage, noop)
        })

        it('require alias and distinctId', () => {
            const client = createClient()
            jest.spyOn(client, 'enqueue')

            expect(() => client.alias()).toThrowError({ message: 'You must pass a message object.' })
            expect(() => client.alias({})).toThrowError({ message: 'You must pass a "distinctId".' })
            expect(() => client.alias({ distinctId: 'id' })).toThrowError({ message: 'You must pass a "alias".' })
            expect(() => client.alias({ distinctId: 'id', alias: 'id' })).not.toThrowError()
        })
    })

    it('enqueue a message', () => {
        const client = createClient()
        jest.spyOn(client, 'enqueue')

        const message = { distinctId: 'id', alias: 'id' }

        const apiMessage = {
            properties: { distinct_id: 'id', alias: 'id', $lib: 'posthog-node', $lib_version: version },
            event: '$create_alias',
            distinct_id: 'id',
        }

        client.alias(message, noop)

        expect(client.enqueue).toHaveBeenCalledTimes(1)
        expect(client.enqueue).toHaveBeenCalledWith('alias', apiMessage, noop)
    })

    it('require alias and distinctId', () => {
        const client = createClient()
        jest.spyOn(client, 'enqueue')

        expect(() => client.alias()).toThrowError({ message: 'You must pass a message object.' })
        expect(() => client.alias({})).toThrowError({ message: 'You must pass a "distinctId".' })
        expect(() => client.alias({ distinctId: 'id' })).toThrowError({ message: 'You must pass a "alias".' })
        expect(() => client.alias({ distinctId: 'id', alias: 'id' })).not.toThrowError()
    })

    describe('groupIdentify', () => {
        it('enqueue a message', () => {
            const client = createClient()
            jest.spyOn(client, 'enqueue')

            const message = {
                groupType: 'company',
                groupKey: 'id:5',
                properties: { foo: 'bar' },
            }

            const apiMessage = {
                properties: {
                    $group_type: 'company',
                    $group_key: 'id:5',
                    $group_set: { foo: 'bar' },
                    $lib: 'posthog-node',
                    $lib_version: version,
                },
                event: '$groupidentify',
                distinctId: '$company_id:5',
            }

            client.groupIdentify(message, noop)

            expect(client.enqueue).toHaveBeenCalledTimes(1)
            expect(client.enqueue).toHaveBeenCalledWith('capture', apiMessage, noop)
        })

        it('require groupType and groupKey', () => {
            const client = createClient()
            jest.spyOn(client, 'enqueue')

            expect(() => client.groupIdentify()).toThrowError({ message: 'You must pass a message object.' })
            expect(() => client.groupIdentify({})).toThrowError({ message: 'You must pass a "groupType".' })
            expect(() => client.groupIdentify({ groupType: 'company' })).toThrowError({
                message: 'You must pass a "groupKey".',
            })
            expect(() => client.groupIdentify({ groupType: 'company', groupKey: 'id:5' })).not.toThrowError()
        })
    })

    it('allows messages > 32 kB', () => {
        const client = createClient()

        const event = {
            distinctId: 1,
            envent: 'event',
            properties: {},
        }

        for (var i = 0; i < 10000; i++) {
            event.properties[i] = 'a'
        }

        expect(() => client.capture(event, noop)).not.toThrowError()
    })
})
