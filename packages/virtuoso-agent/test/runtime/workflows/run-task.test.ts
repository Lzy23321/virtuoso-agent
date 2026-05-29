import { lstat, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ProcessExecutor, runTask } from "../../../src/index.ts";

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function createTaskFile(task: unknown): Promise<{ dir: string; path: string }> {
	const dir = await mkdtemp(join(tmpdir(), "virtuoso-agent-run-task-"));
	const path = join(dir, "task.json");
	await writeFile(path, JSON.stringify(task), "utf8");
	return { dir, path };
}

async function createSpectreTaskFile(task: unknown): Promise<{ dir: string; path: string }> {
	const created = await createTaskFile(task);
	await writeFile(join(created.dir, "input.scs"), "simulator lang=spectre\n", "utf8");
	return created;
}

async function createSpectreTaskFileWithRelativeInclude(): Promise<{ dir: string; path: string }> {
	const created = await createTaskFile({
		name: "spectre-demo",
		simulation: { backend: "spectre", netlist: "input.scs" },
		safety: { dryRun: true },
	});
	await mkdir(join(created.dir, "pdk", "models", "spectre"), { recursive: true });
	await writeFile(join(created.dir, "pdk", "models", "spectre", "toplevel.scs"), "simulator lang=spectre\n", "utf8");
	await writeFile(
		join(created.dir, "input.scs"),
		'simulator lang=spectre\ninclude "pdk/models/spectre/toplevel.scs" section=top_tt\n',
		"utf8",
	);
	return created;
}

describe("run task workflow", () => {
	it("runs the fake backend and writes job artifacts", async () => {
		const task = await createTaskFile({
			name: "frontend-demo",
			simulation: { backend: "fake" },
			outputs: [{ name: "gain" }],
		});

		const result = await runTask(task.path);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.jobId).toMatch(/^job_\d{14}_frontend_demo_[a-z0-9]{6}$/);
			expect(result.value.backend).toEqual({ name: "fake" });
			expect(result.value.metrics.gain).toBe(0.92);
			expect(await pathExists(result.value.artifacts.task)).toBe(true);
			expect(await pathExists(result.value.artifacts.result)).toBe(true);
			expect(await pathExists(result.value.artifacts.stdout)).toBe(true);
			expect(await pathExists(result.value.artifacts.stderr)).toBe(true);
			expect(JSON.parse(await readFile(result.value.artifacts.metrics, "utf8"))).toEqual({ gain: 0.92 });
			expect(JSON.parse(await readFile(result.value.artifacts.proposal, "utf8"))).toEqual([]);
		}
	});

	it("runs spectre in dry-run mode without calling the executor", async () => {
		let executorCalled = false;
		const executor: ProcessExecutor = {
			async run() {
				executorCalled = true;
				throw new Error("executor should not run");
			},
		};
		const task = await createSpectreTaskFile({
			name: "spectre-demo",
			simulation: { backend: "spectre", netlist: "input.scs" },
			safety: { dryRun: true },
		});

		const result = await runTask(task.path, {
			spectre: { executor },
		});

		expect(result.ok).toBe(true);
		expect(executorCalled).toBe(false);
		if (result.ok) {
			expect(result.value.backend?.name).toBe("spectre");
			expect(result.value.backend?.process?.command).toEqual([
				"spectre",
				"-64",
				"input.scs",
				"+escchars",
				"+log",
				"psf/spectre.out",
				"-format",
				"psfbin",
				"-raw",
				"psf",
				"+preset=mx",
				"+mt",
				"+lqtimeout",
				"900",
				"-maxw",
				"5",
				"-maxn",
				"5",
				"-env",
				"ade",
				"+logstatus",
			]);
			expect(result.value.backend?.process?.dryRun).toBe(true);
			expect(await readFile(result.value.artifacts.inputNetlist, "utf8")).toBe("simulator lang=spectre\n");
			expect(JSON.parse(await readFile(result.value.artifacts.result, "utf8")).backend.process.dryRun).toBe(true);
		}
	});

	it("passes spectre task details to the executor", async () => {
		const task = await createSpectreTaskFile({
			name: "spectre-demo",
			simulation: {
				backend: "spectre",
				netlist: "input.scs",
				spectre: {
					preset: "cx",
					maxWarnings: 7,
					maxNotices: 8,
					additionalArgs: ["+custom"],
				},
			},
		});
		const executor: ProcessExecutor = {
			async run(request) {
				return {
					command: [request.command, ...request.args],
					cwd: request.cwd,
					exitCode: 0,
					stdout: "spectre stdout",
					stderr: "spectre stderr",
					startedAt: "2026-05-29T00:00:00.000Z",
					endedAt: "2026-05-29T00:00:01.000Z",
					dryRun: request.dryRun,
				};
			},
		};

		const result = await runTask(task.path, {
			spectre: {
				spectreBin: "/cad/bin/spectre",
				executor,
			},
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.backend?.process?.command).toEqual([
				"/cad/bin/spectre",
				"-64",
				"input.scs",
				"+escchars",
				"+log",
				"psf/spectre.out",
				"-format",
				"psfbin",
				"-raw",
				"psf",
				"+preset=cx",
				"+mt",
				"+lqtimeout",
				"900",
				"-maxw",
				"7",
				"-maxn",
				"8",
				"-env",
				"ade",
				"+custom",
				"+logstatus",
			]);
			expect(result.value.backend?.process?.cwd).toMatch(/job_\d{14}_spectre_demo_[a-z0-9]{6}$/);
			expect(await readFile(result.value.artifacts.stdout, "utf8")).toBe("spectre stdout");
			expect(await readFile(result.value.artifacts.stderr, "utf8")).toBe("spectre stderr");
			expect(JSON.parse(await readFile(result.value.artifacts.metrics, "utf8"))).toEqual({});
		}
	});

	it("links relative include roots into the spectre job directory", async () => {
		const task = await createSpectreTaskFileWithRelativeInclude();

		const result = await runTask(task.path);

		expect(result.ok).toBe(true);
		if (result.ok) {
			const linkedPdk = await lstat(join(result.value.backend?.process?.cwd ?? "", "pdk"));
			expect(linkedPdk.isSymbolicLink()).toBe(true);
		}
	});

	it("returns spectre process failures", async () => {
		const task = await createSpectreTaskFile({
			name: "spectre-demo",
			simulation: { backend: "spectre", netlist: "input.scs" },
		});
		const executor: ProcessExecutor = {
			async run(request) {
				return {
					command: [request.command, ...request.args],
					cwd: request.cwd,
					exitCode: 1,
					stdout: "",
					stderr: "syntax error",
					startedAt: "2026-05-29T00:00:00.000Z",
					endedAt: "2026-05-29T00:00:01.000Z",
					dryRun: request.dryRun,
				};
			},
		};

		const result = await runTask(task.path, { spectre: { executor } });

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.type).toBe("spectre_process_error");
			expect(result.error.stage).toBe("spectre_run");
			const job = result.error.details?.job as { artifacts: { result: string; stderr: string } };
			expect(await readFile(job.artifacts.stderr, "utf8")).toBe("syntax error");
			expect(JSON.parse(await readFile(job.artifacts.result, "utf8")).error.type).toBe("spectre_process_error");
		}
	});

	it("returns not implemented for ocean backends", async () => {
		const task = await createTaskFile({
			name: "ocean-demo",
			simulation: { backend: "ocean", script: "run.ocn" },
		});

		const result = await runTask(task.path);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.type).toBe("backend_not_implemented");
			expect(result.error.details?.backend).toBe("ocean");
			expect(result.error.details?.job).toBeDefined();
		}
	});
});
