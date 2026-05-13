import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ApiMomInterceptor } from "../index.js";

const execFileAsync = promisify(execFile);

export interface DevEnvPresetOptions {
	/** array of NODE_ENV values to activate in (default: `["development"]`) */
	enabledIn?: string[];
	/** path to claude binary (default: `"claude"`) */
	claudeCommand?: string;
	/** path to gemini binary (default: `"gemini"`) */
	geminiCommand?: string;
	/** URL of local llama.cpp server (default: `"http://localhost:8080"`) */
	llamaServerUrl?: string;
	/** path to GGUF (default: `"~/.cache/qmd/models/hf_ggml-org_embeddinggemma-300M-Q8_0.gguf"`) */
	embeddingModelPath?: string;
	/** `'preflight' | 'skip'` — whether to ping API Mom even on local calls for usage tracking (default `'preflight'`) */
	telemetry?: "preflight" | "skip";
}

/**
 * Opt into "local-first when NODE_ENV=development" routing.
 * Automatically handles `anthropic`, `gemini`, and `embedding` local routing.
 */
export function devEnvPreset(opts: DevEnvPresetOptions = {}): ApiMomInterceptor[] {
	const enabledIn = opts.enabledIn ?? ["development"];
	const currentEnv = process.env.NODE_ENV ?? "development";

	// If we are not in an enabled environment, return no interceptors.
	if (!enabledIn.includes(currentEnv)) {
		return [];
	}

	const claudeCommand = opts.claudeCommand ?? "claude";
	const geminiCommand = opts.geminiCommand ?? "gemini";
	const llamaServerUrl = opts.llamaServerUrl ?? "http://localhost:8080";
	const telemetry = opts.telemetry ?? "preflight";

	async function performPreflight(init: RequestInit, next: (modifiedInit: RequestInit) => Promise<any>): Promise<string | undefined> {
		const bypassTelemetry = process.env.API_MOM_BYPASS_TELEMETRY === "true" || telemetry === "skip";
		if (bypassTelemetry) return undefined;

		const authInit = { ...init, headers: new Headers(init.headers) };
		authInit.headers.set("X-APIMom-Execution-Mode", "local-preflight");
		
		try {
			const authResponse = await next(authInit);
			if (!authResponse.ok) {
				console.warn("[devEnvPreset] Preflight failed:", authResponse.status);
				return undefined; // Still proceed locally if preflight fails? Or maybe not. Let's proceed.
			}
			return authResponse.cost;
		} catch (err) {
			console.warn("[devEnvPreset] Preflight threw an error:", err);
			return undefined;
		}
	}

	async function performPostflight(init: RequestInit, next: (modifiedInit: RequestInit) => Promise<any>, localResult: any) {
		const bypassTelemetry = process.env.API_MOM_BYPASS_TELEMETRY === "true" || telemetry === "skip";
		if (bypassTelemetry) return;

		try {
			const commitInit = { ...init, headers: new Headers(init.headers) };
			commitInit.headers.set("X-APIMom-Execution-Mode", "local-commit");
			commitInit.body = JSON.stringify({ __local_result: localResult });
			await next(commitInit);
		} catch (err) {
			console.warn("[devEnvPreset] Postflight threw an error:", err);
		}
	}

	return [
		// 1. Gemini CLI Interceptor
		{
			match: (service, endpoint) =>
				service === "gemini" && endpoint.includes("gemini-cli-local"),
			handle: async (service, endpoint, init, next) => {
				const payload = JSON.parse(init.body as string);
				const cost = await performPreflight(init, next);

				console.log(`[devEnvPreset] Sending prompt to local Gemini CLI...`);

				const { stdout } = await execFileAsync(geminiCommand, [
					"--prompt",
					payload.prompt,
					"--output-format",
					"json",
				]);
				const localResult = JSON.parse(stdout);

				await performPostflight(init, next, localResult);

				return {
					ok: true,
					status: 200,
					data: localResult,
					headers: new Headers(),
					cost: cost ?? "0.00 (Local)",
				};
			},
		},
		// 2. Claude CLI Interceptor (Anthropic)
		{
			match: (service, endpoint) => service === "anthropic",
			handle: async (service, endpoint, init, next) => {
				const payload = JSON.parse(init.body as string);
				const cost = await performPreflight(init, next);

				console.log(`[devEnvPreset] Sending prompt to local Claude Code SDK...`);

				// Ideally, we would use the actual `@anthropic-ai/claude-code` sdk here.
				// For the preset, we'll shell out to the `claude` binary as a universal fallback.
				// This requires `claude` to accept standard input/output.
				const promptStr = payload.prompt || payload.messages?.map((m: any) => m.content).join("\n") || JSON.stringify(payload);
				
				const { stdout } = await execFileAsync(claudeCommand, [
					"-p",
					promptStr
				]);
				const localResult = { content: [{ text: stdout }] };

				await performPostflight(init, next, localResult);

				return {
					ok: true,
					status: 200,
					data: localResult,
					headers: new Headers(),
					cost: cost ?? "0.00 (Local)",
				};
			},
		},
		// 3. Llama Server Embedding Interceptor
		{
			match: (service, endpoint) => service === "embedding",
			handle: async (service, endpoint, init, next) => {
				const payload = JSON.parse(init.body as string);
				const cost = await performPreflight(init, next);

				console.log(`[devEnvPreset] Sending request to local llama-server...`);

				const llamaReq = await fetch(`${llamaServerUrl}/embedding`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						content: payload.input || payload.text || payload.content
					})
				});

				const localResult = await llamaReq.json();

				await performPostflight(init, next, localResult);

				return {
					ok: llamaReq.ok,
					status: llamaReq.status,
					data: localResult,
					headers: llamaReq.headers,
					cost: cost ?? "0.00 (Local)",
				};
			},
		}
	];
}
