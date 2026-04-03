/**
 * dynamic-matrix — Action 3
 *
 * WHAT THIS TEACHES:
 *  - How matrix strategies work internally: the runner expands the matrix
 *    object into a list of jobs BEFORE any of them start.
 *  - fromJSON() is a GitHub Actions expression function that parses a JSON
 *    string into an object at expression-evaluation time.
 *  - The two-job pattern required for dynamic matrices:
 *      job-1: generate   → outputs the matrix JSON
 *      job-2: build      → needs: [generate]
 *                          strategy.matrix: ${{ fromJSON(needs.generate.outputs.matrix) }}
 *  - `include` adds extra key/value pairs to specific or all combinations.
 *  - `exclude` removes specific combinations from the full product.
 *  - Why you can't just use expressions directly in matrix values — GitHub
 *    evaluates matrix before running any step in the same job.
 *
 * MATRIX INTERNALS:
 *  Given matrix: { os: [A, B], node-version: [1, 2] }
 *  The runner produces: [{os:A,node:1}, {os:A,node:2}, {os:B,node:1}, {os:B,node:2}]
 *  Each combination becomes an independent parallel job.
 *
 *  `include` entries that match an existing combo extend it with extra keys.
 *  `include` entries that DON'T match any combo are added as new standalone jobs.
 *  `exclude` removes matching combinations from the product.
 */

const core = require('@actions/core')

function run() {
  try {
    // ── Parse inputs ──────────────────────────────────────────────────────────
    const osInput      = core.getInput('os')
    const nodeInput    = core.getInput('node-versions')
    const experimental = core.getInput('include-experimental') === 'true'
    const excludeRaw   = core.getInput('exclude-os-node') || '[]'

    const osList   = osInput.split(',').map(s => s.trim()).filter(Boolean)
    const nodeList = nodeInput.split(',').map(s => s.trim()).filter(Boolean)
    let   excludeList = []

    try {
      excludeList = JSON.parse(excludeRaw)
      if (!Array.isArray(excludeList)) excludeList = []
    } catch {
      core.warning(`exclude-os-node is not valid JSON, ignoring: ${excludeRaw}`)
    }

    // ── Build the matrix object ───────────────────────────────────────────────
    //
    // STRUCTURE:
    //   {
    //     os: [...],             ← axis 1
    //     "node-version": [...], ← axis 2
    //     include: [...],        ← extra combos or extra keys for existing combos
    //     exclude: [...],        ← combos to remove
    //   }
    //
    const include = []
    const exclude = excludeList

    if (experimental) {
      // This entry doesn't match any existing combo (node-version "23-nightly"
      // isn't in nodeList), so it gets added as a NEW standalone job.
      include.push({
        os: 'ubuntu-latest',
        'node-version': '23-nightly',
        experimental: true,
      })
      core.info('Added experimental node 23-nightly combination')
    }

    const matrix = {
      os:             osList,
      'node-version': nodeList,
      ...(include.length > 0 ? { include } : {}),
      ...(exclude.length > 0 ? { exclude } : {}),
    }

    // ── Count combinations (for informational output) ─────────────────────────
    const baseCount  = osList.length * nodeList.length
    const extraCount = include.filter(e => !nodeList.includes(e['node-version'])).length
    const totalCount = baseCount - exclude.length + extraCount

    // ── Log a visual matrix table to the runner log ───────────────────────────
    core.startGroup('Matrix Preview')
    core.info(`  OS list:           ${osList.join(', ')}`)
    core.info(`  Node versions:     ${nodeList.join(', ')}`)
    core.info(`  Base combinations: ${baseCount}`)
    core.info(`  Excluded:          ${exclude.length}`)
    core.info(`  Extra includes:    ${extraCount}`)
    core.info(`  Total jobs:        ${totalCount}`)
    core.info('')
    core.info('  Combinations:')
    for (const os of osList) {
      for (const node of nodeList) {
        const isExcluded = exclude.some(e => e.os === os && e['node-version'] === node)
        const marker = isExcluded ? '✗' : '✓'
        core.info(`    ${marker}  ${os.padEnd(20)} node@${node}`)
      }
    }
    if (experimental) {
      core.info(`    ✓  ubuntu-latest        node@23-nightly  [experimental]`)
    }
    core.endGroup()

    // ── Build step summary ────────────────────────────────────────────────────
    const rows = [
      [{ data: 'OS', header: true }, { data: 'Node Version', header: true }, { data: 'Status', header: true }],
    ]
    for (const os of osList) {
      for (const node of nodeList) {
        const isExcluded = exclude.some(e => e.os === os && e['node-version'] === node)
        rows.push([os, node, isExcluded ? 'excluded' : 'included'])
      }
    }
    if (experimental) {
      rows.push(['ubuntu-latest', '23-nightly', 'experimental'])
    }

    core.summary
      .addHeading('Dynamic Matrix', 1)
      .addRaw(`Generated **${totalCount}** job combinations\n\n`)
      .addTable(rows)
      .addHeading('Matrix JSON', 2)
      .addCodeBlock(JSON.stringify(matrix, null, 2), 'json')
      .write()

    // ── Set outputs ───────────────────────────────────────────────────────────
    //
    // CRITICAL: The value must be valid JSON. fromJSON() in expressions will
    // fail silently (evaluating to null) if the string isn't parseable.
    //
    const matrixJson = JSON.stringify(matrix)
    core.setOutput('matrix', matrixJson)
    core.setOutput('count',  String(totalCount))

    core.info(`\nOutput 'matrix' set (${matrixJson.length} bytes)`)
    core.info(`Output 'count' set to ${totalCount}`)

  } catch (error) {
    core.setFailed(`dynamic-matrix failed: ${error.message}`)
  }
}

run()
