import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

	it("prints a session start dry-run command", async () => {
		const io = createCapturedIo();
		const workDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-cli-session-"));
		const sessionDir = join(workDir, ".session");

		const exitCode = await runCli(
			["session", "start", "--json", "--work-dir", workDir, "--session-dir", sessionDir, "--dry-run"],
			io,
		);

		expect(exitCode).toBe(0);
		expect(io.stderrLines).toEqual([]);
		const output = JSON.parse(io.stdoutLines[0]);
		expect(output.ok).toBe(true);
		expect(output.value.command[0]).toBe("virtuoso");
		expect(output.value.command).toContain("-restore");
		expect(output.value.detached).toBe(true);
		expect(output.value.dryRun).toBe(true);
		expect(output.value.sessionDir).toBe(sessionDir);
	});

	it("starts a dry-run session from an explicit cds.lib", async () => {
		const io = createCapturedIo();
		const workDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-cli-cdslib-"));
		const cdsLib = join(workDir, "cds.lib");
		const sessionDir = join(workDir, ".session");
		await writeFile(cdsLib, "DEFINE worklib ./worklib\n", "utf8");

		const exitCode = await runCli(
			["session", "start", "--json", "--cds-lib", cdsLib, "--session-dir", sessionDir, "--dry-run"],
			io,
		);

		expect(exitCode).toBe(0);
		expect(io.stderrLines).toEqual([]);
		const output = JSON.parse(io.stdoutLines[0]);
		expect(output.ok).toBe(true);
		expect(output.value.cwd).toBe(workDir);
		expect(output.value.cdsLib).toBe(cdsLib);
		expect(output.value.metadataPath).toBe(join(sessionDir, "metadata.json"));
		expect(JSON.parse(await readFile(output.value.metadataPath, "utf8"))).toMatchObject({
			workDir,
			cdsLib,
		});
	});

	it("queues a session cellView show command", async () => {
		const io = createCapturedIo();
		const sessionDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-cli-session-"));

		const exitCode = await runCli(
			[
				"session",
				"cellview",
				"show",
				"--session-dir",
				sessionDir,
				"--lib",
				"ota_lib",
				"--cell",
				"ota_core",
				"--view",
				"schematic",
				"--result-file",
				"show.json",
				"--json",
			],
			io,
		);

		expect(exitCode).toBe(0);
		expect(io.stderrLines).toEqual([]);
		const output = JSON.parse(io.stdoutLines[0]);
		expect(output.ok).toBe(true);
		expect(output.value.commandPath).toBe(join(sessionDir, "commands", "show.il"));
		expect(output.value.resultPath).toBe(join(sessionDir, "results", "show.json"));
	});

	it("prints a cellView open dry-run command", async () => {
		const io = createCapturedIo();

		const exitCode = await runCli(
			["cellview", "open", "--lib", "ota_lib", "--cell", "ota_core", "--view", "schematic", "--json", "--dry-run"],
			io,
		);

		expect(exitCode).toBe(0);
		expect(io.stderrLines).toEqual([]);
		const output = JSON.parse(io.stdoutLines[0]);
		expect(output.ok).toBe(true);
		expect(output.value.process.command[0]).toBe("virtuoso");
		expect(output.value.process.command).toContain("-nograph");
		expect(output.value.process.dryRun).toBe(true);
	});

	it("prints a current cellView dry-run command", async () => {
		const io = createCapturedIo();

		const exitCode = await runCli(["cellview", "current", "--json", "--dry-run"], io);

		expect(exitCode).toBe(0);
		expect(io.stderrLines).toEqual([]);
		const output = JSON.parse(io.stdoutLines[0]);
		expect(output.ok).toBe(true);
		expect(output.value.process.command[0]).toBe("virtuoso");
		expect(output.value.process.command).toContain("-nograph");
		expect(output.value.process.dryRun).toBe(true);
	});

	it("prints an inventory libraries dry-run command", async () => {
		const io = createCapturedIo();

		const exitCode = await runCli(["inventory", "libraries", "--json", "--dry-run"], io);

		expect(exitCode).toBe(0);
		expect(io.stderrLines).toEqual([]);
		const output = JSON.parse(io.stdoutLines[0]);
		expect(output.ok).toBe(true);
		expect(output.value.process.command[0]).toBe("virtuoso");
		expect(output.value.process.command).toContain("-nograph");
		expect(output.value.process.dryRun).toBe(true);
		expect(await readFile(output.value.scriptPath, "utf8")).toContain("vaListLibraries()");
	});

	it("prints an inventory cellViews dry-run command", async () => {
		const io = createCapturedIo();

		const exitCode = await runCli(["inventory", "cellviews", "--lib", "ota_lib", "--json", "--dry-run"], io);

		expect(exitCode).toBe(0);
		expect(io.stderrLines).toEqual([]);
		const output = JSON.parse(io.stdoutLines[0]);
		expect(output.ok).toBe(true);
		expect(output.value.process.command[0]).toBe("virtuoso");
		expect(output.value.process.command).toContain("-nograph");
		expect(output.value.process.dryRun).toBe(true);
		expect(await readFile(output.value.scriptPath, "utf8")).toContain('vaListCellViews("ota_lib")');
	});

	it("reports missing inventory cellViews library", async () => {
		const io = createCapturedIo();

		const exitCode = await runCli(["inventory", "cellviews", "--json"], io);

		expect(exitCode).toBe(1);
		expect(io.stdoutLines).toEqual([]);
		expect(io.stderrLines[0]).toBe("Error: inventory cellviews requires --lib.");
	});

	it("prints a maestro inspect dry-run command", async () => {
		const io = createCapturedIo();

		const exitCode = await runCli(
			[
				"maestro",
				"inspect",
				"--lib",
				"test_tb",
				"--cell",
				"two_stage_amp_tb",
				"--view",
				"maestro",
				"--json",
				"--dry-run",
			],
			io,
		);

		expect(exitCode).toBe(0);
		expect(io.stderrLines).toEqual([]);
		const output = JSON.parse(io.stdoutLines[0]);
		expect(output.ok).toBe(true);
		expect(output.value.process.command).toContain("-nograph");
		expect(await readFile(output.value.scriptPath, "utf8")).toContain(
			'vaInspectMaestro("test_tb" "two_stage_amp_tb" "maestro")',
		);
	});

	it("prints a cellView instances dry-run command", async () => {
		const io = createCapturedIo();

		const exitCode = await runCli(
			[
				"cellview",
				"instances",
				"--lib",
				"ota_lib",
				"--cell",
				"ota_core",
				"--view",
				"schematic",
				"--json",
				"--dry-run",
			],
			io,
		);

		expect(exitCode).toBe(0);
		expect(io.stderrLines).toEqual([]);
		const output = JSON.parse(io.stdoutLines[0]);
		expect(output.ok).toBe(true);
		expect(output.value.process.command[0]).toBe("virtuoso");
		expect(output.value.process.command).toContain("-nograph");
		expect(output.value.process.dryRun).toBe(true);
	});

	it("prints a cellView summary dry-run command", async () => {
		const io = createCapturedIo();

		const exitCode = await runCli(
			[
				"cellview",
				"summary",
				"--lib",
				"ota_lib",
				"--cell",
				"ota_core",
				"--view",
				"schematic",
				"--json",
				"--dry-run",
			],
			io,
		);

		expect(exitCode).toBe(0);
		expect(io.stderrLines).toEqual([]);
		const output = JSON.parse(io.stdoutLines[0]);
		expect(output.ok).toBe(true);
		expect(output.value.process.command[0]).toBe("virtuoso");
		expect(output.value.process.command).toContain("-nograph");
		expect(output.value.process.dryRun).toBe(true);
	});

	it("prints an instance params dry-run command", async () => {
		const io = createCapturedIo();

		const exitCode = await runCli(
			[
				"instance",
				"params",
				"--lib",
				"ota_lib",
				"--cell",
				"ota_core",
				"--view",
				"schematic",
				"--name",
				"M0",
				"--json",
				"--dry-run",
			],
			io,
		);

		expect(exitCode).toBe(0);
		expect(io.stderrLines).toEqual([]);
		const output = JSON.parse(io.stdoutLines[0]);
		expect(output.ok).toBe(true);
		expect(output.value.process.command[0]).toBe("virtuoso");
		expect(output.value.process.command).toContain("-nograph");
		expect(output.value.process.dryRun).toBe(true);
	});

	it("prints a cellView show UI dry-run command", async () => {
		const io = createCapturedIo();

		const exitCode = await runCli(
			[
				"cellview",
				"show",
				"--lib",
				"ota_lib",
				"--cell",
				"ota_core",
				"--view",
				"schematic",
				"--json",
				"--display",
				":1",
				"--xauthority",
				"/run/user/1000/gdm/Xauthority",
				"--dry-run",
			],
			io,
		);

		expect(exitCode).toBe(0);
		expect(io.stderrLines).toEqual([]);
		const output = JSON.parse(io.stdoutLines[0]);
		expect(output.ok).toBe(true);
		expect(output.value.command[0]).toBe("virtuoso");
		expect(output.value.command).toContain("-restore");
		expect(output.value.command).not.toContain("-nograph");
		expect(output.value.detached).toBe(true);
		expect(output.value.dryRun).toBe(true);
	});

	it("reports missing cellView open arguments", async () => {
		const io = createCapturedIo();

		const exitCode = await runCli(["cellview", "open", "--lib", "ota_lib", "--json"], io);

		expect(exitCode).toBe(1);
		expect(io.stdoutLines).toEqual([]);
		expect(io.stderrLines[0]).toBe("Error: cellview open requires --cell.");
	});

	it("reports missing instance params arguments", async () => {
		const io = createCapturedIo();

		const exitCode = await runCli(
			["instance", "params", "--lib", "ota_lib", "--cell", "ota_core", "--view", "schematic", "--json"],
			io,
		);

		expect(exitCode).toBe(1);
		expect(io.stdoutLines).toEqual([]);
		expect(io.stderrLines[0]).toBe("Error: instance params requires --name.");
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
			"  vab session start --json [--cds-lib <path>] [--session-dir <dir>] [--work-dir <dir>] [--display <display>] [--xauthority <path>] [--dry-run] [--include-process-output]",
			"  vab session cellview show --session-dir <dir> --lib <lib> --cell <cell> --view <view> --json [--mode r|a|w] [--include-process-output]",
			"  vab inventory libraries --json [--cds-lib <path>] [--dry-run] [--virtuoso-bin <path>] [--bridge-path <path>] [--include-process-output]",
			"  vab inventory cellviews --lib <lib> --json [--cds-lib <path>] [--dry-run] [--virtuoso-bin <path>] [--bridge-path <path>] [--include-process-output]",
			"  vab maestro inspect --lib <lib> --cell <cell> --view <view> --json [--cds-lib <path>] [--dry-run] [--include-process-output]",
			"  vab cellview open --lib <lib> --cell <cell> --view <view> --json [--cds-lib <path>] [--mode r|a|w] [--dry-run] [--include-process-output]",
			"  vab cellview current --json [--cds-lib <path>] [--dry-run] [--include-process-output]",
			"  vab cellview instances --lib <lib> --cell <cell> --view <view> --json [--cds-lib <path>] [--mode r|a|w] [--dry-run] [--include-process-output]",
			"  vab cellview summary --lib <lib> --cell <cell> --view <view> --json [--cds-lib <path>] [--mode r|a|w] [--dry-run] [--include-process-output]",
			"  vab cellview show --lib <lib> --cell <cell> --view <view> --json [--cds-lib <path>] [--mode r|a|w] [--display <display>] [--xauthority <path>] [--dry-run] [--include-process-output]",
			"  vab instance params --lib <lib> --cell <cell> --view <view> --name <instance> --json [--cds-lib <path>] [--mode r|a|w] [--dry-run] [--include-process-output]",
			"  vab task validate <task.json> --json",
			"  vab run <task.json> --json [--dry-run|--no-dry-run] [--spectre-bin <path>] [--jobs-root <dir>] [--include-process-output]",
		]);
	});

	it("prints usage for unknown commands", async () => {
		const io = createCapturedIo();

		const exitCode = await runCli(["unknown"], io);

		expect(exitCode).toBe(1);
		expect(io.stdoutLines).toEqual([]);
		expect(io.stderrLines).toEqual([
			"Usage:",
			"  vab session start --json [--cds-lib <path>] [--session-dir <dir>] [--work-dir <dir>] [--display <display>] [--xauthority <path>] [--dry-run] [--include-process-output]",
			"  vab session cellview show --session-dir <dir> --lib <lib> --cell <cell> --view <view> --json [--mode r|a|w] [--include-process-output]",
			"  vab inventory libraries --json [--cds-lib <path>] [--dry-run] [--virtuoso-bin <path>] [--bridge-path <path>] [--include-process-output]",
			"  vab inventory cellviews --lib <lib> --json [--cds-lib <path>] [--dry-run] [--virtuoso-bin <path>] [--bridge-path <path>] [--include-process-output]",
			"  vab maestro inspect --lib <lib> --cell <cell> --view <view> --json [--cds-lib <path>] [--dry-run] [--include-process-output]",
			"  vab cellview open --lib <lib> --cell <cell> --view <view> --json [--cds-lib <path>] [--mode r|a|w] [--dry-run] [--include-process-output]",
			"  vab cellview current --json [--cds-lib <path>] [--dry-run] [--include-process-output]",
			"  vab cellview instances --lib <lib> --cell <cell> --view <view> --json [--cds-lib <path>] [--mode r|a|w] [--dry-run] [--include-process-output]",
			"  vab cellview summary --lib <lib> --cell <cell> --view <view> --json [--cds-lib <path>] [--mode r|a|w] [--dry-run] [--include-process-output]",
			"  vab cellview show --lib <lib> --cell <cell> --view <view> --json [--cds-lib <path>] [--mode r|a|w] [--display <display>] [--xauthority <path>] [--dry-run] [--include-process-output]",
			"  vab instance params --lib <lib> --cell <cell> --view <view> --name <instance> --json [--cds-lib <path>] [--mode r|a|w] [--dry-run] [--include-process-output]",
			"  vab task validate <task.json> --json",
			"  vab run <task.json> --json [--dry-run|--no-dry-run] [--spectre-bin <path>] [--jobs-root <dir>] [--include-process-output]",
		]);
	});
});
