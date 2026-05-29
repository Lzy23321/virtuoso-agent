import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CliIo, runCli } from "../../src/cli/runner.ts";

interface CapturedCliIo extends CliIo {
	stdoutLines: string[];
	stderrLines: string[];
}

function createCapturedIo(): CapturedCliIo {
	const stdoutLines: string[] = [];
	const stderrLines: string[] = [];

	return {
		stdoutLines,
		stderrLines,
		stdout(message) {
			stdoutLines.push(message);
		},
		stderr(message) {
			stderrLines.push(message);
		},
	};
}

async function createTaskFile(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "virtuoso-agent-cli-"));
	const taskPath = join(dir, "task.json");
	await writeFile(
		taskPath,
		JSON.stringify({
			name: "frontend-demo",
			simulation: { backend: "fake" },
			outputs: [{ name: "gain" }],
		}),
		"utf8",
	);
	return taskPath;
}

async function createSpectreTaskFile(): Promise<{ dir: string; path: string }> {
	const dir = await mkdtemp(join(tmpdir(), "virtuoso-agent-cli-"));
	const taskPath = join(dir, "task.json");
	await writeFile(
		taskPath,
		JSON.stringify({
			name: "spectre-demo",
			simulation: { backend: "spectre", netlist: "input.scs" },
		}),
		"utf8",
	);
	await writeFile(join(dir, "input.scs"), "simulator lang=spectre\n", "utf8");
	return { dir, path: taskPath };
}

describe("CLI runner", () => {
	it("prints scaffold status as JSON", async () => {
		const io = createCapturedIo();

		const exitCode = await runCli(["status", "--json"], io);

		expect(exitCode).toBe(0);
		expect(io.stderrLines).toEqual([]);
		const output = JSON.parse(io.stdoutLines[0]);
		expect(output.ok).toBe(true);
		expect(output.value.mode).toBe("scaffold");
		expect(output.value.bridgeConnected).toBe(false);
	});

	it("validates a task file", async () => {
		const io = createCapturedIo();
		const taskPath = await createTaskFile();

		const exitCode = await runCli(["task", "validate", taskPath, "--json"], io);

		expect(exitCode).toBe(0);
		expect(io.stderrLines).toEqual([]);
		const output = JSON.parse(io.stdoutLines[0]);
		expect(output.ok).toBe(true);
		expect(output.value.task.name).toBe("frontend-demo");
		expect(output.value.issues).toEqual([]);
	});

	it("runs a fake task workflow", async () => {
		const io = createCapturedIo();
		const taskPath = await createTaskFile();

		const exitCode = await runCli(["run", taskPath, "--json"], io);

		expect(exitCode).toBe(0);
		expect(io.stderrLines).toEqual([]);
		const output = JSON.parse(io.stdoutLines[0]);
		expect(output.ok).toBe(true);
		expect(output.value.jobId).toMatch(/^job_\d{14}_frontend_demo_[a-z0-9]{6}$/);
		expect(output.value.metrics.gain).toBe(0.92);
		expect(output.value.proposal).toEqual([]);
		expect(output.value.artifacts.result).toMatch(/result\.json$/);
	});

	it("passes spectre dry-run options to runtime", async () => {
		const io = createCapturedIo();
		const task = await createSpectreTaskFile();

		const exitCode = await runCli(["run", task.path, "--json", "--dry-run", "--spectre-bin", "/cad/bin/spectre"], io);

		expect(exitCode).toBe(0);
		expect(io.stderrLines).toEqual([]);
		const output = JSON.parse(io.stdoutLines[0]);
		expect(output.ok).toBe(true);
		expect(output.value.backend.name).toBe("spectre");
		expect(output.value.backend.process.command[0]).toBe("/cad/bin/spectre");
		expect(output.value.backend.process.command).toContain("input.scs");
		expect(output.value.backend.process.command).toContain("psf/spectre.out");
		expect(output.value.backend.process.command).toContain("psf");
		expect(output.value.backend.process.dryRun).toBe(true);
		expect(output.value.artifacts.inputNetlist).toMatch(/input\.scs$/);
		expect(output.value.artifacts.spectreLog).toMatch(/psf\/spectre\.out$/);
	});

	it("allows CLI to override task dry-run for spectre", async () => {
		const io = createCapturedIo();
		const task = await createSpectreTaskFile();

		const exitCode = await runCli(["run", task.path, "--json", "--no-dry-run", "--spectre-bin", "/bin/true"], io);

		expect(exitCode).toBe(0);
		const output = JSON.parse(io.stdoutLines[0]);
		expect(output.ok).toBe(true);
		expect(output.value.backend.process.command[0]).toBe("/bin/true");
		expect(output.value.backend.process.dryRun).toBe(false);
	});

	it("passes jobs-root to runtime", async () => {
		const io = createCapturedIo();
		const taskPath = await createTaskFile();
		const jobsRoot = await mkdtemp(join(tmpdir(), "virtuoso-agent-cli-jobs-"));

		const exitCode = await runCli(["run", taskPath, "--json", "--jobs-root", jobsRoot], io);

		expect(exitCode).toBe(0);
		expect(io.stderrLines).toEqual([]);
		const output = JSON.parse(io.stdoutLines[0]);
		expect(output.ok).toBe(true);
		expect(output.value.artifacts.result.startsWith(jobsRoot)).toBe(true);
	});

	it("reports run option parse errors", async () => {
		const io = createCapturedIo();
		const taskPath = await createTaskFile();

		const exitCode = await runCli(["run", taskPath, "--json", "--spectre-bin"], io);

		expect(exitCode).toBe(1);
		expect(io.stdoutLines).toEqual([]);
		expect(io.stderrLines).toEqual([
			"Error: --spectre-bin requires a value.",
			"Usage:",
			"  vab status --json",
			"  vab task validate <task.json> --json",
			"  vab run <task.json> --json [--dry-run|--no-dry-run] [--spectre-bin <path>] [--jobs-root <dir>]",
		]);
	});

	it("prints usage for unknown commands", async () => {
		const io = createCapturedIo();

		const exitCode = await runCli(["unknown"], io);

		expect(exitCode).toBe(1);
		expect(io.stdoutLines).toEqual([]);
		expect(io.stderrLines).toEqual([
			"Usage:",
			"  vab status --json",
			"  vab task validate <task.json> --json",
			"  vab run <task.json> --json [--dry-run|--no-dry-run] [--spectre-bin <path>] [--jobs-root <dir>]",
		]);
	});
});
