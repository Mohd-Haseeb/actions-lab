/**
 * workflow-telemetry — pre.js
 *
 * WHAT THIS TEACHES:
 *  - The pre/post lifecycle: `pre` runs before any step in the job.
 *  - core.saveState(key, value) writes to GITHUB_STATE (a file), making the
 *    value available in post.js via core.getState(key).
 *  - Each of pre/main/post runs as its own separate Node.js process.
 *    saveState/getState is the ONLY IPC mechanism between them.
 *
 * HOW THE LIFECYCLE WORKS:
 *  Job starts
 *    └─ pre.js runs           ← we record start time here
 *    └─ step 1 runs
 *    └─ step 2 runs
 *    └─ ... all steps ...
 *    └─ main.js runs          ← no-op for us
 *    └─ post.js runs          ← we compute duration here
 *  Job ends
 *
 * NOTE: GITHUB_STATE is a file path. @actions/core wraps it with
 * saveState/getState so you don't have to write to it directly.
 */

const core = require('@actions/core')

function pre() {
  const startMs = Date.now()

  // saveState() writes "key=value\n" to the file at GITHUB_STATE.
  // This file is read by the runner and made available to post.js.
  core.saveState('start_ms',      String(startMs))
  core.saveState('workflow',      process.env.GITHUB_WORKFLOW ?? '')
  core.saveState('job',           process.env.GITHUB_JOB ?? '')
  core.saveState('run_id',        process.env.GITHUB_RUN_ID ?? '')
  core.saveState('run_number',    process.env.GITHUB_RUN_NUMBER ?? '')
  core.saveState('actor',         process.env.GITHUB_ACTOR ?? '')
  core.saveState('sha',           process.env.GITHUB_SHA ?? '')
  core.saveState('ref',           process.env.GITHUB_REF ?? '')
  core.saveState('event_name',    process.env.GITHUB_EVENT_NAME ?? '')
  core.saveState('runner_os',     process.env.RUNNER_OS ?? '')
  core.saveState('runner_name',   process.env.RUNNER_NAME ?? '')

  core.info(`[telemetry] Job started at ${new Date(startMs).toISOString()}`)
  core.info(`[telemetry] Timing ${process.env.GITHUB_JOB} in workflow "${process.env.GITHUB_WORKFLOW}"`)
}

pre()
