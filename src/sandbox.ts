import { getSandbox } from '@cloudflare/sandbox';
import { createOpencode } from '@cloudflare/sandbox/opencode';
import type { Config, OpencodeClient } from '@opencode-ai/sdk';
import { Result } from 'better-result';
import { DEFAULT_MODEL, type Env, type AskRequest } from './types';
import { getInstallationToken } from './github';
import { createLogger } from './log';
import { SandboxError, ValidationError } from './errors';

// Retry config for sandbox operations: 3 attempts with exponential backoff starting at 5s.
const RETRY_CONFIG = {
	times: 3,
	delayMs: 5000,
	backoff: 'exponential' as const,
};

// Runs OpenCode in the sandbox for the /ask endpoint.
// Returns a Result with either a readable SSE stream or a domain error.
//
// Flow:
// 1. Clone repo using installation token
// 2. Configure git identity
// 3. Start OpenCode with provided config (SDK handles merging with opencode.json)
// 4. Send prompt to OpenCode
// 5. Stream SSE events back to caller
export async function runAsk(
	env: Env,
	installationId: number,
	request: AskRequest,
): Promise<Result<ReadableStream, SandboxError | ValidationError>> {
	const { id: askId, owner, repo, prompt, agent, model, config } = request;
	const log = createLogger({ owner, repo, ask_id: askId, installation_id: installationId });

	const token = await getInstallationToken(env, installationId);
	const sandboxId = `${owner}-${repo}-${Date.now()}`;
	const sandbox = getSandbox(env.Sandbox, sandboxId);
	const repoUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
	const workDir = '/home/user/workspace';

	// Clone repository
	const cloneResult = await Result.tryPromise(
		{
			try: () => sandbox.gitCheckout(repoUrl, { targetDir: workDir, branch: undefined }),
			catch: (error: unknown) => {
				log.errorWithException('sandbox_clone_failed', error);
				return new SandboxError({ operation: 'gitCheckout', cause: error });
			},
		},
		{ retry: RETRY_CONFIG },
	);

	if (cloneResult.isErr()) {
		return Result.err(cloneResult.error);
	}

	// Configure git identity for any commits OpenCode might make
	const gitConfigResult = await sandbox.exec(
		`git config user.name "bonk[bot]" && git config user.email "bonk[bot]@users.noreply.github.com"`,
		{ cwd: workDir },
	);
	if (!gitConfigResult.success) {
		log.error('sandbox_git_config_failed', { stderr: gitConfigResult.stderr });
	}

	// Configure credential helper for git push
	await sandbox.exec(`git config credential.helper '!f() { echo "username=x-access-token"; echo "password=${token}"; }; f'`, {
		cwd: workDir,
	});

	// Build OpenCode config - SDK merges with project's opencode.json automatically.
	// We only need to set the API key for the opencode provider.
	const opencodeConfig: Config = {
		...config,
		provider: {
			...config?.provider,
			opencode: {
				...config?.provider?.opencode,
				options: {
					...config?.provider?.opencode?.options,
					apiKey: env.OPENCODE_API_KEY,
				},
			},
		},
	};

	// Start OpenCode in sandbox
	const opencodeResult = await Result.tryPromise(
		{
			try: async () => {
				const opencode = await createOpencode<OpencodeClient>(sandbox, { directory: workDir, config: opencodeConfig });
				return opencode.client;
			},
			catch: (error: unknown) => {
				log.errorWithException('sandbox_opencode_start_failed', error);
				return new SandboxError({ operation: 'createOpencode', cause: error });
			},
		},
		{ retry: RETRY_CONFIG },
	);

	if (opencodeResult.isErr()) {
		return Result.err(opencodeResult.error);
	}
	const client = opencodeResult.value;

	// Create session
	const sessionResult = await Result.tryPromise(
		{
			try: () => client.session.create({ body: { title: `Ask: ${owner}/${repo}` }, query: { directory: workDir } }),
			catch: (error: unknown) => {
				log.errorWithException('sandbox_session_create_failed', error);
				return new SandboxError({ operation: 'session.create', cause: error });
			},
		},
		{ retry: RETRY_CONFIG },
	);

	if (sessionResult.isErr()) {
		return Result.err(sessionResult.error);
	}

	if (!sessionResult.value.data) {
		return Result.err(new SandboxError({ operation: 'session.create', cause: new Error('Failed to create OpenCode session') }));
	}

	// Build model config from request or use default
	const modelString = model ?? env.DEFAULT_MODEL ?? DEFAULT_MODEL;
	const [providerID, ...rest] = modelString.split('/');
	const modelID = rest.join('/');

	if (!providerID?.length || !modelID.length) {
		return Result.err(new ValidationError({ message: `Invalid model ${modelString}. Model must be in the format "provider/model".` }));
	}

	// Stream SSE events from the prompt
	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();

	// Helper to write SSE events safely. Returns false if the write failed (e.g., stream closed).
	const sendEvent = async (event: string, data: unknown): Promise<boolean> => {
		try {
			await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
			return true;
		} catch (error) {
			log.errorWithException('sandbox_sse_write_failed', error, { event });
			return false;
		}
	};

	// Run the prompt in the background and stream events
	const sessionId = sessionResult.value.data!.id;
	const sessionLog = log.child({ session_id: sessionId });
	const promptStartTime = Date.now();

	(async () => {
		let success = false;
		try {
			await sendEvent('session', { id: sessionId, askId });

			const promptResultWrapped = await Result.tryPromise(
				() =>
					client.session.prompt({
						path: { id: sessionId },
						query: { directory: workDir },
						body: {
							model: { providerID, modelID },
							agent: agent ?? undefined,
							parts: [{ type: 'text', text: prompt }],
						},
					}),
				{ retry: RETRY_CONFIG },
			);
			if (promptResultWrapped.isErr()) throw promptResultWrapped.error;
			const promptResult = promptResultWrapped.value;

			const parts = promptResult.data?.parts ?? [];
			const textPart = parts.find((p: { type: string }) => p.type === 'text') as { text?: string } | undefined;
			const response = textPart?.text ?? 'No response';

			// Check for changes
			const statusResult = await sandbox.exec('git status --porcelain', { cwd: workDir });
			const hasChanges = statusResult.success && statusResult.stdout.trim().length > 0;

			let changedFiles: string[] = [];
			if (hasChanges) {
				changedFiles = statusResult.stdout
					.trim()
					.split('\n')
					.map((line: string) => line.slice(3).trim())
					.filter((f: string) => f.length > 0);
			}

			await sendEvent('response', {
				text: response,
				changedFiles: changedFiles.length > 0 ? changedFiles : null,
			});

			await sendEvent('done', { success: true });
			success = true;
		} catch (error) {
			sessionLog.errorWithException('sandbox_prompt_failed', error, { duration_ms: Date.now() - promptStartTime });
			// Try to send error event, but don't fail if stream is already closed
			const message = error instanceof Error ? error.message : 'Unknown error';
			await sendEvent('error', { message, askId, sessionId });
		} finally {
			// Log completion with duration
			if (success) {
				sessionLog.info('sandbox_prompt_completed', { duration_ms: Date.now() - promptStartTime });
			}
			// Safely close the writer, ignoring errors if already closed
			try {
				await writer.close();
			} catch (closeError) {
				sessionLog.errorWithException('sandbox_sse_close_failed', closeError);
			}
		}
	})();

	return Result.ok(readable);
}
