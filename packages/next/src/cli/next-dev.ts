#!/usr/bin/env node

import '../server/lib/cpu-profile'
import type { StartServerOptions } from '../server/lib/start-server'
import { getPort, printAndExit } from '../server/lib/utils'
import * as Log from '../build/output/log'
import { CliCommand } from '../lib/commands'
import { getProjectDir } from '../lib/get-project-dir'
import { PHASE_DEVELOPMENT_SERVER } from '../shared/lib/constants'
import path from 'path'
import { NextConfigComplete } from '../server/config-shared'
import { setGlobal, traceGlobals } from '../trace/shared'
import { Telemetry } from '../telemetry/storage'
import loadConfig, { getEnabledExperimentalFeatures } from '../server/config'
import { findPagesDir } from '../lib/find-pages-dir'
import { fileExists, FileType } from '../lib/file-exists'
import { getNpxCommand } from '../lib/helpers/get-npx-command'
import { createSelfSignedCertificate } from '../lib/mkcert'
import uploadTrace from '../trace/upload-trace'
import { initialEnv, loadEnvConfig } from '@next/env'
import { trace } from '../trace'
import { validateTurboNextConfig } from '../lib/turbopack-warning'
import { fork } from 'child_process'
import { RESTART_EXIT_CODE } from '../server/lib/setup-server-worker'
import {
  getReservedPortExplanation,
  isPortIsReserved,
} from '../lib/helpers/get-reserved-port'

let dir: string
let child: undefined | ReturnType<typeof fork>
let config: NextConfigComplete
let isTurboSession = false
let traceUploadUrl: string
let sessionStopHandled = false
let sessionStarted = Date.now()

const handleSessionStop = async (signal: string | null) => {
  if (child) {
    child.kill((signal as any) || 0)
  }
  if (sessionStopHandled) return
  sessionStopHandled = true

  try {
    const { eventCliSessionStopped } =
      require('../telemetry/events/session-stopped') as typeof import('../telemetry/events/session-stopped')

    config = config || (await loadConfig(PHASE_DEVELOPMENT_SERVER, dir))

    let telemetry =
      (traceGlobals.get('telemetry') as InstanceType<
        typeof import('../telemetry/storage').Telemetry
      >) ||
      new Telemetry({
        distDir: path.join(dir, config.distDir),
      })

    let pagesDir: boolean = !!traceGlobals.get('pagesDir')
    let appDir: boolean = !!traceGlobals.get('appDir')

    if (
      typeof traceGlobals.get('pagesDir') === 'undefined' ||
      typeof traceGlobals.get('appDir') === 'undefined'
    ) {
      const pagesResult = findPagesDir(dir)
      appDir = !!pagesResult.appDir
      pagesDir = !!pagesResult.pagesDir
    }

    telemetry.record(
      eventCliSessionStopped({
        cliCommand: 'dev',
        turboFlag: isTurboSession,
        durationMilliseconds: Date.now() - sessionStarted,
        pagesDir,
        appDir,
      }),
      true
    )
    telemetry.flushDetached('dev', dir)
  } catch (_) {
    // errors here aren't actionable so don't add
    // noise to the output
  }

  if (traceUploadUrl) {
    uploadTrace({
      traceUploadUrl,
      mode: 'dev',
      isTurboSession,
      projectDir: dir,
      distDir: config.distDir,
    })
  }

  // ensure we re-enable the terminal cursor before exiting
  // the program, or the cursor could remain hidden
  process.stdout.write('\x1B[?25h')
  process.stdout.write('\n')
  process.exit(0)
}

process.on('SIGINT', () => handleSessionStop('SIGINT'))
process.on('SIGTERM', () => handleSessionStop('SIGTERM'))

const nextDev: CliCommand = async (args) => {
  if (args['--help']) {
    console.log(`
      Description
        Starts the application in development mode (hot-code reloading, error
        reporting, etc.)

      Usage
        $ next dev <dir> -p <port number>

      <dir> represents the directory of the Next.js application.
      If no directory is provided, the current directory will be used.

      Options
        --port, -p      A port number on which to start the application
        --hostname, -H  Hostname on which to start the application (default: 0.0.0.0)
        --experimental-upload-trace=<trace-url>  [EXPERIMENTAL] Report a subset of the debugging trace to a remote http url. Includes sensitive data. Disabled by default and url must be provided.
        --help, -h      Displays this message
    `)
    process.exit(0)
  }
  dir = getProjectDir(process.env.NEXT_PRIVATE_DEV_DIR || args._[0])

  // Check if pages dir exists and warn if not
  if (!(await fileExists(dir, FileType.Directory))) {
    printAndExit(`> No such directory exists as the project root: ${dir}`)
  }

  async function preflight(skipOnReboot: boolean) {
    const { getPackageVersion, getDependencies } = (await Promise.resolve(
      require('../lib/get-package-version')
    )) as typeof import('../lib/get-package-version')

    const [sassVersion, nodeSassVersion] = await Promise.all([
      getPackageVersion({ cwd: dir, name: 'sass' }),
      getPackageVersion({ cwd: dir, name: 'node-sass' }),
    ])
    if (sassVersion && nodeSassVersion) {
      Log.warn(
        'Your project has both `sass` and `node-sass` installed as dependencies, but should only use one or the other. ' +
          'Please remove the `node-sass` dependency from your project. ' +
          ' Read more: https://nextjs.org/docs/messages/duplicate-sass'
      )
    }

    if (!skipOnReboot) {
      const { dependencies, devDependencies } = await getDependencies({
        cwd: dir,
      })

      // Warn if @next/font is installed as a dependency. Ignore `workspace:*` to not warn in the Next.js monorepo.
      if (
        dependencies['@next/font'] ||
        (devDependencies['@next/font'] &&
          devDependencies['@next/font'] !== 'workspace:*')
      ) {
        const command = getNpxCommand(dir)
        Log.warn(
          'Your project has `@next/font` installed as a dependency, please use the built-in `next/font` instead. ' +
            'The `@next/font` package will be removed in Next.js 14. ' +
            `You can migrate by running \`${command} @next/codemod@latest built-in-next-font .\`. Read more: https://nextjs.org/docs/messages/built-in-next-font`
        )
      }
    }
  }

  const port = getPort(args)

  if (isPortIsReserved(port)) {
    printAndExit(getReservedPortExplanation(port), 1)
  }

  // If neither --port nor PORT were specified, it's okay to retry new ports.
  const allowRetry =
    args['--port'] === undefined && process.env.PORT === undefined

  // We do not set a default host value here to prevent breaking
  // some set-ups that rely on listening on other interfaces
  const host = args['--hostname']

  const { loadedEnvFiles } = loadEnvConfig(dir, true, console, false)

  let expFeatureInfo: string[] = []
  config = await loadConfig(PHASE_DEVELOPMENT_SERVER, dir, {
    onLoadUserConfig(userConfig) {
      const userNextConfigExperimental = getEnabledExperimentalFeatures(
        userConfig.experimental
      )
      expFeatureInfo = userNextConfigExperimental.sort(
        (a, b) => a.length - b.length
      )
    },
  })

  process.env.__NEXT_PRIVATE_PREBUNDLED_REACT = config.experimental
    .serverActions
    ? 'experimental'
    : 'next'

  // we need to reset env if we are going to create
  // the worker process with the esm loader so that the
  // initial env state is correct
  let envInfo: string[] = []
  if (loadedEnvFiles.length > 0) {
    envInfo = loadedEnvFiles.map((f) => f.path)
  }

  const isExperimentalTestProxy = args['--experimental-test-proxy']

  if (args['--experimental-upload-trace']) {
    traceUploadUrl = args['--experimental-upload-trace']
  }

  const devServerOptions: StartServerOptions = {
    dir,
    port,
    allowRetry,
    isDev: true,
    hostname: host,
    isExperimentalTestProxy,
    envInfo,
    expFeatureInfo,
  }

  if (args['--turbo']) {
    process.env.TURBOPACK = '1'
  }

  if (process.env.TURBOPACK) {
    await validateTurboNextConfig({
      isCustomTurbopack: !!process.env.__INTERNAL_CUSTOM_TURBOPACK_BINDINGS,
      ...devServerOptions,
      isDev: true,
    })
  }

  const distDir = path.join(dir, config.distDir ?? '.next')
  setGlobal('phase', PHASE_DEVELOPMENT_SERVER)
  setGlobal('distDir', distDir)

  const startServerPath = require.resolve('../server/lib/start-server')
  async function startServer(options: StartServerOptions) {
    return new Promise<void>((resolve) => {
      let resolved = false

      child = fork(startServerPath, {
        stdio: 'inherit',
        env: {
          ...((initialEnv || process.env) as typeof process.env),
          TURBOPACK: process.env.TURBOPACK,
          NEXT_PRIVATE_WORKER: '1',
        },
      })

      child.on('message', (msg: any) => {
        if (msg && typeof msg === 'object') {
          if (msg.nextWorkerReady) {
            child?.send({ nextWorkerOptions: options })
          } else if (msg.nextServerReady && !resolved) {
            resolved = true
            resolve()
          }
        }
      })

      child.on('exit', async (code, signal) => {
        if (sessionStopHandled || signal) {
          return
        }
        if (code === RESTART_EXIT_CODE) {
          return startServer(options)
        }
        await handleSessionStop(signal)
      })
    })
  }

  const runDevServer = async (reboot: boolean) => {
    try {
      if (!!args['--experimental-https']) {
        Log.warn(
          'Self-signed certificates are currently an experimental feature, use at your own risk.'
        )

        let certificate: { key: string; cert: string } | undefined

        if (
          args['--experimental-https-key'] &&
          args['--experimental-https-cert']
        ) {
          certificate = {
            key: path.resolve(args['--experimental-https-key']),
            cert: path.resolve(args['--experimental-https-cert']),
          }
        } else {
          certificate = await createSelfSignedCertificate(host)
        }

        await startServer({
          ...devServerOptions,
          selfSignedCertificate: certificate,
        })
      } else {
        await startServer(devServerOptions)
      }

      await preflight(reboot)
    } catch (err) {
      console.error(err)
      process.exit(1)
    }
  }

  await trace('start-dev-server').traceAsyncFn(async (_) => {
    await runDevServer(false)
  })
}

export { nextDev }
