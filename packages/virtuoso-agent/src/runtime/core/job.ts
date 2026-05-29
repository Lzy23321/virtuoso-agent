import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fail, ok, type RuntimeResult } from "./result.ts";

export interface JobArtifacts {
	task: string;
	inputNetlist: string;
	psfDir: string;
	spectreLog: string;
	result: string;
	stdout: string;
	stderr: string;
	metrics: string;
	proposal: string;
}

export interface JobRecord {
	jobId: string;
	jobDir: string;
	artifacts: JobArtifacts;
}

export interface CreateJobRequest {
	taskPath: string;
	taskName: string;
	jobsRoot?: string;
}

export async function createJob(request: CreateJobRequest): Promise<RuntimeResult<JobRecord>> {
	const jobsRoot = request.jobsRoot ?? getDefaultJobsRoot(request.taskPath);
	const jobId = createJobId(request.taskName);
	const jobDir = join(jobsRoot, jobId);
	const artifacts = createJobArtifacts(jobDir);

	try {
		await mkdir(jobDir, { recursive: true });
		await mkdir(artifacts.psfDir, { recursive: true });
		await copyFile(request.taskPath, artifacts.task);
		return ok({ jobId, jobDir, artifacts });
	} catch (error) {
		return fail({
			type: "job_create_error",
			stage: "job_create",
			message: error instanceof Error ? error.message : String(error),
			details: {
				taskPath: request.taskPath,
				jobsRoot,
				jobDir,
			},
		});
	}
}

export async function writeJobJsonArtifact(path: string, value: unknown): Promise<RuntimeResult<void>> {
	try {
		await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		return ok(undefined);
	} catch (error) {
		return fail({
			type: "job_artifact_write_error",
			stage: "job_artifact_write",
			message: error instanceof Error ? error.message : String(error),
			details: { path },
		});
	}
}

export async function writeJobTextArtifact(path: string, value: string): Promise<RuntimeResult<void>> {
	try {
		await writeFile(path, value, "utf8");
		return ok(undefined);
	} catch (error) {
		return fail({
			type: "job_artifact_write_error",
			stage: "job_artifact_write",
			message: error instanceof Error ? error.message : String(error),
			details: { path },
		});
	}
}

function getDefaultJobsRoot(taskPath: string): string {
	return join(dirname(taskPath), ".virtuoso-agent", "jobs");
}

function createJobArtifacts(jobDir: string): JobArtifacts {
	const psfDir = join(jobDir, "psf");
	return {
		task: join(jobDir, "task.json"),
		inputNetlist: join(jobDir, "input.scs"),
		psfDir,
		spectreLog: join(psfDir, "spectre.out"),
		result: join(jobDir, "result.json"),
		stdout: join(jobDir, "stdout.log"),
		stderr: join(jobDir, "stderr.log"),
		metrics: join(jobDir, "metrics.json"),
		proposal: join(jobDir, "proposal.json"),
	};
}

function createJobId(taskName: string): string {
	return `job_${formatTimestamp(new Date())}_${sanitizeJobName(taskName)}_${createRandomSuffix()}`;
}

function formatTimestamp(date: Date): string {
	return date
		.toISOString()
		.replace(/[-:.TZ]/g, "")
		.slice(0, 14);
}

function sanitizeJobName(taskName: string): string {
	const normalized = taskName
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return normalized || "task";
}

function createRandomSuffix(): string {
	return Math.random().toString(36).slice(2, 8);
}
