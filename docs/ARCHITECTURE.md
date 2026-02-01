# Architecture

## Event Flow Diagrams

### issue_comment Event (GitHub Actions Mode)

```
                    ┌─────────────────────────────────────────────────────────────┐
                    │                    GitHub sends webhook                      │
                    └─────────────────────────────────────────────────────────────┘
                                                 │
                                                 ▼
┌───────────────────────────────────────────────────────────────────────────────────────────────┐
│  POST /webhooks → handleWebhook()                                              [index.ts:462] │
├───────────────────────────────────────────────────────────────────────────────────────────────┤
│  1. verifyWebhook()                  ───ERR──► 401 "Invalid signature"          [github.ts:100]│
│  2. isAllowedOrg()?                  ───NO───► 200 OK (skipped metric)                        │
│  3. SUPPORTED_EVENTS.includes()?     ───NO───► 200 OK (unsupported)                           │
│  4. USER_EVENTS.includes()?          ───YES──► handleUserEvent()                              │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
                                                 │
                                                 ▼
┌───────────────────────────────────────────────────────────────────────────────────────────────┐
│  handleUserEvent() → handleIssueComment()                                      [index.ts:567] │
├───────────────────────────────────────────────────────────────────────────────────────────────┤
│  1. parseIssueCommentEvent()         ───NULL──► return (action != 'created')    [events.ts:47]│
│  2. createLogger().info('issue_comment_received')                                             │
│  3. return (webhook just logs - action handles execution)                                     │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
                                                 │
                                                 ▼
                                    ┌────────────────────────────┐
                                    │  200 OK + emitMetric()     │
                                    └────────────────────────────┘

                    ┌─────────────────────────────────────────────────────────────┐
                    │            GitHub Action workflow triggered                  │
                    │            (runs OpenCode in workflow, not here)             │
                    └─────────────────────────────────────────────────────────────┘
                                                 │
                                                 ▼
┌───────────────────────────────────────────────────────────────────────────────────────────────┐
│  POST /api/github/track (called by action to start tracking)                   [index.ts:284] │
├───────────────────────────────────────────────────────────────────────────────────────────────┤
│  1. validateGitHubOIDCToken()        ───ERR──► 401 (invalid token)             [oidc.ts:64]   │
│  2. extractRepoFromClaims()          ───ERR──► 401 (bad claims)                [oidc.ts:82]   │
│  3. claims match body?               ───NO───► 403 (repo mismatch)                            │
│  4. getInstallationId()              ───ERR──► 404 (not installed)             [oidc.ts:95]   │
│  5. createReaction() (if comment_id) ───ERR──► (silent fail, logged)           [github.ts:169]│
│  6. agent.trackRun()                           (starts Durable Object)         [agent.ts:49]  │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
                                                 │
                                                 ▼
┌───────────────────────────────────────────────────────────────────────────────────────────────┐
│  RepoAgent.trackRun()                                                           [agent.ts:49] │
├───────────────────────────────────────────────────────────────────────────────────────────────┤
│  1. Store run in activeRuns state                                                             │
│  2. schedule(POLL_INTERVAL_SECS, 'checkWorkflowStatus')  (safety net polling)                 │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
                                                 │
              ┌──────────────────────────────────┴─────────────────────────────────┐
              │                                                                    │
              ▼                                                                    ▼
┌─────────────────────────────────────┐            ┌──────────────────────────────────────────────┐
│  PUT /api/github/track              │            │  RepoAgent.checkWorkflowStatus() (scheduled) │
│  (called by action on completion)   │            │  (safety net if action fails to call PUT)    │
│                       [index.ts:382]│            │                                [agent.ts:92] │
├─────────────────────────────────────┤            ├──────────────────────────────────────────────┤
│  1. Validate OIDC token             │            │  1. Run still tracked?                       │
│  2. agent.finalizeRun(status)       │            │     ───NO───► return (already finalized)     │
│                                     │            │  2. Elapsed > MAX_TRACKING_TIME?             │
│                                     │            │     ───YES──► postFailureComment('timeout')  │
│                                     │            │  3. getWorkflowRunStatus()                   │
│                                     │            │     completed? ──► remove from activeRuns    │
│                                     │            │                   if !success: postFailure   │
│                                     │            │     pending? ───► reschedule poll            │
└─────────────────────────────────────┘            └──────────────────────────────────────────────┘
              │                                                                    │
              └──────────────────────────────────┬─────────────────────────────────┘
                                                 │
                                                 ▼
┌───────────────────────────────────────────────────────────────────────────────────────────────┐
│  RepoAgent.finalizeRun()                                                        [agent.ts:69] │
├───────────────────────────────────────────────────────────────────────────────────────────────┤
│  1. Remove from activeRuns (cancels polling)                                                  │
│  2. status != 'success' && status != 'skipped'?                                               │
│     ───YES──► postFailureComment()                                            [agent.ts:148]  │
│     ───NO───► log 'run_completed_no_comment'                                                  │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

### schedule Event (GitHub Actions Mode)

```
                    ┌─────────────────────────────────────────────────────────────┐
                    │                    GitHub sends webhook                      │
                    │                    (cron-triggered workflow)                 │
                    └─────────────────────────────────────────────────────────────┘
                                                 │
                                                 ▼
┌───────────────────────────────────────────────────────────────────────────────────────────────┐
│  POST /webhooks → handleWebhook()                                              [index.ts:462] │
├───────────────────────────────────────────────────────────────────────────────────────────────┤
│  1. verifyWebhook()                  ───ERR──► 401 "Invalid signature"                        │
│  2. isAllowedOrg()?                  ───NO───► 200 OK (skipped metric)                        │
│  3. SUPPORTED_EVENTS.includes()?     ───YES─► continue                                        │
│  4. USER_EVENTS.includes()?          ───NO───► (schedule is repo event)                       │
│  5. handleRepoEvent()                                                                         │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
                                                 │
                                                 ▼
┌───────────────────────────────────────────────────────────────────────────────────────────────┐
│  handleRepoEvent() → handleScheduleEvent()                                     [index.ts:583] │
├───────────────────────────────────────────────────────────────────────────────────────────────┤
│  1. parseScheduleEvent()             ───NULL──► log error, return              [events.ts:237]│
│  2. createLogger().info('schedule_event_received')                                            │
│  3. return (webhook just logs - GitHub Action runs the scheduled task)                        │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
                                                 │
                                                 ▼
                                    ┌────────────────────────────┐
                                    │  200 OK + emitMetric()     │
                                    └────────────────────────────┘

Note: Schedule events don't use /api/github/track - the workflow runs
independently without comment tracking (no issue/PR to comment on).
```

### /ask Endpoint (Direct Sandbox Mode)

```
                    ┌─────────────────────────────────────────────────────────────┐
                    │          POST /ask with Bearer ASK_SECRET                    │
                    │          { owner, repo, prompt, model?, agent?, config? }    │
                    └─────────────────────────────────────────────────────────────┘
                                                 │
                                                 ▼
┌───────────────────────────────────────────────────────────────────────────────────────────────┐
│  app.route('/ask') → bearerAuth middleware                                     [index.ts:88]  │
├───────────────────────────────────────────────────────────────────────────────────────────────┤
│  1. ASK_SECRET configured?           ───NO───► 403 "Ask endpoint is disabled"                 │
│  2. Bearer token valid?              ───NO───► 401 Unauthorized                               │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
                                                 │
                                                 ▼
┌───────────────────────────────────────────────────────────────────────────────────────────────┐
│  ask.post('/')                                                                 [index.ts:100] │
├───────────────────────────────────────────────────────────────────────────────────────────────┤
│  1. Parse JSON body                  ───ERR──► 400 "Invalid JSON body"                        │
│  2. Validate required fields         ───ERR──► 400 "Missing required fields"                  │
│  3. getInstallationId()              ───ERR──► 404 "No installation found"    [oidc.ts:95]    │
│  4. runAsk()                         ───ERR──► 500 (error message)            [sandbox.ts:26] │
│  5. Return SSE stream                                                                         │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
                                                 │
                                                 ▼
┌───────────────────────────────────────────────────────────────────────────────────────────────┐
│  runAsk()                                                                      [sandbox.ts:26]│
├───────────────────────────────────────────────────────────────────────────────────────────────┤
│  1. getInstallationToken()                                                    [github.ts:74]  │
│  2. sandbox.gitCheckout()            ───ERR──► SandboxError('gitCheckout')                    │
│  3. Configure git identity                                                                    │
│  4. createOpencode()                 ───ERR──► SandboxError('createOpencode')                 │
│  5. client.session.create()          ───ERR──► SandboxError('session.create')                 │
│  6. Parse model string               ───ERR──► ValidationError('Invalid model')              │
│  7. Start background prompt streaming                                                         │
│  8. Return readable stream                                                                    │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
                                                 │
                                                 ▼
┌───────────────────────────────────────────────────────────────────────────────────────────────┐
│  Background: stream SSE events                                                                │
├───────────────────────────────────────────────────────────────────────────────────────────────┤
│  1. sendEvent('session', { id, askId })                                                       │
│  2. client.session.prompt()          ───ERR──► sendEvent('error', { message })                │
│  3. Check for git changes                                                                     │
│  4. sendEvent('response', { text, changedFiles })                                             │
│  5. sendEvent('done', { success: true })                                                      │
│  6. writer.close()                                                                            │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Key Design Principles

1. **Webhook handler is minimal**: The `/webhooks` endpoint only logs events and emits metrics. Actual execution happens in GitHub Actions workflows running OpenCode.

2. **Durable Object for state**: `RepoAgent` tracks active workflow runs per repo. It provides a safety net via polling in case the action fails to report completion.

3. **Result types for errors**: Domain errors like `InstallationNotFoundError` are returned via `Result` to distinguish expected failures from unexpected exceptions.

4. **OIDC for authentication**: GitHub Actions authenticate via OIDC token exchange, validated against GitHub's JWKS.
