import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	extractManagedVirtuosoMetrics,
	runManagedVirtuosoSimulation,
	validateVirtuosoMetricExtractPlan,
	validateVirtuosoRunPlan,
} from "../../../src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true }));
	}
});

describe("simulation plan validation", () => {
	it("requires an explicit level and rejects unknown execution controls", () => {
		const result = validateVirtuosoRunPlan({
			schemaVersion: 1,
			kind: "virtuoso-run-plan",
			workflow: { id: "ota", sequence: 1, baselineManifest: "/tmp/bundle.json" },
			target: {
				maestro: { library: "lib", cell: "tb", view: "maestro" },
				selection: { level: "test", testName: "test1" },
			},
			backend: { type: "skill", execution: "managed-session" },
			control: { retryCount: 2 },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toContain("plan.control is not allowed");
	});

	it("limits V1 extraction to mae-output-view", () => {
		const result = validateVirtuosoMetricExtractPlan({
			schemaVersion: 1,
			kind: "virtuoso-metric-extract-plan",
			workflow: { id: "ota", sequence: 1 },
			extractor: { type: "psf" },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toContain('"kind":"virtuoso-metric-extract-plan"');
			expect(result.error.message).toContain("State paths, history names, and CSV paths are runtime-owned");
		}
	});

	it("shows the canonical metric plan after a legacy workflowIteration field", () => {
		const result = validateVirtuosoMetricExtractPlan({
			schemaVersion: 1,
			kind: "virtuoso-metric-extract-plan",
			workflowIteration: { statePath: "/tmp/state.json" },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toContain("plan.workflowIteration is not allowed");
			expect(result.error.message).toContain('"workflow":{"id":"<workflow-id>","sequence":1}');
			expect(result.error.details).toMatchObject({
				hint: expect.stringContaining('"extractor":{"type":"mae-output-view"}'),
			});
		}
	});
});

describe("managed simulation workflow", () => {
	it("reports exact missing baseline capabilities and the required export request", async () => {
		const fixture = await createManagedFixture();
		const baselinePath = join(fixture.root, "incomplete-bundle.json");
		await writeFile(
			baselinePath,
			JSON.stringify({
				schemaVersion: 2,
				kind: "maestro-simulation-bundle",
				target: { library: "test_tb_pi_modify", cell: "two_stage_amp_tb", view: "maestro" },
				scope: "test",
				outputs: { mode: "results" },
			}),
		);
		const planPath = join(fixture.root, "incomplete-baseline-plan.json");
		await writeFile(
			planPath,
			JSON.stringify({
				schemaVersion: 1,
				kind: "virtuoso-run-plan",
				workflow: { id: "incomplete-baseline", sequence: 1, baselineManifest: baselinePath },
				target: {
					maestro: { library: "test_tb_pi_modify", cell: "two_stage_amp_tb", view: "maestro" },
					selection: { level: "test", testName: "test_tb_two_stage_amp_tb_1" },
				},
				backend: { type: "skill", execution: "managed-session" },
			}),
		);

		const run = await runManagedVirtuosoSimulation({
			planPath,
			registryDir: fixture.registryDir,
			instanceId: "fixture",
		});
		expect(run.ok).toBe(false);
		if (!run.ok) {
			expect(run.error.type).toBe("simulation_baseline_not_full");
			expect(run.error.message).toContain(
				"Missing: scope=all, outputs=definitions|all, schematicInstances=top-level",
			);
			expect(run.error.details).toMatchObject({
				actual: { scope: "test", outputs: "results", schematicInstances: null },
				missing: ["scope=all", "outputs=definitions|all", "schematicInstances=top-level"],
				requiredExport: {
					action: "maestro",
					scope: "all",
					outputs: "definitions",
					schematicInstances: "top-level",
				},
			});
		}
		expect(await readdir(fixture.commandDir)).toHaveLength(0);
	});

	it("dynamically observes Cadence logs, archives only the run slice, and extracts exact-history CSV", async () => {
		const fixture = await createManagedFixture();
		await writeFile(fixture.stdoutPath, "old shared output\n", "utf8");
		const baselinePath = join(fixture.root, "bundle.json");
		await writeFile(
			baselinePath,
			JSON.stringify({
				schemaVersion: 2,
				kind: "maestro-simulation-bundle",
				target: { library: "test_tb_pi_modify", cell: "two_stage_amp_tb", view: "maestro" },
				scope: "all",
				outputs: { mode: "all" },
				schematicInstances: { mode: "top-level" },
			}),
			"utf8",
		);
		const runPlanPath = join(fixture.root, "run-plan.json");
		await writeFile(
			runPlanPath,
			JSON.stringify({
				schemaVersion: 1,
				kind: "virtuoso-run-plan",
				workflow: { id: "ota-test", sequence: 1, baselineManifest: baselinePath },
				target: {
					maestro: { library: "test_tb_pi_modify", cell: "two_stage_amp_tb", view: "maestro" },
					selection: { level: "test", testName: "test_tb_two_stage_amp_tb_1" },
				},
				backend: { type: "skill", execution: "managed-session" },
				inactivityTimeoutMs: 5_000,
			}),
			"utf8",
		);

		const bridge = simulateRunBridge(fixture);
		const run = await runManagedVirtuosoSimulation({
			planPath: runPlanPath,
			registryDir: fixture.registryDir,
			instanceId: "fixture",
			monitorPollIntervalMs: 5,
		});
		await bridge;
		expect(run.ok).toBe(true);
		if (!run.ok) return;
		expect(run.value.state.run.status).toBe("completed");
		expect(run.value.state.run.historyName).toBe("Interactive.2");
		expect(run.value.state.logs.warnings).toBeGreaterThanOrEqual(1);
		expect(run.value.state.logs.errors).toBeGreaterThanOrEqual(1);
		const archivedStdout = await readFile(join(run.value.iterationDirectory, "logs", "virtuoso.stdout.log"), "utf8");
		expect(archivedStdout).toContain("new run output");
		expect(archivedStdout).not.toContain("old shared output");
		const monitor = await readFile(join(run.value.iterationDirectory, "logs", "monitor.log"), "utf8");
		expect(monitor).toContain("history-created Interactive.2");
		expect(monitor).toContain("simulation-log-progress");
		expect(
			await stat(join(run.value.iterationDirectory, "logs", "cadence", "point1", "test1", "spectre.out")),
		).toBeTruthy();

		const metricPlanPath = join(fixture.root, "metric-plan.json");
		await writeFile(
			metricPlanPath,
			JSON.stringify({
				schemaVersion: 1,
				kind: "virtuoso-metric-extract-plan",
				workflow: { id: "ota-test", sequence: 1 },
				extractor: { type: "mae-output-view" },
			}),
			"utf8",
		);
		const extractionBridge = simulateExtractionBridge(fixture, run.value.iterationDirectory);
		const extraction = await extractManagedVirtuosoMetrics({
			planPath: metricPlanPath,
			registryDir: fixture.registryDir,
			instanceId: "fixture",
			timeoutMs: 2_000,
		});
		await extractionBridge;
		expect(extraction.ok).toBe(true);
		if (extraction.ok) {
			expect(extraction.value.rows).toBe(1);
			expect(await readFile(extraction.value.csvPath, "utf8")).toContain("gain");
			expect(extraction.value.state.status).toBe("completed");
		}
	});

	it("marks inactivity unknown and resumes the same bridge command without a duplicate run", async () => {
		const fixture = await createManagedFixture();
		const baselinePath = join(fixture.root, "bundle.json");
		await writeFile(
			baselinePath,
			JSON.stringify({
				schemaVersion: 2,
				kind: "maestro-simulation-bundle",
				target: { library: "test_tb_pi_modify", cell: "two_stage_amp_tb", view: "maestro" },
				scope: "all",
				outputs: { mode: "all" },
				schematicInstances: { mode: "top-level" },
			}),
		);
		const planPath = join(fixture.root, "run-plan.json");
		await writeFile(
			planPath,
			JSON.stringify({
				schemaVersion: 1,
				kind: "virtuoso-run-plan",
				workflow: { id: "resume-test", sequence: 1, baselineManifest: baselinePath },
				target: {
					maestro: { library: "test_tb_pi_modify", cell: "two_stage_amp_tb", view: "maestro" },
					selection: { level: "maestro" },
				},
				backend: { type: "skill", execution: "managed-session" },
				inactivityTimeoutMs: 1_000,
			}),
		);
		const commandPromise = waitForCommand(fixture.commandDir, "vaSimulationRunV1");
		const firstRunPromise = runManagedVirtuosoSimulation({
			planPath,
			registryDir: fixture.registryDir,
			instanceId: "fixture",
			monitorPollIntervalMs: 10,
		});
		const commandPath = await commandPromise;
		const resultName = commandPath.split("/").at(-1)?.replace(/\.il$/, ".json") ?? "run.json";
		const resultsRoot = join(fixture.root, "slow-results");
		await mkdir(resultsRoot, { recursive: true });
		await writeFile(
			join(fixture.resultDir, resultName.replace(/\.json$/, ".progress.json")),
			JSON.stringify({ ok: true, value: { historyName: "Interactive.slow", resultsRoot } }),
		);
		const first = await firstRunPromise;
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.value.state.status).toBe("unknown");
		expect(first.value.state.run.reason).toBe("inactivity-timeout");
		expect((await readdir(fixture.commandDir)).filter((name) => name.endsWith(".il"))).toHaveLength(1);

		await writeFile(
			join(fixture.resultDir, resultName),
			JSON.stringify({
				ok: true,
				value: { historyName: "Interactive.slow", resultsRoot, waitCompleted: true },
			}),
		);
		const resumed = await runManagedVirtuosoSimulation({
			planPath,
			registryDir: fixture.registryDir,
			instanceId: "fixture",
			monitorPollIntervalMs: 5,
		});
		expect(resumed.ok).toBe(true);
		if (resumed.ok) expect(resumed.value.state.run.status).toBe("completed");
		expect((await readdir(fixture.commandDir)).filter((name) => name.endsWith(".il"))).toHaveLength(1);
	});

	it("falls back to exact-history run status when Cadence wait reports an internal error", async () => {
		const fixture = await createManagedFixture();
		const baselinePath = join(fixture.root, "bundle.json");
		await writeFile(
			baselinePath,
			JSON.stringify({
				schemaVersion: 2,
				kind: "maestro-simulation-bundle",
				target: { library: "test_tb_pi_modify", cell: "two_stage_amp_tb", view: "maestro" },
				scope: "all",
				outputs: { mode: "definitions" },
				schematicInstances: { mode: "top-level" },
			}),
		);
		const planPath = join(fixture.root, "run-plan.json");
		await writeFile(
			planPath,
			JSON.stringify({
				schemaVersion: 1,
				kind: "virtuoso-run-plan",
				workflow: { id: "wait-fallback", sequence: 1, baselineManifest: baselinePath },
				target: {
					maestro: { library: "test_tb_pi_modify", cell: "two_stage_amp_tb", view: "maestro" },
					selection: { level: "test", testName: "test_tb_two_stage_amp_tb_1" },
				},
				backend: { type: "skill", execution: "managed-session" },
				inactivityTimeoutMs: 5_000,
			}),
		);

		const runCommandPromise = waitForCommand(fixture.commandDir, "vaSimulationRunV1");
		const runPromise = runManagedVirtuosoSimulation({
			planPath,
			registryDir: fixture.registryDir,
			instanceId: "fixture",
			monitorPollIntervalMs: 5,
		});
		const runCommandPath = await runCommandPromise;
		const runResultName = runCommandPath.split("/").at(-1)?.replace(/\.il$/, ".json") ?? "run.json";
		const resultsRoot = join(fixture.root, "fallback-results");
		await mkdir(resultsRoot, { recursive: true });
		await writeFile(
			join(fixture.resultDir, runResultName.replace(/\.json$/, ".progress.json")),
			JSON.stringify({ ok: true, value: { historyName: "Interactive.fallback", resultsRoot } }),
		);
		await writeFile(
			join(fixture.resultDir, runResultName),
			JSON.stringify({
				ok: true,
				value: {
					historyName: "Interactive.fallback",
					resultsRoot,
					waitCompleted: false,
				},
			}),
		);
		const statusCommandPath = await waitForCommand(fixture.commandDir, "vaSimulationRunStatusV1");
		const statusCommand = await readFile(statusCommandPath, "utf8");
		expect(statusCommand).toContain("Interactive.fallback");
		const statusResultName = statusCommandPath.split("/").at(-1)?.replace(/\.il$/, ".json") ?? "status.json";
		await writeFile(
			join(fixture.resultDir, statusResultName),
			JSON.stringify({
				ok: true,
				value: { historyName: "Interactive.fallback", completed: 1, total: 1 },
			}),
		);

		const run = await runPromise;
		expect(run.ok).toBe(true);
		if (!run.ok) return;
		expect(run.value.state.run.status).toBe("completed");
		const monitor = await readFile(join(run.value.iterationDirectory, "logs", "monitor.log"), "utf8");
		expect(monitor).toContain("mae-wait-fallback");
		expect(monitor).toContain("mae-run-status completed=1 total=1");
		expect(monitor).toContain("mae-run-completed");
		expect(
			(await readdir(fixture.commandDir)).filter((name) => name.includes("simulation-wait-fallback")),
		).toHaveLength(1);
	});

	it("fails extraction when every exact-history output is an evaluator error", async () => {
		const fixture = await createManagedFixture();
		const iterationDirectory = join(
			fixture.cwd,
			".virtuoso-agent",
			"workflows",
			"evaluator-error",
			"iterations",
			"000001",
		);
		await mkdir(join(iterationDirectory, "metrics"), { recursive: true });
		await writeFile(
			join(iterationDirectory, "run.json"),
			JSON.stringify({
				schemaVersion: 1,
				kind: "virtuoso-run-plan",
				workflow: { id: "evaluator-error", sequence: 1, baselineManifest: "/unused/bundle.json" },
				target: {
					maestro: { library: "test_tb_pi_modify", cell: "two_stage_amp_tb", view: "maestro" },
					selection: { level: "test", testName: "test_tb_two_stage_amp_tb_1" },
				},
				backend: { type: "skill", execution: "managed-session" },
			}),
		);
		await writeFile(
			join(iterationDirectory, "state.json"),
			JSON.stringify({
				schemaVersion: 1,
				workflowId: "evaluator-error",
				sequence: 1,
				planHash: "fixture",
				status: "run-completed",
				run: {
					status: "completed",
					instanceId: "previous-instance",
					startedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					completedAt: new Date().toISOString(),
					historyName: "Interactive.error",
					stdoutStartOffset: 0,
					stderrStartOffset: 0,
				},
				extraction: { status: "not-started" },
				logs: { monitor: "logs/monitor.log", artifacts: [], warnings: 0, errors: 0, fatals: 0 },
			}),
		);
		const metricPlanPath = join(fixture.root, "metric-error-plan.json");
		await writeFile(
			metricPlanPath,
			JSON.stringify({
				schemaVersion: 1,
				kind: "virtuoso-metric-extract-plan",
				workflow: { id: "evaluator-error", sequence: 1 },
				extractor: { type: "mae-output-view" },
			}),
		);
		const bridge = simulateExtractionBridge(
			fixture,
			iterationDirectory,
			"Test,Output,Nominal,Spec,Weight,Pass/Fail\ntest1,gain,eval err,,,\ntest1,gbw,eval err,,,\n",
			"Interactive.error",
		);
		const extraction = await extractManagedVirtuosoMetrics({
			planPath: metricPlanPath,
			registryDir: fixture.registryDir,
			instanceId: "fixture",
			timeoutMs: 2_000,
		});
		await bridge;
		expect(extraction.ok).toBe(false);
		if (!extraction.ok) expect(extraction.error.type).toBe("metric_extract_all_values_error");
		const state = JSON.parse(await readFile(join(iterationDirectory, "state.json"), "utf8"));
		expect(state.status).toBe("run-completed");
		expect(state.extraction.status).toBe("failed");
	});
});

interface ManagedFixture {
	root: string;
	cwd: string;
	registryDir: string;
	sessionDir: string;
	commandDir: string;
	resultDir: string;
	stdoutPath: string;
}

async function createManagedFixture(): Promise<ManagedFixture> {
	const root = await mkdtemp(join(tmpdir(), "virtuoso-simulation-test-"));
	temporaryDirectories.push(root);
	const cwd = join(root, "project");
	const registryDir = join(root, "registry");
	const sessionDir = join(root, "session");
	const commandDir = join(sessionDir, "commands");
	const resultDir = join(sessionDir, "results");
	const processedDir = join(sessionDir, "processed");
	const logs = join(sessionDir, "logs");
	await Promise.all([
		mkdir(cwd, { recursive: true }),
		mkdir(registryDir, { recursive: true }),
		mkdir(commandDir, { recursive: true }),
		mkdir(resultDir, { recursive: true }),
		mkdir(processedDir, { recursive: true }),
		mkdir(logs, { recursive: true }),
	]);
	const readyPath = join(sessionDir, "ready.json");
	const heartbeatPath = join(sessionDir, "heartbeat.json");
	await Promise.all([writeFile(readyPath, "{}"), writeFile(heartbeatPath, "{}")]);
	await writeFile(
		join(registryDir, "fixture.json"),
		JSON.stringify({
			protocolVersion: 1,
			instanceId: "fixture",
			pid: process.pid,
			processStartedAt: new Date().toISOString(),
			mode: "ui",
			state: "ready",
			cwd,
			sessionDir,
			commandDir,
			resultDir,
			processedDir,
			readyPath,
			heartbeatPath,
			bridgePath: join(root, "bridge.il"),
		}),
	);
	return {
		root,
		cwd,
		registryDir,
		sessionDir,
		commandDir,
		resultDir,
		stdoutPath: join(logs, "virtuoso.stdout.log"),
	};
}

async function simulateRunBridge(fixture: ManagedFixture): Promise<void> {
	const commandPath = await waitForCommand(fixture.commandDir, "vaSimulationRunV1");
	const command = await readFile(commandPath, "utf8");
	const resultName = commandPath.split("/").at(-1)?.replace(/\.il$/, ".json") ?? "result.json";
	const progressPath = join(fixture.resultDir, resultName.replace(/\.json$/, ".progress.json"));
	const resultsRoot = join(fixture.root, "maestro-results");
	const spectreLog = join(resultsRoot, "point1", "test1", "spectre.out");
	await mkdir(join(resultsRoot, "point1", "test1"), { recursive: true });
	expect(command).toContain("test_tb_two_stage_amp_tb_1");
	await writeFile(progressPath, JSON.stringify({ ok: true, value: { historyName: "Interactive.2", resultsRoot } }));
	await writeFile(fixture.stdoutPath, "old shared output\nnew run output\n", "utf8");
	await writeFile(spectreLog, "WARNING convergence relaxed\n", "utf8");
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	await writeFile(spectreLog, "WARNING convergence relaxed\nERROR recovered by simulator\n", "utf8");
	await writeFile(
		join(fixture.resultDir, resultName),
		JSON.stringify({
			ok: true,
			value: { historyName: "Interactive.2", resultsRoot, waitCompleted: true },
		}),
	);
}

async function simulateExtractionBridge(
	fixture: ManagedFixture,
	iterationDirectory: string,
	csv = ",Parameter,Nominal,,,\n\nTest,Output,Nominal,Spec,Weight,Pass/Fail\ntest1,gain,61.2,,,\n",
	historyName = "Interactive.2",
): Promise<void> {
	const commandPath = await waitForCommand(fixture.commandDir, "vaMetricExtractMaeOutputViewV1");
	const command = await readFile(commandPath, "utf8");
	expect(command).toContain(historyName);
	const csvPath = join(iterationDirectory, "metrics", ".output-view.tmp.csv");
	await writeFile(csvPath, csv, "utf8");
	const resultName = commandPath.split("/").at(-1)?.replace(/\.il$/, ".json") ?? "metric.json";
	await writeFile(join(fixture.resultDir, resultName), JSON.stringify({ ok: true, value: { csvPath, historyName } }));
}

async function waitForCommand(directory: string, needle: string): Promise<string> {
	for (let attempt = 0; attempt < 700; attempt++) {
		for (const name of await readdir(directory)) {
			if (!name.endsWith(".il")) continue;
			const path = join(directory, name);
			try {
				if ((await readFile(path, "utf8")).includes(needle)) return path;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
	}
	throw new Error(`Timed out waiting for bridge command ${needle}`);
}
