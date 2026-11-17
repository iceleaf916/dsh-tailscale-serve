/**
 * Thin wrappers around the `tailscale` CLI.
 *
 * The plugin deliberately uses only read-only queries plus the one foreground
 * `serve` child it owns (see serve.js). It never calls `set`, `up`, `down`,
 * `reset`, `clear`, `cert`, or any persistent `serve --bg` mutation.
 */
import { execFile } from 'node:child_process'

const MAX_BUFFER = 8 * 1024 * 1024

/** Run one tailscale subcommand without a shell and without throwing. */
export function runTailscale(bin, args, { timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout, maxBuffer: MAX_BUFFER, windowsHide: true, env: process.env },
      (error, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : String(stdout ?? '')
        const err = typeof stderr === 'string' ? stderr : String(stderr ?? '')
        if (error === null) {
          resolve({ ok: true, stdout: out, stderr: err })
          return
        }
        const code = typeof error.code === 'number' ? error.code : null
        resolve({ ok: false, code, stdout: out, stderr: err !== '' ? err : String(error.message ?? error) })
      },
    )
  })
}

/** The one-sentence recovery hint for a failed tailscale invocation. */
export function explainTailscaleFailure(stderr, code) {
  const text = String(stderr ?? '').trim()
  if (code === 'ENOENT' || /ENOENT|command not found|no such file/i.test(text)) {
    return 'the `tailscale` command is not available; install Tailscale or set tailscaleBin in the plugin config'
  }
  if (/serve config denied|Access denied/i.test(text)) {
    return 'tailscale serve is not permitted for this user; run this once yourself: sudo tailscale set --operator=$USER'
  }
  if (/not logged in|Logged out|needsLogin|Log in/i.test(text)) {
    return 'tailscale is not logged in; run `tailscale up` and finish the authorization'
  }
  if (/is stopped|tailscaled.*not running|backend.*not running/i.test(text)) {
    return 'tailscale is not running; start it with `tailscale up`'
  }
  const first = text.split('\n').map((line) => line.trim()).filter((line) => line !== '')[0]
  return first === undefined ? 'tailscale exited with an unknown error' : first
}

/**
 * Read `tailscale status --json` and reduce it to the facts the bridge needs.
 * @returns {Promise<{ok:true,dnsName:string,ips:string[],hostName:string,backendState:string,version:string}|{ok:false,error:string}>}
 */
export async function readTailscaleState(bin) {
  const result = await runTailscale(bin, ['status', '--json'])
  if (!result.ok) return { ok: false, error: explainTailscaleFailure(result.stderr, result.code) }
  let json
  try {
    json = JSON.parse(result.stdout)
  } catch {
    return { ok: false, error: '`tailscale status --json` returned invalid JSON' }
  }
  if (json === null || typeof json !== 'object') {
    return { ok: false, error: '`tailscale status --json` returned an unexpected document' }
  }
  if (json.BackendState !== 'Running') {
    return {
      ok: false,
      error: `tailscale is not running (BackendState: ${String(json.BackendState ?? 'unknown')}); run \`tailscale up\``,
    }
  }
  const self = json.Self ?? {}
  const dnsName = String(self.DNSName ?? '').trim().replace(/\.$/, '')
  if (dnsName === '') {
    return {
      ok: false,
      error: 'tailscale has no MagicDNS name yet; enable MagicDNS and HTTPS certificates for this tailnet',
    }
  }
  const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.filter((ip) => typeof ip === 'string') : []
  return {
    ok: true,
    dnsName,
    ips,
    hostName: String(self.HostName ?? ''),
    backendState: String(json.BackendState ?? ''),
    version: String(json.Version ?? ''),
  }
}

/** Read `tailscale serve status --json`; an empty config arrives as `{}`. */
export async function readServeStatus(bin) {
  const result = await runTailscale(bin, ['serve', 'status', '--json'])
  if (!result.ok) return { ok: false, error: explainTailscaleFailure(result.stderr, result.code) }
  try {
    const json = JSON.parse(result.stdout.trim() === '' ? '{}' : result.stdout)
    if (json === null || typeof json !== 'object') return { ok: false, error: '`tailscale serve status --json` returned an unexpected document' }
    return { ok: true, value: json }
  } catch {
    return { ok: false, error: '`tailscale serve status --json` returned invalid JSON' }
  }
}

function webHandlersFor(status, authority) {
  const handlers = []
  for (const scope of ['Foreground', 'Background']) {
    const entries = status?.[scope]
    if (entries === null || typeof entries !== 'object') continue
    for (const entry of Object.values(entries)) {
      const web = entry?.Web
      if (web === null || typeof web !== 'object') continue
      const site = web[authority]
      const map = site?.Handlers
      if (map === null || typeof map !== 'object') continue
      for (const [path, handler] of Object.entries(map)) {
        handlers.push({ scope, path, proxy: typeof handler?.Proxy === 'string' ? handler.Proxy : undefined })
      }
    }
  }
  return handlers
}

/**
 * Refuse to touch an authority that already belongs to another serve config.
 *
 * `tailscale serve` foreground mode owns the whole `host:port` site it is
 * started for, so starting it over an existing entry would silently replace
 * that entry. Returning a message here keeps the plugin additive: the user
 * either picks another httpsPort or removes the other handler themselves.
 *
 * @returns {string|undefined} a human-readable conflict, or undefined when free
 */
export function findServeConflict(status, dnsName, httpsPort, proxyPort) {
  const authority = `${dnsName}:${String(httpsPort)}`
  const handlers = webHandlersFor(status, authority)
  if (handlers.length === 0) return undefined
  const ownTarget = `http://127.0.0.1:${String(proxyPort)}`
  if (handlers.every((handler) => handler.proxy === ownTarget)) return undefined
  const listed = handlers
    .map((handler) => `${handler.path} -> ${handler.proxy ?? '(unknown target)'} [${handler.scope}]`)
    .join(', ')
  return (
    `tailscale serve already has a handler for https://${authority}: ${listed}. ` +
    'Refusing to replace it; set another httpsPort in this plugin\'s config, or remove that serve entry yourself.'
  )
}

/** Public HTTPS origin for a MagicDNS name and serve port. */
export function publicOriginFor(dnsName, httpsPort) {
  return httpsPort === 443 ? `https://${dnsName}` : `https://${dnsName}:${String(httpsPort)}`
}
