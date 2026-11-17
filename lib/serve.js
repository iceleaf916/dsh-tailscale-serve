/**
 * Foreground `tailscale serve` child process.
 *
 * Foreground mode is intentional: the serve mapping exists exactly while this
 * child runs, so disabling/removing the plugin removes the mapping without any
 * extra mutation. The plugin never uses `--bg`, never calls `serve reset`,
 * `serve clear`, or `tailscale set`.
 */
import { spawn } from 'node:child_process'

const READY = /available within your tailnet|--\s*proxy/i
const MAX_TAIL = 4000

export function serveArgs(httpsPort, proxyPort) {
  return ['serve', `--https=${String(httpsPort)}`, '--yes', `http://127.0.0.1:${String(proxyPort)}`]
}

/**
 * Spawn `tailscale serve --https=<port> --yes http://127.0.0.1:<proxyPort>` and
 * wait until the CLI prints its "Available within your tailnet" banner.
 *
 * @param {{bin:string, httpsPort:number, proxyPort:number, readyTimeoutMs?:number}} options
 */
export async function startServe({ bin, httpsPort, proxyPort, readyTimeoutMs = 90000 }) {
  const child = spawn(bin, serveArgs(httpsPort, proxyPort), {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: process.env,
  })

  let tail = ''
  let ready = false
  const waiters = []
  const settle = (error) => {
    if (waiters.length === 0) return
    for (const waiter of waiters.splice(0)) error === undefined ? waiter.resolve() : waiter.reject(error)
  }

  const capture = (chunk) => {
    const text = String(chunk)
    tail = (tail + text).slice(-MAX_TAIL)
    if (!ready && READY.test(tail)) {
      ready = true
      settle(undefined)
    }
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)

  const spawnFailure = new Promise((resolve, reject) => {
    child.once('error', (error) => {
      if (!ready) reject(new Error(`could not start \`${bin} serve\`: ${error.message}`))
      else resolve()
    })
    child.once('exit', (code, signal) => {
      if (ready) return
      const detail = tail.trim()
      reject(
        new Error(
          `\`${bin} serve\` exited before becoming ready (code ${String(code)}, signal ${String(signal)})` +
            (detail === '' ? '' : `:\n${detail}`),
        ),
      )
    })
  })
  spawnFailure.catch(() => {})

  await Promise.race([
    new Promise((resolve, reject) => {
      if (ready) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        reject(
          new Error(
            `\`${bin} serve\` did not report readiness within ${String(Math.round(readyTimeoutMs / 1000))}s` +
              (tail.trim() === '' ? '' : `:\n${tail.trim()}`),
          ),
        )
      }, readyTimeoutMs)
      timer.unref?.()
      waiters.push({
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
    }),
    spawnFailure,
  ])

  let stopping
  const stop = () => {
    if (stopping !== undefined) return stopping
    stopping = (async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill('SIGTERM')
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // the child is already gone
        }
      }, 5000)
      timer.unref?.()
      await exited
      clearTimeout(timer)
    })()
    return stopping
  }

  return { child, stop, output: () => tail }
}
