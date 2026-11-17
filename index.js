/**
 * dsh-tailscale-serve
 *
 * Publishes this DSH Web GUI on the tailnet over HTTPS using only the
 * `tailscale` CLI:
 *
 *   browser --HTTPS--> tailscaled (TLS termination, tailnet-only)
 *           --HTTP--> 127.0.0.1:<bridge>  (this plugin, ephemeral port)
 *           --HTTP--> 127.0.0.1:<dsh port> (ctx.webServer)
 *
 * The bridge makes the request look like a loopback request to DSH (Host and
 * Origin rewritten, a loopback-audience session cookie minted through
 * `connection.authenticatedUrl`), so the DSH Host/Origin fence and cookie
 * checks pass without adding tokens or passwords to the URL.
 *
 * The same plugin ships a Settings page (client.js) that renders a read-only
 * status view; the host half serves its snapshot at
 * `GET /api/tailscale-serve/status` behind `connection.requestRejection`, so
 * the page needs no extra credentials and the route cannot be driven from a
 * foreign origin.
 *
 * Scope of mutations, by design:
 *  - exactly one foreground `tailscale serve --https=443` child, started only
 *    after confirming the authority has no existing handler, and stopped
 *    (which removes its config) when the plugin unloads;
 *  - no `tailscale set`, `up`, `down`, `cert`, `serve --bg`, `serve reset`,
 *    or `serve clear`, no sudo, no edits to tailscale preferences.
 */
import { readFileSync } from 'node:fs'
import { createMinter } from './lib/auth.js'
import { createProxy } from './lib/proxy.js'
import { createStatusReport } from './lib/status.js'
import { findServeConflict, publicOriginFor, readServeStatus, readTailscaleState } from './lib/tailscale.js'
import { startServe } from './lib/serve.js'

export const name = 'dsh-tailscale-serve'
export const inject = ['webServer', 'connection']

const DEFAULTS = Object.freeze({
  httpsPort: 443,
  tailscaleBin: 'tailscale',
  retryMs: 20000,
})

/** Wire path the Settings page reads; exact match, JSON only, GET/HEAD. */
const STATUS_PATH = '/api/tailscale-serve/status'

const VERSION = (() => {
  try {
    const text = readFileSync(new URL('./package.json', import.meta.url), 'utf8')
    const version = JSON.parse(text)?.version
    return typeof version === 'string' ? version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

function normalizeConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const httpsPort =
    Number.isInteger(raw.httpsPort) && raw.httpsPort > 0 && raw.httpsPort <= 65535 ? raw.httpsPort : DEFAULTS.httpsPort
  const tailscaleBin =
    typeof raw.tailscaleBin === 'string' && raw.tailscaleBin.trim() !== ''
      ? raw.tailscaleBin.trim()
      : DEFAULTS.tailscaleBin
  const retryMs =
    typeof raw.retryMs === 'number' && Number.isFinite(raw.retryMs) && raw.retryMs >= 5000
      ? Math.min(raw.retryMs, 300000)
      : DEFAULTS.retryMs
  return { httpsPort, tailscaleBin, retryMs }
}

export function apply(ctx, config) {
  const options = normalizeConfig(config)
  const logger = ctx.logger ?? console
  const origin = ctx.webServer.getOrigin()
  const minter = createMinter({ connection: ctx.connection, origin, logger })
  const status = createStatusReport({ version: VERSION, config: options, origin })

  let proxy
  let serve
  let serveStartedAt = 0
  let timer
  let booting = false
  let disposed = false
  let publicOrigin = ''
  let lastFailure = ''

  const stopTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const scheduleRetry = () => {
    if (disposed || timer !== undefined) return
    status.retrying(Date.now() + options.retryMs)
    timer = setTimeout(() => {
      timer = undefined
      void boot()
    }, options.retryMs)
    timer.unref?.()
  }

  const reportFailure = (reason) => {
    if (reason !== lastFailure) {
      lastFailure = reason
      logger.warn(`tailscale-serve: ${reason}`)
    }
    status.failed(reason, disposed ? null : Date.now() + options.retryMs)
    scheduleRetry()
  }

  const sendJson = (res, code, body) => {
    if (res.headersSent) {
      res.end()
      return
    }
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(JSON.stringify(body))
  }

  // The Settings page reads this route through the same DSH authentication as
  // every API call: on loopback the browser cookie passes, and through the
  // tailnet bridge the bridge's minted cookie does. A foreign Origin is
  // rejected by the same fence that protects the rest of the API.
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: STATUS_PATH,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' })
          res.end()
          return
        }
        let rejection
        try {
          rejection = ctx.connection.requestRejection({ headers: req.headers })
        } catch (error) {
          logger.warn(`tailscale-serve: status route rejected a request: ${messageOf(error)}`)
          sendJson(res, 500, { error: 'status unavailable' })
          return
        }
        if (rejection !== undefined) {
          sendJson(res, rejection, {
            error: rejection === 403 ? 'request not allowed from this origin' : 'dsh authentication required',
          })
          return
        }
        sendJson(res, 200, status.snapshot())
      },
    }),
  )

  async function boot() {
    if (disposed || booting) return
    booting = true
    try {
      if (minter.value === '') {
        await minter.ensure()
        status.cookieReady(minter.value !== '')
      }

      if (proxy === undefined) {
        const created = await createProxy({ origin, minter, publicOrigin: () => publicOrigin, logger })
        if (disposed) {
          await created.close()
          return
        }
        proxy = created
        status.bridgeReady(proxy.port)
        status.cookieReady(minter.value !== '')
      }

      const state = await readTailscaleState(options.tailscaleBin)
      if (!state.ok) {
        reportFailure(state.error)
        return
      }
      if (disposed) return
      status.tailscaleReady(state)
      publicOrigin = publicOriginFor(state.dnsName, options.httpsPort)

      if (serve === undefined) {
        const serveStatus = await readServeStatus(options.tailscaleBin)
        if (!serveStatus.ok) {
          reportFailure(`cannot read \`tailscale serve status\`: ${serveStatus.error}`)
          return
        }
        if (disposed) return
        const conflict = findServeConflict(serveStatus.value, state.dnsName, options.httpsPort, proxy.port)
        if (conflict !== undefined) {
          reportFailure(conflict)
          return
        }
        const started = await startServe({
          bin: options.tailscaleBin,
          httpsPort: options.httpsPort,
          proxyPort: proxy.port,
        })
        if (disposed) {
          await started.stop()
          return
        }
        serve = started
        serveStartedAt = Date.now()
        started.child.once('exit', (code, signal) => {
          if (serve !== started) return
          serve = undefined
          if (disposed) return
          const detail = started.output().trim()
          reportFailure(
            `tailscale serve exited unexpectedly (code ${String(code)}, signal ${String(signal)})` +
              (detail === '' ? '' : `:\n${detail}`),
          )
        })
      }

      minter.start()
      status.serveReady({ pid: serve?.child.pid, publicOrigin, startedAt: serveStartedAt })
      if (lastFailure !== '') logger.info('tailscale-serve: recovered')
      lastFailure = ''
      logger.info(`tailscale-serve: ready at ${publicOrigin} -> ${origin}`)
    } catch (error) {
      reportFailure(messageOf(error))
    } finally {
      booting = false
    }
  }

  const onProcessExit = () => {
    try {
      serve?.child.kill('SIGTERM')
    } catch {
      // ignore: the process is already going away
    }
  }
  process.once('exit', onProcessExit)

  const shutdown = async () => {
    if (disposed) return
    disposed = true
    stopTimer()
    minter.stop()
    status.stop()
    process.removeListener('exit', onProcessExit)
    const pendingServe = serve
    serve = undefined
    if (pendingServe !== undefined) await pendingServe.stop().catch(() => {})
    const pendingProxy = proxy
    proxy = undefined
    if (pendingProxy !== undefined) await pendingProxy.close().catch(() => {})
    logger.info('tailscale-serve: stopped; its foreground serve mapping is gone')
  }

  ctx.effect(() => () => {
    void shutdown()
  })

  void boot()
}
