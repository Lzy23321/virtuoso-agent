import { spawn } from "node:child_process";
import { fail, ok, type RuntimeResult } from "./result.ts";

export interface ProcessRunRequest {
	command: string;
	args?: string[];
	cwd: string;
	timeoutMs?: number;
	dryRun?: boolean;
}

export interface ProcessRunResult {
	command: string[];
	cwd: string;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	startedAt: string;
	endedAt: string;
	dryRun: boolean;
}

export interface ProcessExecutor {
	run(request: RequiredProcessRunRequest): Promise<ProcessRunResult>;
}

export interface RunProcessOptions {
	executor?: ProcessExecutor;
}

export type RequiredProcessRunRequest = Required<Pick<ProcessRunRequest, "args" | "dryRun">> &
	Omit<ProcessRunRequest, "args" | "dryRun">;

export async function runProcess(
	request: ProcessRunRequest,
	options: RunProcessOptions = {},
): Promise<RuntimeResult<ProcessRunResult>> {
	const normalized = normalizeProcessRunRequest(request);
	if (normalized.dryRun) {
		return ok(createDryRunProcessResult(normalized));
	}

	const executor = options.executor ?? nodeProcessExecutor;
	try {
		return ok(await executor.run(normalized));
	} catch (error) {
		return fail({
			type: "process_run_error",
			stage: "process_run",
			message: error instanceof Error ? error.message : String(error),
			details: {
				command: [normalized.command, ...normalized.args],
				cwd: normalized.cwd,
			},
		});
	}
}

export function createDryRunProcessResult(request: RequiredProcessRunRequest): ProcessRunResult {
	const timestamp = new Date().toISOString();
	return {
		command: [request.command, ...request.args],
		cwd: request.cwd,
		exitCode: 0,
		stdout: "",
		stderr: "",
		startedAt: timestamp,
		endedAt: timestamp,
		dryRun: true,
	};
}

function normalizeProcessRunRequest(request: ProcessRunRequest): RequiredProcessRunRequest {
	return {
		...request,
		args: request.args ?? [],
		dryRun: request.dryRun ?? false,
	};
}

const nodeProcessExecutor: ProcessExecutor = {
	run(request) {
		return new Promise((resolve) => {
			const startedAt = new Date().toISOString();
			const child = spawn(request.command, request.args, {
				cwd: request.cwd,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			let settled = false;
			let exitFallback: ReturnType<typeof setTimeout> | undefined;

			const finish = (exitCode: number | null) => {
				if (settled) {
					return;
				}
				settled = true;
				if (timeout) {
					clearTimeout(timeout);
				}
				if (exitFallback) {
					clearTimeout(exitFallback);
				}
				child.stdout?.destroy();
				child.stderr?.destroy();
				resolve({
					command: [request.command, ...request.args],
					cwd: request.cwd,
					exitCode,
					stdout,
					stderr,
					startedAt,
					endedAt: new Date().toISOString(),
					dryRun: false,
				});
			};

			const timeout =
				request.timeoutMs === undefined
					? undefined
					: setTimeout(() => {
							child.kill("SIGTERM");
							exitFallback = setTimeout(() => finish(null), 1_000);
						}, request.timeoutMs);

			child.stdout?.setEncoding("utf8");
			child.stderr?.setEncoding("utf8");
			child.stdout?.on("data", (chunk) => {
				stdout += chunk;
			});
			child.stderr?.on("data", (chunk) => {
				stderr += chunk;
			});
			child.on("error", (error) => {
				stderr += error.message;
			});
			child.on("exit", (exitCode) => {
				// Cadence launchers can leave inherited stdout/stderr descriptors open
				// after the process itself exits. Give buffered output a short drain
				// window, then finish even if Node never receives the close event.
				exitFallback = setTimeout(() => finish(exitCode), 250);
			});
			child.on("close", (exitCode) => {
				setTimeout(() => finish(exitCode), 0);
			});
		});
	},
};
