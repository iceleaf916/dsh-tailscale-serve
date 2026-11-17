/**
 * Live status of one plugin run, shaped for the Settings page.
 *
 * The host half owns the truth (bridge port, serve child, tailnet identity);
 * the client half only renders this snapshot. Keeping the shape in one place
 * means the JSON route and the tests agree on the wire format.
 */

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * @param {{version:string, config:{httpsPort:number, tailscaleBin:string, retryMs:number}, origin:string}} options
 */
export function createStatusReport({ version, config, origin }) {
  const startedAt = Date.now()

  const state = {
    phase: 'starting',
    phaseSince: startedAt,
    error: null,
    retry: null,
    tailscale: null,
    bridge: { port: null, url: null, cookie: false },
    serve: null,
  }

  const setPhase = (phase) => {
    if (state.phase === phase) return
    state.phase = phase
    state.phaseSince = Date.now()
  }

  return {
    /** The bridge just bound its loopback listener. */
    bridgeReady(port) {
      state.bridge = { port, url: `http://127.0.0.1:${String(port)}`, cookie: state.bridge.cookie }
    },

    /** Whether the bridge currently holds a minted DSH session cookie. */
    cookieReady(ready) {
      state.bridge = { ...state.bridge, cookie: ready }
    },

    /** The tailnet identity read from `tailscale status --json`. */
    tailscaleReady(info) {
      state.tailscale = {
        bin: config.tailscaleBin,
        backendState: info.backendState ?? 'Running',
        version: info.version ?? '',
        dnsName: info.dnsName,
        ips: info.ips,
        hostName: info.hostName ?? '',
      }
    },

    /** The foreground serve child is up and the public origin is known. */
    serveReady({ pid, publicOrigin, startedAt: serveStartedAt }) {
      state.serve = {
        httpsPort: config.httpsPort,
        publicOrigin,
        pid: pid ?? null,
        startedAt: serveStartedAt,
      }
      state.error = null
      state.retry = null
      setPhase('ready')
    },

    /** Record a boot failure and the retry that follows it. */
    failed(reason, retryAt) {
      state.error = { message: messageOf(reason), at: Date.now() }
      state.retry = retryAt === null ? null : { at: retryAt, delayMs: config.retryMs }
      if (state.serve !== null) {
        // The serve mapping is gone or unusable; the page keeps showing the
        // last known public origin as history but not as a working link.
        state.serve = null
      }
      setPhase('error')
    },

    /** A retry is scheduled while the plugin still considers itself starting. */
    retrying(retryAt) {
      state.retry = retryAt === null ? null : { at: retryAt, delayMs: config.retryMs }
    },

    /** The plugin is shutting down; nothing is listening any more. */
    stop() {
      state.phase = 'stopped'
      state.phaseSince = Date.now()
      state.serve = null
      state.bridge = { port: null, url: null, cookie: false }
      state.retry = null
    },

    /** Serialize for the browser: plain JSON, no functions, no cycles. */
    snapshot() {
      return {
        plugin: { name: 'dsh-tailscale-serve', version, startedAt },
        phase: state.phase,
        phaseSince: state.phaseSince,
        checkedAt: Date.now(),
        config: { ...config },
        dsh: { origin },
        bridge: { ...state.bridge },
        tailscale: state.tailscale === null ? null : { ...state.tailscale, ips: [...state.tailscale.ips] },
        serve: state.serve === null ? null : { ...state.serve },
        error: state.error === null ? null : { ...state.error },
        retry: state.retry === null ? null : { ...state.retry },
        uptimeMs: Date.now() - startedAt,
      }
    },
  }
}
