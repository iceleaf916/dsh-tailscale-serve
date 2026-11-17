/**
 * Browser-session cookie acquisition.
 *
 * DSH binds every API request and WebSocket to a signed cookie whose audience
 * is the Host authority that minted it. `tailscale serve` does not preserve
 * the loopback Host, so the bridge mints its own cookie for the loopback
 * authority via the process launch-token exchange (`connection.authenticatedUrl`)
 * and replays it on every forwarded request.
 *
 * This path only uses public Host APIs and the local HTTP listener; it works
 * with or without any other plugin installed.
 */
import http from 'node:http'
import https from 'node:https'

const AUTH_COOKIE = /^dsh-auth-[A-Za-z0-9_-]+=/
const DEFAULT_REFRESH_MS = 6 * 60 * 60 * 1000

const message = (error) => (error instanceof Error ? error.message : String(error))

function getHeaders(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http
    const request = client.request(
      {
        hostname: url.hostname,
        port: url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { accept: 'text/html,application/json;q=0.9,*/*;q=0.1', 'user-agent': 'dsh-tailscale-serve' },
        agent: false,
        timeout: timeoutMs,
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => {
          if (chunks.length < 64) chunks.push(chunk)
        })
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers }))
        response.on('error', reject)
      },
    )
    request.on('timeout', () => request.destroy(new Error('the DSH token exchange timed out')))
    request.on('error', reject)
    request.end()
  })
}

/**
 * Create the cookie minter used by the bridge.
 * @param {{connection:{authenticatedUrl(base:string):string}, origin:string, logger?:{warn(...args:unknown[]):void}, refreshMs?:number}} options
 */
export function createMinter({ connection, origin, logger, refreshMs = DEFAULT_REFRESH_MS }) {
  let cookie = ''
  let pending
  let timer

  const mint = async () => {
    // Primary path: the launch-token exchange on `connection.authenticatedUrl`.
    // Fallback path: a bare loopback GET, which is what loopback auto-login
    // helpers answer. Whichever path sets a `dsh-auth-*` cookie wins; both are
    // loopback-authority cookies, so the bridge can replay either.
    const candidates = [connection.authenticatedUrl(origin), origin]
    let lastStatus = 0
    let lastError
    for (const candidate of candidates) {
      let url
      try {
        url = new URL(candidate)
      } catch (error) {
        lastError = error
        continue
      }
      let response
      try {
        response = await getHeaders(url, 10000)
      } catch (error) {
        lastError = error
        continue
      }
      lastStatus = response.status
      const raw = response.headers['set-cookie']
      const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
      const pair = list.map((value) => String(value).trim()).find((value) => AUTH_COOKIE.test(value))
      if (pair !== undefined) {
        const end = pair.indexOf(';')
        return end === -1 ? pair : pair.slice(0, end)
      }
    }
    throw new Error(
      `the DSH loopback listener did not provide a dsh-auth cookie` +
        (lastError === undefined ? ` (last HTTP ${String(lastStatus)})` : `: ${message(lastError)}`),
    )
  }

  const ensure = (force = false) => {
    if (!force && cookie !== '') return Promise.resolve(cookie)
    if (pending === undefined) {
      pending = mint()
        .then((value) => {
          cookie = value
          return value
        })
        .catch((error) => {
          logger?.warn('tailscale-serve: could not obtain a DSH session cookie: %s', message(error))
          throw error
        })
        .finally(() => {
          pending = undefined
        })
    }
    return pending
  }

  const start = () => {
    if (timer !== undefined) return
    timer = setInterval(() => {
      void ensure(true).catch(() => {})
    }, refreshMs)
    timer.unref?.()
  }

  const stop = () => {
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }

  return {
    ensure,
    start,
    stop,
    get value() {
      return cookie
    },
  }
}
