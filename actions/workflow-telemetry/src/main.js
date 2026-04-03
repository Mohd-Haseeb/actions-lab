/**
 * workflow-telemetry — main.js
 *
 * WHAT THIS TEACHES:
 *  - main is required by the actions runtime even when you only care about
 *    pre/post. It's fine for main to be a no-op.
 *  - The runner executes: pre → [all job steps] → main → post
 *    But you can think of main as running "after all steps" for most intents.
 *
 * We just emit a log line so you can see where main.js fires relative to
 * your other job steps in the Actions log.
 */

const core = require('@actions/core')

function main() {
  core.info('[telemetry] main.js — all job steps complete, post.js will compute timing')
}

main()
