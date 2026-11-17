/**
 * Local HTTP/WebSocket bridge between `tailscale serve` and this DSH host.
 *
 * Why a bridge is needed at all: `tailscale serve` forwards the tailnet Host
 * (`host.tailnet.ts.net`) to its target, while DSH's Host/Origin fence
 * only accepts the loopback authority and its session cookie is bound to the
 * authority that minted it (`127.0.0.1:45557`). The bridge rewrites Host and
 * Origin to the loopback origin, replays a minted loopback cookie, and strips
 * any foreign `dsh-auth-*` cookie coming from a remote browser.
 *
 * The bridge listens on 127.0.0.1 with an ephemeral port and never on a
 * tailnet or LAN interface.
 */
import http from 'node:http'
import https from 'node:https'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
const AUTH_COOKIE = /^dsh-auth-[A-Za-z0-9_-]+=/
const RETRYABLE = new Set(['GET', 'HEAD', 'OPTIONS'])
const MAX_TAIL = 4000

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

function splitCookies(header) {
  if (Array.isArray(header)) return header.flatMap((value) => splitCookies(value))
  if (typeof header !== 'string' || header.trim() === '') return []
  return header
    .split(/;\s*/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

/** Replace any foreign DSH session cookie with the bridge's own minted pair. */
function withSession(header, session) {
  const kept = splitCookies(header).filter((pair) => !AUTH_COOKIE.test(pair))
  if (session !== undefined && session !== '') kept.push(session)
  return kept.length === 0 ? undefined : kept.join('; ')
}

function requestHeaders(request, target, session) {
  const headers = {}
  let originalHost = ''
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(name)) continue
    if (name === 'host') {
      originalHost = String(value)
      continue
    }
    headers[name] = value
  }
  headers.host = target.host
  headers['x-forwarded-host'] = originalHost
  headers['x-forwarded-proto'] = 'https'
  const forwardedFor = [headers['x-forwarded-for'], request.socket?.remoteAddress]
    .filter((value) => typeof value === 'string' && value !== '')
    .join(', ')
  if (forwardedFor !== '') headers['x-forwarded-for'] = forwardedFor
  if (typeof headers.origin === 'string' && headers.origin !== '') headers.origin = target.origin
  const cookie = withSession(request.headers.cookie, session)
  if (cookie === undefined) delete headers.cookie
  else headers.cookie = cookie
  return headers
}

function responseHeaders(response, publicOrigin) {
  const headers = {}
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(name)) continue
    if (name === 'set-cookie') {
      const list = Array.isArray(value) ? value : [value]
      const kept = list.filter((cookie) => !AUTH_COOKIE.test(String(cookie).split(';')[0].trim()))
      if (kept.length > 0) headers['set-cookie'] = kept
      continue
    }
    if (name === 'location' && typeof value === 'string' && publicOrigin !== '') {
      headers.location = value.replace(/^http:\/\/[^/]+/, publicOrigin)
      continue
    }
    headers[name] = value
  }
  return headers
}

/**
 * Start the loopback bridge.
 *
 * @param {{origin:string, minter:{value:string, ensure(force?:boolean):Promise<string>},
 *          publicOrigin():string, logger?:{warn(...args:unknown[]):void}}} options
 */
export async function createProxy({ origin, minter, publicOrigin, logger }) {
  const target = new URL(origin)
  const upstreamModule = target.protocol === 'https:' ? https : http
  const agent = new upstreamModule.Agent({ keepAlive: true, maxSockets: 256 })
  const sockets = new Set()
  let tail = ''
  let closed = false
  let closing

  const note = (text) => {
    tail = (tail + text).slice(-MAX_TAIL)
  }

  const failEarly = (res, error) => {
    const detail = messageOf(error)
    note(detail)
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(`dsh-tailscale-serve: cannot reach the DSH host at ${origin}\n${detail}\n`)
  }

  const attempt = (request, session) =>
    new Promise((resolve, reject) => {
      const upstream = upstreamModule.request({
        hostname: target.hostname,
        port: target.port === '' ? (target.protocol === 'https:' ? 443 : 80) : Number(target.port),
        method: request.method,
        path: request.url,
        headers: requestHeaders(request, target, session),
        agent,
      })
      upstream.on('response', (response) => {
        note(` HTTP ${String(response.statusCode ?? 0)} ${request.method ?? 'GET'} ${request.url ?? '/'}\n`)
        resolve(response)
      })
      upstream.on('error', reject)
      request.on('aborted', () => upstream.destroy())
      request.pipe(upstream)
    })

  // The bridge injects its own session cookie, so browsers must not be able to
  // drive it from a foreign page: when an Origin header is present it has to be
  // the public tailnet origin. Non-browser clients (curl, CLI) send no Origin.
  const rejectsForeignOrigin = (originHeader) =>
    originHeader !== undefined && publicOrigin() !== '' && String(originHeader) !== publicOrigin()

  async function handleRequest(request, res) {
    if (rejectsForeignOrigin(request.headers.origin)) {
      note(` cross-origin rejected: ${String(request.headers.origin)}\n`)
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('dsh-tailscale-serve: cross-origin request rejected\n')
      return
    }
    try {
      let session = minter.value
      if (session === '') session = await minter.ensure()
      let response = await attempt(request, session)
      if (response.statusCode === 401 && RETRYABLE.has(String(request.method ?? '').toUpperCase())) {
        response.resume()
        session = await minter.ensure(true).catch(() => minter.value)
        response = await attempt(request, session)
      }
      if (closed) {
        response.resume()
        return
      }
      res.writeHead(response.statusCode ?? 502, responseHeaders(response, publicOrigin()))
      response.on('error', (error) => {
        note(messageOf(error))
        res.destroy()
      })
      res.on('close', () => response.destroy())
      response.pipe(res)
    } catch (error) {
      failEarly(res, error)
    }
  }

  const attemptUpgrade = (request, session) =>
    new Promise((resolve, reject) => {
      const headers = requestHeaders(request, target, session)
      headers.connection = 'Upgrade'
      headers.upgrade = String(request.headers.upgrade ?? 'websocket')
      const upstream = upstreamModule.request({
        hostname: target.hostname,
        port: target.port === '' ? (target.protocol === 'https:' ? 443 : 80) : Number(target.port),
        method: request.method,
        path: request.url,
        headers,
        agent: false,
      })
      upstream.on('upgrade', (response, socket, head) => resolve({ response, socket, head, upstream }))
      upstream.on('response', (response) => resolve({ response, upstream }))
      upstream.on('error', reject)
      upstream.end()
    })

  const writeRaw = (socket, response) => {
    const lines = [`HTTP/1.1 ${String(response.statusCode ?? 502)} ${String(response.statusMessage ?? 'Bad Gateway')}`]
    for (const [name, value] of Object.entries(response.headers)) {
      if (value === undefined) continue
      if (Array.isArray(value)) for (const item of value) lines.push(`${name}: ${String(item)}`)
      else lines.push(`${name}: ${String(value)}`)
    }
    lines.push('', '')
    socket.on('close', () => response.destroy())
    socket.write(lines.join('\r\n'))
    response.pipe(socket)
  }

  async function handleUpgrade(request, clientSocket, head) {
    if (!clientSocket.writable) return
    if (rejectsForeignOrigin(request.headers.origin)) {
      note(` cross-origin upgrade rejected: ${String(request.headers.origin)}\n`)
      clientSocket.end(
        'HTTP/1.1 403 Forbidden\r\n' +
          'content-type: text/plain; charset=utf-8\r\n' +
          'connection: close\r\n' +
          '\r\n' +
          'dsh-tailscale-serve: cross-origin request rejected\n',
      )
      return
    }
    let session = minter.value
    for (let round = 0; round < 2; round += 1) {
      try {
        if (session === '') session = await minter.ensure(round > 0)
        const result = await attemptUpgrade(request, session)
        const status = result.response.statusCode ?? 0
        if (status === 101 && result.socket !== undefined) {
          const lines = ['HTTP/1.1 101 Switching Protocols']
          for (const [name, value] of Object.entries(result.response.headers)) {
            if (value === undefined) continue
            lines.push(`${name}: ${Array.isArray(value) ? String(value[0]) : String(value)}`)
          }
          lines.push('', '')
          clientSocket.write(lines.join('\r\n'))
          if (head !== undefined && head.length > 0) result.socket.write(head)
          if (result.head !== undefined && result.head.length > 0) clientSocket.write(result.head)
          result.socket.pipe(clientSocket)
          clientSocket.pipe(result.socket)
          const shutdown = () => {
            result.socket.destroy()
            clientSocket.destroy()
          }
          result.socket.on('error', shutdown)
          clientSocket.on('error', shutdown)
          // A half-closed tunnel must not keep the other side (or the upstream
          // keep-alive pool) alive: mirror close events in both directions.
          result.socket.on('close', () => clientSocket.destroy())
          clientSocket.on('close', () => result.socket.destroy())
          return
        }
        if (status === 401 && round === 0) {
          result.response.resume()
          session = ''
          continue
        }
        writeRaw(clientSocket, result.response)
        return
      } catch (error) {
        note(messageOf(error))
        if (clientSocket.writable) {
          clientSocket.write('HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain\r\ncontent-length: 0\r\n\r\n')
        }
        clientSocket.destroy()
        return
      }
    }
    clientSocket.destroy()
  }

  const server = http.createServer((request, res) => {
    void handleRequest(request, res)
  })
  server.on('upgrade', (request, socket, head) => {
    void handleUpgrade(request, socket, head)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.on('error', (error) => {
    note(messageOf(error))
    logger?.warn?.(`tailscale-serve: bridge server error: ${messageOf(error)}`)
  })
  server.on('clientError', (error, socket) => {
    note(messageOf(error))
    if (socket.writable) socket.write('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n')
    socket.destroy()
  })
  server.requestTimeout = 0
  server.headersTimeout = 60000
  server.keepAliveTimeout = 65000

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const address = server.address()
  const port = address !== null && typeof address === 'object' ? address.port : 0
  logger?.info?.(`tailscale-serve: bridge listening on 127.0.0.1:${String(port)}`)

  const close = () => {
    if (closing !== undefined) return closing
    closed = true
    closing = new Promise((resolve) => {
      for (const socket of sockets) socket.destroy()
      agent.destroy()
      server.close(() => resolve())
    })
    return closing
  }

  return { port, close, output: () => tail }
}
