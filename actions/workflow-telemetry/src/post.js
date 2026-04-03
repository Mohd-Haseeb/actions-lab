/**
 * workflow-telemetry — post.js
 *
 * WHAT THIS TEACHES:
 *  - core.getState() reads values saved by pre.js via GITHUB_STATE
 *  - core.setOutput() in post still works — downstream jobs can use it
 *  - @actions/github gives you the Octokit REST client + full event context
 *  - Octokit "upsert" comment pattern: find existing comment → update or create
 *  - @actions/artifact v2 DefaultArtifactClient.uploadArtifact()
 *  - post-if: always() ensures this runs even on job failure
 *
 * OCTOKIT BASICS:
 *  const { context, getOctokit } = require('@actions/github')
 *  const octokit = getOctokit(token)
 *  context.repo    → { owner, repo }
 *  context.payload → the full webhook event payload
 *  context.eventName → 'pull_request', 'push', 'workflow_dispatch', etc.
 */

const core     = require('@actions/core')
const github   = require('@actions/github')
const artifact = require('@actions/artifact')
const fs       = require('fs')
const path     = require('path')

async function post() {
  try {
    // ── Recover state saved by pre.js ────────────────────────────────────────
    //
    // LESSON: pre/post lifecycle only works for PUBLISHED actions (owner/repo@ref).
    // Local actions (./path) do not run pre/post — the runner skips them with a warning.
    // Consequence: core.getState('start_ms') returns '' when pre never ran.
    //
    // Only start_ms truly requires state (it must be captured before steps run).
    // All other metadata is available directly from process.env in both main and post,
    // so we read it from there rather than from state — this is more resilient.
    //
    const startMsRaw = core.getState('start_ms')
    const preRan     = startMsRaw !== ''
    const startMs    = preRan ? parseInt(startMsRaw, 10) : null
    const endMs      = Date.now()
    const durationMs  = startMs !== null ? endMs - startMs : null
    const durationSec = durationMs !== null ? (durationMs / 1000).toFixed(1) : 'unknown (pre hook did not run — local actions do not support pre/post)'

    const meta = {
      // Read directly from process.env — available in all lifecycle phases
      workflow:    process.env.GITHUB_WORKFLOW   ?? '',
      job:         process.env.GITHUB_JOB        ?? '',
      runId:       process.env.GITHUB_RUN_ID     ?? '',
      runNumber:   process.env.GITHUB_RUN_NUMBER ?? '',
      actor:       process.env.GITHUB_ACTOR      ?? '',
      sha:         (process.env.GITHUB_SHA       ?? '').slice(0, 7),
      ref:         process.env.GITHUB_REF        ?? '',
      eventName:   process.env.GITHUB_EVENT_NAME ?? '',
      runnerOs:    process.env.RUNNER_OS         ?? '',
      runnerName:  process.env.RUNNER_NAME       ?? '',
      // start time only available if pre ran
      startIso:    startMs !== null ? new Date(startMs).toISOString() : 'n/a',
      endIso:      new Date(endMs).toISOString(),
      durationMs,
      durationSec: durationMs !== null ? Number((durationMs / 1000).toFixed(1)) : null,
    }

    if (!preRan) {
      core.warning('[telemetry] pre hook did not run (local actions do not support pre/post). Duration unavailable.')
    }

    core.info(`[telemetry] Job finished — duration: ${durationSec}s`)

    // ── Set output (accessible to downstream jobs via needs.<job>.outputs) ───
    core.setOutput('duration-seconds', meta.durationSec ?? 'unknown')

    // ── GITHUB_STEP_SUMMARY ───────────────────────────────────────────────────
    await core.summary
      .addHeading('Workflow Telemetry', 1)
      .addTable([
        [{ data: 'Field',      header: true }, { data: 'Value',       header: true }],
        ['Workflow',   meta.workflow],
        ['Job',        meta.job],
        ['Run #',      meta.runNumber],
        ['Triggered by', meta.actor],
        ['Event',      meta.eventName],
        ['Ref',        meta.ref],
        ['SHA',        meta.sha],
        ['Runner OS',  meta.runnerOs],
        ['Runner',     meta.runnerName],
        ['Started',    meta.startIso],
        ['Ended',      meta.endIso],
        ['Duration',   `**${durationSec}s**`],
      ])
      .write()

    // ── Artifact upload ───────────────────────────────────────────────────────
    if (core.getInput('upload-artifact') !== 'false') {
      const reportPath = path.join(
        process.env.GITHUB_WORKSPACE ?? process.cwd(),
        'telemetry-report.json'
      )
      fs.writeFileSync(reportPath, JSON.stringify(meta, null, 2))

      // v1 API: artifact.create() returns an ArtifactClient
      // Build a safe artifact name — job and runNumber come from env vars now,
      // but sanitize anyway: replace anything not alphanumeric/hyphen/underscore/dot.
      const safeName = `telemetry-${meta.job || 'job'}-${meta.runNumber || meta.runId || 'run'}`
        .replace(/[^a-zA-Z0-9._-]/g, '-')
      const client = artifact.create()
      const { artifactName } = await client.uploadArtifact(
        safeName,
        [reportPath],
        process.env.GITHUB_WORKSPACE ?? process.cwd()
      )
      core.info(`[telemetry] Artifact uploaded: ${artifactName}`)
    }

    // ── PR comment (optional) ─────────────────────────────────────────────────
    //
    // OCTOKIT LESSON:
    //  github.context.eventName tells us what triggered the workflow.
    //  For pull_request events, context.payload.pull_request.number gives the PR number.
    //  We use the REST API to "upsert" a comment (create or update existing one)
    //  so we don't spam the PR with duplicate comments on every push.
    //
    if (core.getInput('comment-on-pr') === 'true' && github.context.eventName === 'pull_request') {
      const token = core.getInput('github-token')
      const octokit = github.getOctokit(token)
      const { owner, repo } = github.context.repo
      const prNumber = github.context.payload.pull_request?.number

      if (!prNumber) {
        core.warning('[telemetry] Could not determine PR number from context')
        return
      }

      // Marker we embed in every comment so we can find and update it later
      const MARKER = '<!-- workflow-telemetry -->'
      const body = [
        MARKER,
        `## Workflow Telemetry`,
        `| Field | Value |`,
        `|-------|-------|`,
        `| Job | \`${meta.job}\` |`,
        `| Duration | **${durationSec}s** |`,
        `| Runner | ${meta.runnerOs} (${meta.runnerName}) |`,
        `| Started | ${meta.startIso} |`,
        `| SHA | \`${meta.sha}\` |`,
      ].join('\n')

      // List existing comments and look for our marker
      const { data: comments } = await octokit.rest.issues.listComments({
        owner, repo, issue_number: prNumber
      })
      const existing = comments.find(c => c.body?.includes(MARKER))

      if (existing) {
        // Update the existing comment instead of creating a new one
        await octokit.rest.issues.updateComment({
          owner, repo, comment_id: existing.id, body
        })
        core.info(`[telemetry] Updated PR comment (id=${existing.id})`)
      } else {
        const { data: created } = await octokit.rest.issues.createComment({
          owner, repo, issue_number: prNumber, body
        })
        core.info(`[telemetry] Created PR comment (id=${created.id})`)
      }
    }

  } catch (error) {
    // Use setFailed in post too — it marks the step as failed
    core.setFailed(`workflow-telemetry post failed: ${error.message}`)
  }
}

post()
