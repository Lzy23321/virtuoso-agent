import { type ProcessExecutor, type ProcessRunResult, runProcess } from "../../core/process-runner.ts";
import { fail, ok, type RuntimeResult } from "../../core/result.ts";

export interface SpectreRunRequest {
	spectreBin?: string;
	netlistPath: string;
	workDir: string;
	rawDir?: string;
	logPath?: string;
	format?: "psfbin" | "psfxl";
	mode64?: boolean;
	escchars?: boolean;
	preset?: string;
	multithread?: boolean;
	lqtimeout?: number;
	maxWarnings?: number;
	maxNotices?: number;
	env?: string;
	ahdlLibDir?: string;
	logStatus?: boolean;
	additionalArgs?: string[];
	timeoutMs?: number;
	dryRun?: boolean;
	executor?: ProcessExecutor;
}

export interface SpectreRunResult {
	backend: "spectre";
	process: ProcessRunResult;
}

export async function runSpectreNetlist(request: SpectreRunRequest): Promise<RuntimeResult<SpectreRunResult>> {
	const command = request.spectreBin ?? "spectre";
	const processResult = await runProcess(
		{
			command,
			args: buildSpectreArgs(request),
			cwd: request.workDir,
			timeoutMs: request.timeoutMs,
			dryRun: request.dryRun,
		},
		{ executor: request.executor },
	);

	if (!processResult.ok) {
		return processResult;
	}

	if (processResult.value.exitCode !== 0) {
		return fail({
			type: "spectre_process_error",
			stage: "spectre_run",
			message: `Spectre exited with code ${processResult.value.exitCode}.`,
			details: { process: processResult.value },
		});
	}

	return ok({
		backend: "spectre",
		process: processResult.value,
	});
}

function buildSpectreArgs(request: SpectreRunRequest): string[] {
	const args: string[] = [];
	if (request.mode64 ?? true) {
		args.push("-64");
	}
	args.push(request.netlistPath);
	if (request.escchars ?? true) {
		args.push("+escchars");
	}
	if (request.logPath) {
		args.push("+log", request.logPath);
	}
	if (request.format) {
		args.push("-format", request.format);
	}
	if (request.rawDir) {
		args.push("-raw", request.rawDir);
	}
	if (request.preset) {
		args.push(`+preset=${request.preset}`);
	}
	if (request.multithread ?? true) {
		args.push("+mt");
	}
	if (request.lqtimeout !== undefined) {
		args.push("+lqtimeout", String(request.lqtimeout));
	}
	if (request.maxWarnings !== undefined) {
		args.push("-maxw", String(request.maxWarnings));
	}
	if (request.maxNotices !== undefined) {
		args.push("-maxn", String(request.maxNotices));
	}
	if (request.env) {
		args.push("-env", request.env);
	}
	if (request.ahdlLibDir) {
		args.push("-ahdllibdir", request.ahdlLibDir);
	}
	args.push(...(request.additionalArgs ?? []));
	if (request.logStatus ?? true) {
		args.push("+logstatus");
	}
	return args;
}
