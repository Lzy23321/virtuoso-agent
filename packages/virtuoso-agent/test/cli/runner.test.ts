import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CliIo, runCli } from "../../src/cli/runner.ts";
import { registerManagedVirtuosoInstance } from "../../src/index.ts";

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

interface ManagedCliSession {
	instanceId: string;
	registryDir: string;
	sessionDir: string;
	commandDir: string;
	resultDir: string;
}

async function createManagedCliSession(): Promise<ManagedCliSession> {
	const workDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-cli-managed-"));
	const registryDir = join(workDir, "registry");
	const sessionDir = join(workDir, "session");
	const commandDir = join(sessionDir, "commands");
	const resultDir = join(sessionDir, "results");
	const processedDir = join(sessionDir, "processed");
	const readyPath = join(sessionDir, "ready.json");
	const heartbeatPath = join(sessionDir, "heartbeat.json");
	const cdsLib = join(workDir, "cds.lib");
	await mkdir(commandDir, { recursive: true });
	await mkdir(resultDir, { recursive: true });
	await mkdir(processedDir, { recursive: true });
	await writeFile(cdsLib, "", "utf8");
	await writeFile(readyPath, '{"state":"ready"}\n', "utf8");
	await writeFile(heartbeatPath, '{"heartbeatAt":"now"}\n', "utf8");
	const instanceId = "vui-cli-test";
	const registered = await registerManagedVirtuosoInstance(
		{
			protocolVersion: 1,
			instanceId,
			pid: process.pid,
			processStartedAt: new Date().toISOString(),
			mode: "ui",
			state: "ready",
			cwd: workDir,
			cdsLib,
			display: ":1",
			sessionDir,
			commandDir,
			resultDir,
			processedDir,
			readyPath,
			heartbeatPath,
			bridgePath: join(workDir, "skill-runtime", "bridge.il"),
		},
		registryDir,
	);
	expect(registered.ok).toBe(true);
	return { instanceId, registryDir, sessionDir, commandDir, resultDir };
}

async function runManagedCliCommand(
	args: string[],
	value: unknown,
	expectedExpression: string,
): Promise<{ exitCode: number; io: CapturedCliIo; output: Record<string, unknown> }> {
	const session = await createManagedCliSession();
	const io = createCapturedIo();
	const execution = runCli(
		[
			...args,
			"--instance-id",
			session.instanceId,
			"--registry-dir",
			session.registryDir,
			"--timeout-ms",
			"2000",
			"--json",
		],
		io,
	);

	let responded = false;
	for (let attempt = 0; attempt < 100; attempt++) {
		const commandName = (await readdir(session.commandDir)).find((name) => name.endsWith(".il"));
		if (commandName) {
			const command = await readFile(join(session.commandDir, commandName), "utf8");
			expect(command).toContain(expectedExpression);
			await writeFile(
				join(session.resultDir, commandName.replace(/\.il$/, ".json")),
				`${JSON.stringify({ ok: true, value })}\n`,
				"utf8",
			);
			responded = true;
			break;
		}
		await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
	}
	expect(responded).toBe(true);

	const exitCode = await execution;
	const output = JSON.parse(io.stdoutLines[0]) as Record<string, unknown>;
	return { exitCode, io, output };
}

describe("CLI runner", () => {
	it("prints help successfully", async () => {
		const io = createCapturedIo();

		const exitCode = await runCli(["--help"], io);

		expect(exitCode).toBe(0);
		expect(io.stderrLines).toEqual([]);
		expect(io.stdoutLines[0]).toBe("Usage:");
		expect(io.stdoutLines).toContain("  vab session list --json [--registry-dir <dir>]");
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

	it("opens a cellView through the existing managed UI", async () => {
		const { exitCode, output } = await runManagedCliCommand(
			["cellview", "open", "--lib", "ota_lib", "--cell", "ota_core", "--view", "schematic"],
			{ library: "ota_lib", cell: "ota_core", view: "schematic", mode: "r", visible: true },
			'vaSessionShowCellView("ota_lib" "ota_core" "schematic" "r"',
		);

		expect(exitCode).toBe(0);
		expect(output.ok).toBe(true);
		expect(output.value).toMatchObject({ value: { visible: true } });
	});

	it("rejects one-shot dry-run options for cellView open", async () => {
		const io = createCapturedIo();

		const exitCode = await runCli(
			["cellview", "open", "--lib", "ota_lib", "--cell", "ota_core", "--view", "schematic", "--json", "--dry-run"],
			io,
		);

		expect(exitCode).toBe(1);
		expect(io.stdoutLines).toEqual([]);
		expect(io.stderrLines[0]).toBe("Error: Unknown managed Virtuoso option: --dry-run");
	});

	it("reports when cellView open has no managed session", async () => {
		const io = createCapturedIo();
		const workDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-cli-no-session-"));

		const exitCode = await runCli(
			[
				"cellview",
				"open",
				"--lib",
				"ota_lib",
				"--cell",
				"ota_core",
				"--view",
				"schematic",
				"--registry-dir",
				join(workDir, "registry"),
				"--json",
			],
			io,
		);

		expect(exitCode).toBe(1);
		const output = JSON.parse(io.stdoutLines[0]);
		expect(output.error.type).toBe("managed_instance_not_found");
		expect(output.error.message).toContain("vab session start");
	});

	it("lists managed sessions without launching Virtuoso", async () => {
		const session = await createManagedCliSession();
		const io = createCapturedIo();

		const exitCode = await runCli(["session", "list", "--registry-dir", session.registryDir, "--json"], io);

		expect(exitCode).toBe(0);
		const output = JSON.parse(io.stdoutLines[0]);
		expect(output.value).toHaveLength(1);
		expect(output.value[0].instanceId).toBe(session.instanceId);
	});

	it("reads the current cellView through a managed session", async () => {
		const { exitCode, io, output } = await runManagedCliCommand(
			["cellview", "current"],
			{ library: "ota_lib", cell: "ota_core", view: "schematic", mode: "r" },
			"vaSessionGetCurrentCellView(",
		);

		expect(exitCode).toBe(0);
		expect(io.stderrLines).toEqual([]);
		expect(output.ok).toBe(true);
		expect(output.value).toMatchObject({
			instance: { instanceId: "vui-cli-test" },
			value: { cell: "ota_core" },
		});
	});

	it("reads inventory through a managed session", async () => {
		const { exitCode, output } = await runManagedCliCommand(
			["inventory", "libraries"],
			{
				counts: { libraries: 1, cells: 1, views: 1 },
				libraries: [{ name: "ota_lib", path: "/work/ota_lib", counts: { cells: 1, views: 1 }, cells: [] }],
			},
			"vaSessionListLibraries(",
		);

		expect(exitCode).toBe(0);
		expect(output.ok).toBe(true);
		expect(output.value).toMatchObject({ summary: { counts: { libraries: 1 } } });
	});

	it("reads one library inventory through a managed session", async () => {
		const { exitCode, output } = await runManagedCliCommand(
			["inventory", "cellviews", "--lib", "ota_lib"],
			{
				name: "ota_lib",
				path: "/work/ota_lib",
				counts: { cells: 1, views: 1 },
				cells: [{ name: "ota_core", counts: { views: 1 }, views: [{ name: "schematic" }] }],
			},
			'vaSessionListCellViews("ota_lib"',
		);

		expect(exitCode).toBe(0);
		expect(output.ok).toBe(true);
		expect(output.value).toMatchObject({ summary: { library: { name: "ota_lib" } } });
	});

	it("reports missing inventory cellViews library", async () => {
		const io = createCapturedIo();

		const exitCode = await runCli(["inventory", "cellviews", "--json"], io);

		expect(exitCode).toBe(1);
		expect(io.stdoutLines).toEqual([]);
		expect(io.stderrLines[0]).toBe("Error: inventory cellviews requires --lib.");
	});

	it("reports missing bundle export target arguments", async () => {
		const io = createCapturedIo();

		const exitCode = await runCli(["maestro", "export", "--lib", "ota_lib", "--json"], io);

		expect(exitCode).toBe(1);
		expect(io.stdoutLines).toEqual([]);
		expect(io.stderrLines[0]).toBe("Error: maestro export requires --cell.");
	});

	it("shows a cellView in the existing managed UI", async () => {
		const { exitCode, output } = await runManagedCliCommand(
			["cellview", "show", "--lib", "ota_lib", "--cell", "ota_core", "--view", "schematic"],
			{ library: "ota_lib", cell: "ota_core", view: "schematic", mode: "r", visible: true },
			'vaSessionShowCellView("ota_lib" "ota_core" "schematic" "r"',
		);

		expect(exitCode).toBe(0);
		expect(output.ok).toBe(true);
		expect(output.value).toMatchObject({ value: { visible: true } });
	});

	it("reports missing cellView open arguments", async () => {
		const io = createCapturedIo();

		const exitCode = await runCli(["cellview", "open", "--lib", "ota_lib", "--json"], io);

		expect(exitCode).toBe(1);
		expect(io.stdoutLines).toEqual([]);
		expect(io.stderrLines[0]).toBe("Error: cellview open requires --cell.");
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
		expect(io.stderrLines[0]).toBe("Error: --spectre-bin requires a value.");
		expect(io.stderrLines[1]).toBe("Usage:");
		expect(io.stderrLines).toContain("  vab session list --json [--registry-dir <dir>]");
		expect(io.stderrLines.some((line) => line.startsWith("  vab run <task.json>"))).toBe(true);
	});

	it("prints usage for unknown commands", async () => {
		const io = createCapturedIo();

		const exitCode = await runCli(["unknown"], io);

		expect(exitCode).toBe(1);
		expect(io.stdoutLines).toEqual([]);
		expect(io.stderrLines[0]).toBe("Usage:");
		expect(io.stderrLines).toContain("  vab session list --json [--registry-dir <dir>]");
		expect(io.stderrLines.some((line) => line.startsWith("  vab schematic export"))).toBe(true);
	});
});
