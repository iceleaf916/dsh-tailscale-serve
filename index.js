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
 * Scope of mutations, by design:
 *  - exactly one foreground `tailscale serve --https=443` child, started only
 *    after confirming the authority has no existing handler, and stopped
 *    (which removes its config) when the plugin unloads;
 *  - no `tailscale set`, `up`, `down`, `cert`, `serve --bg`, `serve reset`,
 *    or `serve clear`, no sudo, no edits to tailscale preferences.
 */
import { createMinter } from './lib/auth.js'
import { createProxy } from './lib/proxy.js'
import { findServeConflict, publicOriginFor, readServeStatus, readTailscaleState } from './lib/tailscale.js'
import { startServe } from './lib/serve.js'

export const name = 'dsh-tailscale-serve'
export const inject = ['webServer', 'connection']

const DEFAULTS = Object.freeze({
  httpsPort: 443,
  tailscaleBin: 'tailscale',
  retryMs: 20000,
})

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

  let proxy
  let serve
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
    scheduleRetry()
  }

  async function boot() {
    if (disposed || booting) return
    booting = true
    try {
      if (minter.value === '') await minter.ensure()

      if (proxy === undefined) {
        const created = await createProxy({ origin, minter, publicOrigin: () => publicOrigin, logger })
        if (disposed) {
          await created.close()
          return
        }
        proxy = created
      }

      const state = await readTailscaleState(options.tailscaleBin)
      if (!state.ok) {
        reportFailure(state.error)
        return
      }
      if (disposed) return

      if (serve === undefined) {
        const status = await readServeStatus(options.tailscaleBin)
        if (!status.ok) {
          reportFailure(`cannot read \`tailscale serve status\`: ${status.error}`)
          return
        }
        if (disposed) return
        const conflict = findServeConflict(status.value, state.dnsName, options.httpsPort, proxy.port)
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

      publicOrigin = publicOriginFor(state.dnsName, options.httpsPort)
      minter.start()
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
