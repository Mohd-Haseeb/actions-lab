/**
 * runner-inspect — Action 1
 *
 * WHAT THIS TEACHES:
 *  - The full set of GITHUB_* and RUNNER_* environment variables injected by the runner
 *  - Runner filesystem layout: GITHUB_WORKSPACE, RUNNER_TOOL_CACHE, RUNNER_TEMP, etc.
 *  - How to use @actions/exec to run shell commands and capture output
 *  - How GITHUB_STEP_SUMMARY works (it's a file path; @actions/core wraps it)
 *  - core.group() for collapsible log sections
 *  - core.setOutput() for passing data to downstream steps
 *  - @actions/artifact v2 DefaultArtifactClient for uploading files
 *
 * RUNNER ENVIRONMENT QUICK REFERENCE:
 *  GITHUB_WORKSPACE    — checked-out repo root (/home/runner/work/<repo>/<repo>)
 *  GITHUB_ACTION_PATH  — where THIS action's files live
 *  RUNNER_TOOL_CACHE   — pre-installed tool cache (/opt/hostedtoolcache on Linux)
 *  RUNNER_TEMP         — temp dir, cleaned between jobs
 *  RUNNER_WORKSPACE    — parent of GITHUB_WORKSPACE
 *  GITHUB_ENV          — file to write to in order to set env vars for later steps
 *  GITHUB_OUTPUT       — file to write to in order to set step outputs
 *  GITHUB_PATH         — file to write to in order to prepend to PATH
 *  GITHUB_STEP_SUMMARY — file to write markdown for the job summary UI
 */

const core = require('@actions/core')
const exec = require('@actions/exec')
const artifact = require('@actions/artifact')
const os = require('os')
const fs = require('fs')
const path = require('path')

async function run() {
  try {
    const report = {}

    // ─────────────────────────────────────────────────────────────────────────
    // 1. ENVIRONMENT VARIABLES
    //    The runner injects dozens of GITHUB_* and RUNNER_* vars. We categorise
    //    them so you can see at a glance what each group is for.
    // ─────────────────────────────────────────────────────────────────────────
    await core.group('Environment Variables', async () => {
      const env = process.env

      const categories = {
        'GITHUB_*  (workflow & event context)': {},
        'RUNNER_*  (machine info)': {},
        'CI / build signals': {},
        'Actions internal (file sinks)': {},
      }

      const fileSinks = new Set([
        'GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_PATH',
        'GITHUB_STEP_SUMMARY', 'GITHUB_STATE', 'GITHUB_ACTION_OUTPUT',
      ])

      for (const [key, value] of Object.entries(env).sort()) {
        if (fileSinks.has(key)) {
          categories['Actions internal (file sinks)'][key] = value
        } else if (key.startsWith('GITHUB_')) {
          categories['GITHUB_*  (workflow & event context)'][key] = value
        } else if (key.startsWith('RUNNER_')) {
          categories['RUNNER_*  (machine info)'][key] = value
        } else if (['CI', 'CONTINUOUS_INTEGRATION', 'ACTIONS'].includes(key)) {
          categories['CI / build signals'][key] = value
        }
      }

      for (const [category, vars] of Object.entries(categories)) {
        core.info(`\n── ${category} ──`)
        for (const [k, v] of Object.entries(vars)) {
          // Truncate very long values (e.g. GITHUB_EVENT_PATH contents)
          const display = v && v.length > 120 ? v.slice(0, 120) + '…' : v
          core.info(`  ${k.padEnd(35)} = ${display}`)
        }
      }

      report.env = {
        github: categories['GITHUB_*  (workflow & event context)'],
        runner: categories['RUNNER_*  (machine info)'],
        ci: categories['CI / build signals'],
        fileSinks: categories['Actions internal (file sinks)'],
      }
    })

    // ─────────────────────────────────────────────────────────────────────────
    // 2. FILESYSTEM LAYOUT
    //    Understanding where files live is critical. The runner sets up several
    //    well-known directories before your job starts.
    // ─────────────────────────────────────────────────────────────────────────
    await core.group('Filesystem Layout', async () => {
      const dirs = {
        GITHUB_WORKSPACE:   process.env.GITHUB_WORKSPACE,
        GITHUB_ACTION_PATH: process.env.GITHUB_ACTION_PATH,
        RUNNER_TOOL_CACHE:  process.env.RUNNER_TOOL_CACHE,
        RUNNER_TEMP:        process.env.RUNNER_TEMP,
        RUNNER_WORKSPACE:   process.env.RUNNER_WORKSPACE,
        HOME:               process.env.HOME || os.homedir(),
        TMP_DIR:            os.tmpdir(),
      }

      report.filesystem = {}

      for (const [name, dirPath] of Object.entries(dirs)) {
        if (!dirPath) {
          core.info(`  ${name}: (not set)`)
          continue
        }
        core.info(`\n  ${name} = ${dirPath}`)
        try {
          const entries = fs.readdirSync(dirPath).slice(0, 20) // cap at 20
          entries.forEach(e => core.info(`    ├─ ${e}`))
          if (fs.readdirSync(dirPath).length > 20) core.info('    └─ … (truncated)')
          report.filesystem[name] = { path: dirPath, entries }
        } catch (err) {
          core.info(`    (cannot read: ${err.message})`)
          report.filesystem[name] = { path: dirPath, error: err.message }
        }
      }
    })

    // ─────────────────────────────────────────────────────────────────────────
    // 3. TOOL INVENTORY
    //    Hosted runners pre-install many tools. exec.getExecOutput() captures
    //    stdout/stderr without printing to the log (unlike exec.exec()).
    // ─────────────────────────────────────────────────────────────────────────
    const toolVersions = {}

    await core.group('Available Tools', async () => {
      const tools = [
        { name: 'node',   cmd: 'node',   args: ['--version'] },
        { name: 'npm',    cmd: 'npm',    args: ['--version'] },
        { name: 'git',    cmd: 'git',    args: ['--version'] },
        { name: 'docker', cmd: 'docker', args: ['--version'] },
        { name: 'python', cmd: 'python3',args: ['--version'] },
        { name: 'go',     cmd: 'go',     args: ['version'] },
        { name: 'java',   cmd: 'java',   args: ['-version'] },
        { name: 'gh',     cmd: 'gh',     args: ['--version'] },
        { name: 'jq',     cmd: 'jq',     args: ['--version'] },
        { name: 'curl',   cmd: 'curl',   args: ['--version'] },
      ]

      for (const tool of tools) {
        try {
          // getExecOutput() returns { stdout, stderr, exitCode }
          // Many tools print version to stderr, so we check both
          const result = await exec.getExecOutput(tool.cmd, tool.args, {
            silent: true,
            ignoreReturnCode: true,
          })
          const version = (result.stdout || result.stderr).split('\n')[0].trim()
          toolVersions[tool.name] = version
          core.info(`  ✓ ${tool.name.padEnd(10)} ${version}`)
        } catch {
          toolVersions[tool.name] = 'not found'
          core.info(`  ✗ ${tool.name.padEnd(10)} not found`)
        }
      }

      report.tools = toolVersions
    })

    // ─────────────────────────────────────────────────────────────────────────
    // 4. SYSTEM RESOURCES
    //    Node's built-in `os` module exposes CPU and memory info without needing
    //    to shell out. Hosted runners are typically 2-core / 7GB RAM on Linux.
    // ─────────────────────────────────────────────────────────────────────────
    await core.group('System Resources', async () => {
      const cpus = os.cpus()
      const totalMemMB = Math.round(os.totalmem() / 1024 / 1024)
      const freeMemMB  = Math.round(os.freemem() / 1024 / 1024)
      const uptime     = Math.round(os.uptime())

      core.info(`  Platform:     ${os.platform()} (${os.arch()})`)
      core.info(`  Release:      ${os.release()}`)
      core.info(`  Hostname:     ${os.hostname()}`)
      core.info(`  CPUs:         ${cpus.length}x ${cpus[0]?.model ?? 'unknown'}`)
      core.info(`  Memory:       ${freeMemMB} MB free / ${totalMemMB} MB total`)
      core.info(`  Uptime:       ${uptime}s`)
      core.info(`  Load avg:     ${os.loadavg().map(n => n.toFixed(2)).join(', ')} (1/5/15 min)`)

      report.system = {
        platform: os.platform(),
        arch: os.arch(),
        release: os.release(),
        hostname: os.hostname(),
        cpuCount: cpus.length,
        cpuModel: cpus[0]?.model,
        totalMemMB,
        freeMemMB,
        uptimeSeconds: uptime,
        loadAvg: os.loadavg(),
      }
    })

    // ─────────────────────────────────────────────────────────────────────────
    // 5. NETWORK INFO
    //    Runners have outbound internet access but each job gets its own
    //    network namespace. The interfaces below show what the runner can see.
    // ─────────────────────────────────────────────────────────────────────────
    await core.group('Network Interfaces', async () => {
      const ifaces = os.networkInterfaces()
      const networkReport = {}

      for (const [name, addrs] of Object.entries(ifaces)) {
        const relevant = (addrs || []).filter(a => !a.internal)
        if (relevant.length === 0) continue
        networkReport[name] = relevant.map(a => `${a.address} (${a.family})`)
        core.info(`  ${name}:`)
        relevant.forEach(a => core.info(`    ${a.address}  (${a.family})`))
      }

      report.network = networkReport
    })

    // ─────────────────────────────────────────────────────────────────────────
    // 6. GITHUB_STEP_SUMMARY — Rich markdown output
    //    Writing to GITHUB_STEP_SUMMARY appends markdown to the job summary UI.
    //    @actions/core.summary wraps this with a fluent builder API.
    // ─────────────────────────────────────────────────────────────────────────
    await buildStepSummary(report)

    // ─────────────────────────────────────────────────────────────────────────
    // 7. OUTPUTS
    //    core.setOutput() writes to GITHUB_OUTPUT (a file). Downstream steps
    //    access it via ${{ steps.<id>.outputs.<name> }}.
    // ─────────────────────────────────────────────────────────────────────────
    core.setOutput('runner-os',      process.env.RUNNER_OS ?? os.platform())
    core.setOutput('runner-arch',    process.env.RUNNER_ARCH ?? os.arch())
    core.setOutput('tool-versions',  JSON.stringify(toolVersions))

    // ─────────────────────────────────────────────────────────────────────────
    // 8. ARTIFACT UPLOAD (optional)
    //    @actions/artifact v2 uses DefaultArtifactClient. Artifacts are stored
    //    per workflow run and can be downloaded from the Actions UI or via the
    //    REST API. They're NOT shared between runs (unlike cache).
    // ─────────────────────────────────────────────────────────────────────────
    if (core.getInput('upload-artifact') === 'true') {
      const reportPath = path.join(
        process.env.GITHUB_WORKSPACE ?? process.cwd(),
        'runner-inspect-report.json'
      )
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
      core.info(`\nReport written to: ${reportPath}`)

      // v1 API: artifact.create() returns an ArtifactClient
      const client = artifact.create()
      const artifactName = core.getInput('artifact-name') || 'runner-inspect-report'

      const { artifactName: uploadedName, size } = await client.uploadArtifact(
        artifactName,
        [reportPath],
        process.env.GITHUB_WORKSPACE ?? process.cwd()
      )
      core.info(`Artifact uploaded: name=${uploadedName} size=${size} bytes`)
      core.setOutput('report-path', reportPath)
    }

  } catch (error) {
    // core.setFailed() marks the step as failed AND sets the exit code to 1
    core.setFailed(`runner-inspect failed: ${error.message}`)
  }
}

async function buildStepSummary(report) {
  // The summary builder is a chainable API that writes markdown to GITHUB_STEP_SUMMARY
  await core.summary
    .addHeading('Runner Inspection Report', 1)
    .addRaw(`> Run: \`${report.env?.github?.GITHUB_RUN_ID ?? 'local'}\` | `)
    .addRaw(`Workflow: \`${report.env?.github?.GITHUB_WORKFLOW ?? 'n/a'}\` | `)
    .addRaw(`Runner: \`${report.env?.runner?.RUNNER_NAME ?? os.hostname()}\`\n`)

    // System overview table
    .addHeading('System', 2)
    .addTable([
      [{ data: 'Property', header: true }, { data: 'Value', header: true }],
      ['OS',         report.system?.platform ?? 'unknown'],
      ['Arch',       report.system?.arch ?? 'unknown'],
      ['CPUs',       String(report.system?.cpuCount ?? '?')],
      ['Memory',     `${report.system?.freeMemMB} MB free / ${report.system?.totalMemMB} MB total`],
      ['Hostname',   report.system?.hostname ?? 'unknown'],
    ])

    // Key paths
    .addHeading('Key Paths', 2)
    .addTable([
      [{ data: 'Variable', header: true }, { data: 'Path', header: true }],
      ['GITHUB_WORKSPACE',   report.filesystem?.GITHUB_WORKSPACE?.path ?? '(not set)'],
      ['GITHUB_ACTION_PATH', report.filesystem?.GITHUB_ACTION_PATH?.path ?? '(not set)'],
      ['RUNNER_TOOL_CACHE',  report.filesystem?.RUNNER_TOOL_CACHE?.path ?? '(not set)'],
      ['RUNNER_TEMP',        report.filesystem?.RUNNER_TEMP?.path ?? '(not set)'],
    ])

    // Tool versions
    .addHeading('Tool Versions', 2)
    .addTable([
      [{ data: 'Tool', header: true }, { data: 'Version', header: true }],
      ...Object.entries(report.tools ?? {}).map(([k, v]) => [k, v]),
    ])

    .write()
}

run()
