# Cloudflare deployment

The maintained deployment targets:

- Cloudflare account: `e29a829100e2bcccedf6027e4a970cb2`
- Worker name: `ask-bonk`
- URL: `https://ask-bonk.cloudflare-exponent.workers.dev`
- GitHub webhook URL: `https://ask-bonk.cloudflare-exponent.workers.dev/channels/github/webhook`

`wrangler.jsonc` is the source configuration. `bun run build` uses Wrangler to validate and write a
dry-run Worker bundle under `dist/ask_bonk`.

Cloudflare Workers Builds must also deploy from the source configuration:

- Production deploy command: `bunx wrangler deploy --config wrangler.jsonc`
- Preview deploy command:
  `bunx wrangler deploy --dry-run --config wrangler.jsonc --var BONK_VERSION:ci --var BONK_COMMIT:$WORKERS_CI_COMMIT_SHA`

Keep previews on `deploy --dry-run` while a Durable Object migration is pending.
Wrangler rejects `versions upload` for Workers with unapplied migrations. After the
production deploy applies the migration, previews can return to `versions upload`.

Do not point Workers Builds at the retired `dist/ask_bonk/wrangler.json` Flue artifact.

## Credentials and secrets

### Cloudflare deployment credential

Wrangler needs authentication for the target account. For a local interactive deployment, run
`bunx wrangler login`. For CI or non-interactive deployment, set `CLOUDFLARE_API_TOKEN` in the
deployment environment.

The deployment token is not a Worker secret. Scope it to account
`e29a829100e2bcccedf6027e4a970cb2` with these account permissions:

- Workers Scripts: Edit
- Workers KV Storage: Edit

### Required Worker secrets

These are declared in `wrangler.jsonc` and must exist before a deployment can succeed:

| Secret                   | Source                                            | Notes                                                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GITHUB_APP_ID`          | GitHub App settings                               | An identifier, not a secret. The existing `ask-bonk` App ID is `2454580`; reuse it while retaining that App.                                                                                                       |
| `GITHUB_APP_PRIVATE_KEY` | Generate a private key in the GitHub App settings | Upload an unencrypted PKCS#8 PEM whose header is `-----BEGIN PRIVATE KEY-----`. If the downloaded key uses `-----BEGIN RSA PRIVATE KEY-----`, convert it through `openssl pkcs8` while streaming it into Wrangler. |
| `GITHUB_WEBHOOK_SECRET`  | Generate a new high-entropy value                 | Configure the same value in the GitHub App webhook settings and the Worker secret.                                                                                                                                 |

The application does not use a GitHub OAuth client secret, OAuth callback URL, personal access
token, or static GitHub API key.

Do not recreate these legacy personal-account Worker secrets:

- `ASK_SECRET`: removed with the old `/ask` endpoint.
- `ANTHROPIC_API_KEY`: the Worker does not call Anthropic; consumer repositories supply their own
  model credentials.
- `CLOUDFLARE_ACCOUNT_ID`: configured as a non-secret Worker variable in `wrangler.jsonc`.

`ANALYTICS_TOKEN` is the only optional Worker secret.

### Optional stats credential

The public `/stats` endpoints query Analytics Engine through the Cloudflare API.
`CLOUDFLARE_ACCOUNT_ID` is committed as a non-secret Worker variable. To enable `/stats`, create a
separate read-only Cloudflare API token and set it as the Worker secret `ANALYTICS_TOKEN`. If it is
absent, the rest of the Worker still runs but `/stats` returns a configuration error.

### Consumer repository secrets

These are not deployment credentials for the Worker. Repositories using the Bonk action still need
their model-provider credentials, such as `OPENCODE_API_KEY` or the three Cloudflare AI Gateway
values documented in the main README.

## GitHub App configuration

Create a new GitHub App only if the existing `ask-bonk` app cannot remain in use. Otherwise, keep
the existing app, generate a new private key, rotate the webhook secret, and update its webhook URL.

Repository permissions:

- Actions: Read-only
- Contents: Read and write
- Issues: Read and write
- Metadata: Read-only
- Pull requests: Read and write
- Workflows: Read and write

Subscribe to these webhook events:

- Issue comments
- Pull request review comments
- Pull request reviews
- Workflow runs

Use `https://ask-bonk.cloudflare-exponent.workers.dev/channels/github/webhook` for new
configurations. The legacy `/webhooks` endpoint remains available for an existing app during the
migration, but it should not be used for a new configuration.

After deployment, install the GitHub App on each allowed owner or repository. Installation IDs are
looked up through the GitHub API and cached in the new account's `APP_INSTALLATIONS` KV namespace;
the old KV contents do not need to be copied.

### Existing App cutover

The webhook URL and secret belong to the GitHub App registration, not to each installation. Existing
repository and organization installations do not need to be reinstalled or updated.

The action's OIDC endpoint is separate from the GitHub App webhook. Consumer workflows that use
`ask-bonk/ask-bonk/github@main` inherit the new default after this repository change merges.
Workflows pinned to an older tag or commit continue calling the personal-account Worker unless they
set:

```yaml
with:
  oidc_base_url: https://ask-bonk.cloudflare-exponent.workers.dev/auth
```

Keep the personal-account Worker available until active pinned workflows have migrated.

Use this order to avoid interrupting current deliveries:

1. Generate a new GitHub App private key. Keep the existing private key active for the old Worker.
2. Set the new private key and a new webhook secret on the target-account Worker.
3. Deploy and verify the target Worker before directing GitHub traffic to it.
4. In one GitHub App settings update, change both the webhook URL to the canonical target URL and
   the webhook secret to the value already stored on the target Worker.
5. Send a GitHub test delivery and confirm a successful response.
6. After the webhook cutover is stable and pinned OIDC callers have migrated, remove the old GitHub
   App private key and retire the personal-account Worker.

Do not replace the personal-account Worker's webhook secret before the GitHub App cutover. Until the
App setting changes, GitHub deliveries are still signed with the old secret and the old Worker must
continue accepting it. If the personal-account Worker should remain available as a rollback target,
set the new secret on it only after the cutover succeeds.

## Cloudflare resources

- `APP_INSTALLATIONS`: existing target-account KV namespace
  `8209c24d2f364196b1cdbad3654694f1`. The personal-account namespace is not reused.
- `REPO_AGENT`: created from the migrations in `wrangler.jsonc`. The Flue beta registry,
  control-plane agent, and workflow Durable Object classes are retired by migration `v8`;
  `RepoAgent` state is not affected.
- `BONK_EVENTS`: Analytics Engine dataset binding. New metrics start in the target account; old
  metrics are not migrated.
- `RATE_LIMITER`: account-local rate-limit binding. No key material is required.

## First deployment

1. Authenticate Wrangler against the target account:

   ```bash
   bunx wrangler login
   bunx wrangler whoami
   ```

2. Set each Worker secret directly through Wrangler. Wrangler prompts for single-line values
   without putting them in shell history:

   ```bash
   bunx wrangler secret put GITHUB_APP_ID --config wrangler.jsonc
   bunx wrangler secret put GITHUB_WEBHOOK_SECRET --config wrangler.jsonc
   ```

   Paste `2454580` for `GITHUB_APP_ID`. Paste the new high-entropy webhook value for
   `GITHUB_WEBHOOK_SECRET`, then configure that same value in the GitHub App webhook settings.

   If the downloaded App key has a `-----BEGIN RSA PRIVATE KEY-----` header, it is PKCS#1. The
   GitHub App JWT library used by the Worker requires PKCS#8. Convert the key in memory and stream
   the PKCS#8 PEM directly into Wrangler:

   ```bash
   openssl pkcs8 -topk8 -nocrypt \
     -in ~/Downloads/ask-bonk.private-key.pem |
     bunx wrangler secret put GITHUB_APP_PRIVATE_KEY --config wrangler.jsonc
   ```

   Do not upload the downloaded PKCS#1 file directly. It passes `openssl rsa -check`, but runtime
   authentication fails with `Private Key is in PKCS#1 format, but only PKCS#8 is supported`.
   Protect and remove the downloaded private-key file after Wrangler confirms the upload.

   To enable `/stats`, also set the optional read-only token:

   ```bash
   bunx wrangler secret put ANALYTICS_TOKEN --config wrangler.jsonc
   ```

   Confirm only the secret names:

   ```bash
   bunx wrangler secret list --config wrangler.jsonc
   ```

3. Validate without changing remote state:

   ```bash
   bun install --frozen-lockfile
   bun run tsc --noEmit
   bun run test
   bun run lint
   bun run build
   bunx wrangler types --check
   bunx wrangler deploy --dry-run --config wrangler.jsonc \
     --var BONK_VERSION:ci \
     --var BONK_COMMIT:local
   ```

4. After all required Worker secrets exist, deploy the code:

   ```bash
   bunx wrangler deploy --config wrangler.jsonc \
     --var BONK_VERSION:"$(git describe --tags --always)" \
     --var BONK_COMMIT:"$(git rev-parse --short HEAD)"
   ```

5. In the GitHub App settings, set the webhook URL to the canonical URL above and use the same
   webhook secret.

6. Verify:

   ```bash
   curl --fail https://ask-bonk.cloudflare-exponent.workers.dev/health
   curl --fail https://ask-bonk.cloudflare-exponent.workers.dev/version
   ```

   Send a webhook test delivery from GitHub and confirm it receives a successful response before
   removing the personal-account deployment.
