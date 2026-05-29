import { copyFile, lstat, mkdir, readFile, symlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { runSpectreNetlist } from "../backends/spectre/runner.ts";
import type { JobArtifacts } from "../core/job.ts";
import { createJob, writeJobJsonArtifact, writeJobTextArtifact } from "../core/job.ts";
import type { ProcessExecutor, ProcessRunResult } from "../core/process-runner.ts";
import { fail, ok, type RuntimeError, type RuntimeResult } from "../core/result.ts";
import { type TaskDocument, validateTaskFile } from "../core/task-schema.ts";

export interface RunTaskResult {
	jobId: string;
	metrics: Record<string, number>;
	proposal: Array<{
		parameter: string;
		oldValue: string | number | boolean;
		newValue: string | number | boolean;
		reason: string;
	}>;
	artifacts: JobArtifacts;
	backend?: {
		name: string;
		process?: ProcessRunResult;
	};
}

export interface RunTaskOptions {
	jobsRoot?: string;
	spectre?: {
		spectreBin?: string;
		dryRun?: boolean;
		timeoutMs?: number;
		executor?: ProcessExecutor;
	};
}

export async function runTask(taskPath: string, options: RunTaskOptions = {}): Promise<RuntimeResult<RunTaskResult>> {
	const validation = await validateTaskFile(taskPath);
	if (!validation.ok) {
		return validation;
	}
	if (validation.value.issues.length > 0) {
		return fail({
			type: "task_schema_error",
			stage: "task_validation",
			message: "Task validation failed.",
			details: { issues: validation.value.issues },
		});
	}

	const job = await createJob({
		taskPath,
		taskName: validation.value.task.name,
		jobsRoot: options.jobsRoot,
	});
	if (!job.ok) {
		return job;
	}

	const backendResult = await runTaskBackend(validation.value.task, taskPath, job.value, options);
	if (!backendResult.ok) {
		const writeResult = await writeRunTaskFailureArtifacts(job.value, backendResult.error);
		if (!writeResult.ok) {
			return writeResult;
		}
		return fail({
			...backendResult.error,
			details: {
				...backendResult.error.details,
				job: job.value,
			},
		});
	}

	const writeResult = await writeRunTaskArtifacts(backendResult.value);
	if (!writeResult.ok) {
		return writeResult;
	}

	return ok(backendResult.value);
}

async function runTaskBackend(
	task: TaskDocument,
	taskPath: string,
	job: { jobId: string; jobDir: string; artifacts: JobArtifacts },
	options: RunTaskOptions,
): Promise<RuntimeResult<RunTaskResult>> {
	const backend = task.simulation?.backend ?? "fake";

	if (backend === "fake") {
		return ok(createFakeRunTaskResult(job));
	}

	if (backend === "spectre") {
		return runSpectreTask(task, taskPath, job, options);
	}

	return fail({
		type: "backend_not_implemented",
		stage: "task_run",
		message: `${backend} backend is not implemented yet.`,
		details: { backend },
	});
}

function createFakeRunTaskResult(job: { jobId: string; artifacts: JobArtifacts }): RunTaskResult {
	return {
		jobId: job.jobId,
		metrics: {
			gain: 0.92,
		},
		proposal: [],
		artifacts: job.artifacts,
		backend: { name: "fake" },
	};
}

async function runSpectreTask(
	task: TaskDocument,
	taskPath: string,
	job: { jobId: string; jobDir: string; artifacts: JobArtifacts },
	options: RunTaskOptions,
): Promise<RuntimeResult<RunTaskResult>> {
	const netlist = task.simulation?.netlist;
	if (!netlist) {
		return fail({
			type: "task_schema_error",
			stage: "task_validation",
			message: "spectre backend requires a netlist path.",
			details: { path: "simulation.netlist" },
		});
	}

	const netlistCopy = await copySpectreInputNetlist(resolveNetlistPath(taskPath, netlist), job.artifacts.inputNetlist);
	if (!netlistCopy.ok) {
		return netlistCopy;
	}
	const includeLinks = await linkRelativeSpectreIncludes(resolveNetlistPath(taskPath, netlist), job.jobDir);
	if (!includeLinks.ok) {
		return includeLinks;
	}

	const spectre = await runSpectreNetlist({
		spectreBin: options.spectre?.spectreBin,
		netlistPath: basename(job.artifacts.inputNetlist),
		workDir: job.jobDir,
		rawDir: relative(job.jobDir, job.artifacts.psfDir),
		logPath: relative(job.jobDir, job.artifacts.spectreLog),
		format: task.simulation?.spectre?.format ?? "psfbin",
		mode64: task.simulation?.spectre?.mode64,
		escchars: task.simulation?.spectre?.escchars,
		preset: task.simulation?.spectre?.preset ?? "mx",
		multithread: task.simulation?.spectre?.multithread,
		lqtimeout: task.simulation?.spectre?.lqtimeout ?? 900,
		maxWarnings: task.simulation?.spectre?.maxWarnings ?? 5,
		maxNotices: task.simulation?.spectre?.maxNotices ?? 5,
		env: task.simulation?.spectre?.env ?? "ade",
		ahdlLibDir: task.simulation?.spectre?.ahdlLibDir,
		logStatus: task.simulation?.spectre?.logStatus,
		additionalArgs: task.simulation?.spectre?.additionalArgs,
		timeoutMs: options.spectre?.timeoutMs,
		dryRun: options.spectre?.dryRun ?? task.safety?.dryRun,
		executor: options.spectre?.executor,
	});
	if (!spectre.ok) {
		return spectre;
	}

	return ok({
		jobId: job.jobId,
		metrics: {},
		proposal: [],
		artifacts: job.artifacts,
		backend: {
			name: "spectre",
			process: spectre.value.process,
		},
	});
}

async function writeRunTaskArtifacts(result: RunTaskResult): Promise<RuntimeResult<void>> {
	const artifactWrites = [
		await writeJobTextArtifact(result.artifacts.stdout, result.backend?.process?.stdout ?? ""),
		await writeJobTextArtifact(result.artifacts.stderr, result.backend?.process?.stderr ?? ""),
		await writeJobJsonArtifact(result.artifacts.metrics, result.metrics),
		await writeJobJsonArtifact(result.artifacts.proposal, result.proposal),
		await writeJobJsonArtifact(result.artifacts.result, result),
	];
	const failedWrite = artifactWrites.find((write) => !write.ok);
	if (failedWrite && !failedWrite.ok) {
		return failedWrite;
	}
	return ok(undefined);
}

async function writeRunTaskFailureArtifacts(
	job: { artifacts: JobArtifacts },
	error: RuntimeError,
): Promise<RuntimeResult<void>> {
	const process = getProcessDetails(error);
	const artifactWrites = [
		await writeJobTextArtifact(job.artifacts.stdout, process?.stdout ?? ""),
		await writeJobTextArtifact(job.artifacts.stderr, process?.stderr ?? ""),
		await writeJobJsonArtifact(job.artifacts.metrics, {}),
		await writeJobJsonArtifact(job.artifacts.proposal, []),
		await writeJobJsonArtifact(job.artifacts.result, { ok: false, error }),
	];
	const failedWrite = artifactWrites.find((write) => !write.ok);
	if (failedWrite && !failedWrite.ok) {
		return failedWrite;
	}
	return ok(undefined);
}

function getProcessDetails(error: RuntimeError): ProcessRunResult | undefined {
	const process = error.details?.process;
	if (!process || typeof process !== "object") {
		return undefined;
	}
	return process as ProcessRunResult;
}

function resolveNetlistPath(taskPath: string, netlistPath: string): string {
	return resolve(dirname(taskPath), netlistPath);
}

async function copySpectreInputNetlist(sourcePath: string, targetPath: string): Promise<RuntimeResult<void>> {
	try {
		await copyFile(sourcePath, targetPath);
		return ok(undefined);
	} catch (error) {
		return fail({
			type: "spectre_input_copy_error",
			stage: "spectre_prepare",
			message: error instanceof Error ? error.message : String(error),
			details: {
				sourcePath,
				targetPath,
			},
		});
	}
}

async function linkRelativeSpectreIncludes(sourceNetlistPath: string, jobDir: string): Promise<RuntimeResult<void>> {
	let sourceText: string;
	try {
		sourceText = await readFile(sourceNetlistPath, "utf8");
	} catch (error) {
		return fail({
			type: "spectre_input_read_error",
			stage: "spectre_prepare",
			message: error instanceof Error ? error.message : String(error),
			details: { sourceNetlistPath },
		});
	}

	const sourceDir = dirname(sourceNetlistPath);
	for (const includePath of collectRelativeIncludeRoots(sourceText)) {
		const sourcePath = join(sourceDir, includePath);
		const targetPath = join(jobDir, includePath);
		const linkResult = await createIncludeSymlink(sourcePath, targetPath);
		if (!linkResult.ok) {
			return linkResult;
		}
	}

	return ok(undefined);
}

function collectRelativeIncludeRoots(sourceText: string): string[] {
	const roots = new Set<string>();
	const includePattern = /^\s*include\s+"([^"]+)"/gm;
	let match = includePattern.exec(sourceText);
	while (match !== null) {
		const includePath = match[1];
		if (isAbsolute(includePath)) {
			match = includePattern.exec(sourceText);
			continue;
		}
		const [root] = includePath.split("/");
		if (root && root !== "." && root !== "..") {
			roots.add(root);
		}
		match = includePattern.exec(sourceText);
	}
	return [...roots];
}

async function createIncludeSymlink(sourcePath: string, targetPath: string): Promise<RuntimeResult<void>> {
	try {
		await lstat(targetPath);
		return ok(undefined);
	} catch {
		// Missing target is expected.
	}

	try {
		await mkdir(dirname(targetPath), { recursive: true });
		await symlink(sourcePath, targetPath);
		return ok(undefined);
	} catch (error) {
		return fail({
			type: "spectre_include_link_error",
			stage: "spectre_prepare",
			message: error instanceof Error ? error.message : String(error),
			details: { sourcePath, targetPath },
		});
	}
}
