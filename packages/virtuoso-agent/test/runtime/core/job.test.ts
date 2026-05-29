import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createJob, writeJobJsonArtifact, writeJobTextArtifact } from "../../../src/index.ts";

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

describe("job artifacts", () => {
	it("creates a job directory and copies the input task", async () => {
		const root = await mkdtemp(join(tmpdir(), "virtuoso-agent-job-"));
		const taskPath = join(root, "task.json");
		const jobsRoot = join(root, "jobs");
		await writeFile(taskPath, JSON.stringify({ name: "Frontend Demo" }), "utf8");

		const result = await createJob({
			taskPath,
			taskName: "Frontend Demo",
			jobsRoot,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.jobId).toMatch(/^job_\d{14}_frontend_demo_[a-z0-9]{6}$/);
			expect(result.value.jobDir).toBe(join(jobsRoot, result.value.jobId));
			expect(await readFile(result.value.artifacts.task, "utf8")).toBe(JSON.stringify({ name: "Frontend Demo" }));
			expect(result.value.artifacts.inputNetlist).toBe(join(result.value.jobDir, "input.scs"));
			expect(result.value.artifacts.psfDir).toBe(join(result.value.jobDir, "psf"));
			expect(result.value.artifacts.spectreLog).toBe(join(result.value.jobDir, "psf", "spectre.out"));
			expect(result.value.artifacts.result).toBe(join(result.value.jobDir, "result.json"));
			expect(result.value.artifacts.stdout).toBe(join(result.value.jobDir, "stdout.log"));
			expect(result.value.artifacts.stderr).toBe(join(result.value.jobDir, "stderr.log"));
			expect(result.value.artifacts.metrics).toBe(join(result.value.jobDir, "metrics.json"));
			expect(result.value.artifacts.proposal).toBe(join(result.value.jobDir, "proposal.json"));
			expect(await pathExists(result.value.artifacts.psfDir)).toBe(true);
		}
	});

	it("writes JSON and text artifacts", async () => {
		const root = await mkdtemp(join(tmpdir(), "virtuoso-agent-job-"));
		const jsonPath = join(root, "metrics.json");
		const textPath = join(root, "stdout.log");

		const json = await writeJobJsonArtifact(jsonPath, { gain: 0.92 });
		const text = await writeJobTextArtifact(textPath, "simulation output");

		expect(json.ok).toBe(true);
		expect(text.ok).toBe(true);
		expect(JSON.parse(await readFile(jsonPath, "utf8"))).toEqual({ gain: 0.92 });
		expect(await readFile(textPath, "utf8")).toBe("simulation output");
	});

	it("reports copy failures as job creation errors", async () => {
		const root = await mkdtemp(join(tmpdir(), "virtuoso-agent-job-"));

		const result = await createJob({
			taskPath: join(root, "missing-task.json"),
			taskName: "missing",
			jobsRoot: join(root, "jobs"),
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.type).toBe("job_create_error");
			expect(result.error.stage).toBe("job_create");
		}
	});

	it("returns write failures as artifact write errors", async () => {
		const root = await mkdtemp(join(tmpdir(), "virtuoso-agent-job-"));

		const result = await writeJobTextArtifact(join(root, "missing-dir", "stdout.log"), "output");

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.type).toBe("job_artifact_write_error");
			expect(result.error.stage).toBe("job_artifact_write");
		}
		expect(await pathExists(join(root, "missing-dir", "stdout.log"))).toBe(false);
	});
});
