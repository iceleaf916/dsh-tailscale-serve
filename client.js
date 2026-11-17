/**
 * Client half of dsh-tailscale-serve: the Settings → "Tailscale Serve" page.
 *
 * The page is read-only. It polls the host half's JSON route
 * (`/api/tailscale-serve/status`) through the normal DSH authentication, so the
 * tailnet bridge mints the same cookie the rest of the UI uses and the page
 * works both on loopback and through the public tailnet origin.
 *
 * Loaded by the DSH Web module loader, not by a bundler: everything here is
 * plain ESM inside the `__ModuleLoader__.load` wrapper, React comes from
 * `require('react')`, and styles are inline CSS using the shipped theme tokens.
 */
window.__ModuleLoader__.load({
  id: 'dsh-tailscale-serve',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useState } = React

    /** Dictionary namespace owned by this plugin. */
    const NS = 'dsh-tailscale-serve'
    /** Host route that answers with the status snapshot. */
    const API = '/api/tailscale-serve/status'
    /** Refresh cadence; the host snapshot is cheap (in-memory only). */
    const POLL_MS = 3000
    /** Settings nav position: after skills-manager (25), beside remote-access (100). */
    const SECTION_ORDER = 90

    const DICTIONARIES = {
      en: {
        nav: 'Tailscale Serve',
        title: 'Tailscale Serve',
        subtitle: 'Publishes this DSH over tailnet HTTPS with no token or password in the URL.',
        status: 'Status',
        phase_ready: 'Running',
        phase_starting: 'Starting',
        phase_error: 'Needs attention',
        phase_stopped: 'Stopped',
        publicUrl: 'Public URL',
        localOrigin: 'Local DSH origin',
        bridge: 'Loopback bridge',
        bridgePort: 'Bridge port',
        cookie: 'Session cookie',
        cookie_yes: 'Minted',
        cookie_no: 'Not minted yet',
        tailnet: 'Tailscale',
        dnsName: 'DNS name',
        hostName: 'Host',
        tsVersion: 'Tailscale version',
        ips: 'Tailnet addresses',
        serve: 'Serve mapping',
        httpsPort: 'HTTPS port',
        pid: 'Process ID',
        uptime: 'Uptime',
        error: 'Last error',
        retryAt: 'Next retry',
        version: 'Plugin version',
        config: 'Configuration',
        loading: 'Loading status…',
        unreachable: 'Cannot read status',
        refresh: 'Refresh now',
        tailnetOnly: 'Reachable only from devices signed in to your tailnet.',
        noServe: 'No serve mapping is active.',
        none: '—',
      },
      zh: {
        nav: 'Tailscale Serve',
        title: 'Tailscale Serve',
        subtitle: '把当前 DSH 通过 tailnet HTTPS 发布出去，URL 中不携带任何令牌或密码。',
        status: '状态',
        phase_ready: '运行中',
        phase_starting: '启动中',
        phase_error: '需要处理',
        phase_stopped: '已停止',
        publicUrl: '公网地址',
        localOrigin: '本地 DSH 地址',
        bridge: '回环桥接',
        bridgePort: '桥接端口',
        cookie: '会话 Cookie',
        cookie_yes: '已注入',
        cookie_no: '尚未注入',
        tailnet: 'Tailscale',
        dnsName: 'DNS 名称',
        hostName: '主机名',
        tsVersion: 'Tailscale 版本',
        ips: 'tailnet 地址',
        serve: 'Serve 映射',
        httpsPort: 'HTTPS 端口',
        pid: '进程号',
        uptime: '运行时长',
        error: '最近一次错误',
        retryAt: '下次重试',
        version: '插件版本',
        config: '配置',
        loading: '正在读取状态…',
        unreachable: '无法读取状态',
        refresh: '立即刷新',
        tailnetOnly: '仅 tailnet 内已登录的设备可以访问。',
        noServe: '当前没有生效的 serve 映射。',
        none: '—',
      },
    }

    /** Stable `t(key)` bound to this plugin's namespace; reads the live locale. */
    let t = (key) => key
    /** Client root context, captured in `apply` for hooks used by components. */
    let clientCtx

    const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }
    const labelStyle = {
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: 12,
      lineHeight: '20px',
    }
    const valueStyle = {
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 13,
      lineHeight: '20px',
      wordBreak: 'break-all',
    }

    function formatDuration(ms) {
      if (!Number.isFinite(ms) || ms < 0) return '—'
      const total = Math.floor(ms / 1000)
      const days = Math.floor(total / 86400)
      const hours = Math.floor((total % 86400) / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const seconds = total % 60
      if (days > 0) return `${days}d ${hours}h`
      if (hours > 0) return `${hours}h ${minutes}m`
      if (minutes > 0) return `${minutes}m ${seconds}s`
      return `${seconds}s`
    }

    function formatTime(timestamp) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '—'
      try {
        return new Date(timestamp).toLocaleTimeString()
      } catch {
        return new Date(timestamp).toISOString()
      }
    }

    function phaseTone(phase) {
      if (phase === 'ready') return 'success'
      if (phase === 'starting') return 'warn'
      if (phase === 'error') return 'error'
      return 'idle'
    }

    function phaseKey(phase) {
      if (phase === 'ready') return 'phase_ready'
      if (phase === 'starting') return 'phase_starting'
      if (phase === 'error') return 'phase_error'
      return 'phase_stopped'
    }

    function Badge({ phase }) {
      const tone = phaseTone(phase)
      return h(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '2px 10px',
            borderRadius: 999,
            border: `1px solid var(--dsw-alias-state-${tone}-primary)`,
            color: `var(--dsw-alias-state-${tone}-primary)`,
            fontSize: 12,
            lineHeight: '18px',
            whiteSpace: 'nowrap',
          },
        },
        h('span', {
          style: {
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: `var(--dsw-alias-state-${tone}-primary)`,
          },
        }),
        t(phaseKey(phase)),
      )
    }

    function Row({ label, children }) {
      return h(
        'div',
        {
          style: {
            display: 'grid',
            gridTemplateColumns: 'minmax(120px, 180px) minmax(0, 1fr)',
            gap: 12,
            padding: '8px 0',
            borderBottom: '1px solid var(--dsw-alias-border-l1)',
            alignItems: 'baseline',
          },
        },
        h('div', { style: labelStyle }, label),
        h('div', { style: valueStyle }, children),
      )
    }

    function Muted({ children }) {
      return h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, children)
    }

    function Link({ href, children }) {
      return h(
        'a',
        {
          href,
          target: '_blank',
          rel: 'noreferrer noopener',
          style: { color: 'var(--dsw-alias-brand-primary)', textDecoration: 'none', ...mono, wordBreak: 'break-all' },
        },
        children,
      )
    }

    function useStatus() {
      const [state, setState] = useState({ snapshot: null, error: null, loading: true })

      const load = useCallback(async () => {
        try {
          const response = await fetch(API, {
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          })
          if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
          const snapshot = await response.json()
          setState({ snapshot, error: null, loading: false })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          setState((previous) => ({ snapshot: previous.snapshot, error: message, loading: false }))
        }
      }, [])

      useEffect(() => {
        let alive = true
        const tick = () => {
          if (alive) void load()
        }
        tick()
        const timer = setInterval(tick, POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [load])

      return { ...state, reload: load }
    }

    function TailscaleServeSection() {
      // Re-render when the active locale changes; t() itself always reads live.
      const [, setLocaleRevision] = useState(0)
      useEffect(() => {
        const locale = clientCtx?.locale
        if (typeof locale?.subscribe !== 'function') return undefined
        const off = locale.subscribe(() => setLocaleRevision((value) => value + 1))
        return typeof off === 'function' ? off : undefined
      }, [])

      const { snapshot, error, loading, reload } = useStatus()

      const phase = snapshot?.phase ?? (error === null ? 'starting' : 'error')
      const serve = snapshot?.serve ?? null
      const tailscale = snapshot?.tailscale ?? null
      const bridge = snapshot?.bridge ?? {}
      const plugin = snapshot?.plugin ?? null
      const config = snapshot?.config ?? null

      const header = h(
        'div',
        { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 } },
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h('div', { style: { color: 'var(--dsw-alias-label-primary)', fontSize: 18, fontWeight: 600 } }, t('title')),
            h(Badge, { phase }),
          ),
          h('div', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: '20px' } }, t('subtitle')),
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: () => {
              void reload()
            },
            style: {
              padding: '4px 12px',
              borderRadius: 8,
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-bg-layer-2)',
              color: 'var(--dsw-alias-label-primary)',
              fontSize: 12,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            },
          },
          t('refresh'),
        ),
      )

      const body = []
      if (error !== null) {
        body.push(
          h(
            'div',
            {
              key: 'error-banner',
              style: {
                padding: '8px 12px',
                borderRadius: 8,
                border: '1px solid var(--dsw-alias-state-error-primary)',
                color: 'var(--dsw-alias-state-error-primary)',
                fontSize: 12,
                lineHeight: '18px',
              },
            },
            `${t('unreachable')}: ${error}`,
          ),
        )
      }

      const rows = []
      if (snapshot !== null) {
        if (serve !== null) {
          rows.push(
            h(Row, { key: 'public', label: t('publicUrl') }, h(Link, { href: serve.publicOrigin }, serve.publicOrigin)),
          )
        } else {
          rows.push(h(Row, { key: 'public', label: t('publicUrl') }, h(Muted, {}, t('noServe'))))
        }
        rows.push(h(Row, { key: 'origin', label: t('localOrigin') }, h('span', { style: mono }, snapshot.dsh?.origin ?? '—')))
        rows.push(
          h(
            Row,
            { key: 'bridge', label: t('bridge') },
            bridge.port === null || bridge.port === undefined
              ? h(Muted, {}, t('none'))
              : h(
                  'span',
                  { style: mono },
                  `127.0.0.1:${String(bridge.port)}`,
                  ' · ',
                  h(
                    'span',
                    {
                      style: {
                        color: bridge.cookie
                          ? 'var(--dsw-alias-state-success-primary)'
                          : 'var(--dsw-alias-state-warn-primary)',
                      },
                    },
                    `${t('cookie')}: ${bridge.cookie ? t('cookie_yes') : t('cookie_no')}`,
                  ),
                ),
          ),
        )
        if (tailscale !== null) {
          rows.push(
            h(Row, { key: 'tailnet', label: t('tailnet') }, h('span', { style: mono }, tailscale.dnsName ?? '—')),
            h(
              Row,
              { key: 'host', label: t('hostName') },
              h(
                'span',
                {},
                `${tailscale.hostName || '—'}`,
                tailscale.version === '' ? null : h(Muted, {}, ` · v${tailscale.version}`),
              ),
            ),
          )
        }
        if (serve !== null) {
          rows.push(
            h(
              Row,
              { key: 'serve', label: t('serve') },
              h(
                'span',
                { style: mono },
                `tailscale serve --https=${String(serve.httpsPort)} · pid ${serve.pid === null ? '—' : String(serve.pid)}`,
              ),
            ),
          )
        }
        rows.push(h(Row, { key: 'uptime', label: t('uptime') }, formatDuration(snapshot.uptimeMs)))
        if (snapshot.error !== null) {
          rows.push(h(Row, { key: 'last-error', label: t('error') }, h('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, snapshot.error.message)))
        }
        if (snapshot.retry !== null) {
          rows.push(h(Row, { key: 'retry', label: t('retryAt') }, formatTime(snapshot.retry.at)))
        }
        if (plugin !== null) {
          rows.push(
            h(
              Row,
              { key: 'version', label: t('version') },
              h('span', { style: mono }, `dsh-tailscale-serve ${plugin.version}`),
            ),
          )
        }
        if (config !== null) {
          rows.push(
            h(
              Row,
              { key: 'config', label: t('config') },
              h(Muted, {}, `httpsPort=${String(config.httpsPort)} · tailscaleBin=${config.tailscaleBin} · retryMs=${String(config.retryMs)}`),
            ),
          )
        }
      } else if (loading) {
        body.push(h('div', { key: 'loading', style: { ...valueStyle, color: 'var(--dsw-alias-label-secondary)' } }, t('loading')))
      }

      body.push(
        h(
          'div',
          {
            key: 'rows',
            style: {
              display: 'flex',
              flexDirection: 'column',
              marginTop: 4,
            },
          },
          ...rows,
        ),
      )
      if (rows.length > 0) {
        body.push(
          h(
            'div',
            { key: 'note', style: { marginTop: 16, ...labelStyle } },
            t('tailnetOnly'),
          ),
        )
      }

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            padding: '20px 24px',
            maxWidth: 760,
            color: 'var(--dsw-alias-label-primary)',
            background: 'var(--dsw-alias-bg-base)',
          },
        },
        header,
        ...body,
      )
    }

    function apply(ctx) {
      clientCtx = ctx
      t = ctx.locale.bind(NS)
      ctx.locale.register(NS, DICTIONARIES)
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'tailscale-serve',
            order: SECTION_ORDER,
            locale: NS,
            label: () => t('nav'),
          },
          TailscaleServeSection,
        ),
      )
    }

    const inject = ['slots', 'locale']
    const exports = { apply, inject }
    return exports
  },
})
