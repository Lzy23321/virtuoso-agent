import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	exportManagedMaestroBundle,
	exportManagedSchematicBundle,
	registerManagedVirtuosoInstance,
} from "../../../src/index.ts";

interface FakeManagedInstance {
	workDir: string;
	registryDir: string;
	sessionDir: string;
	commandDir: string;
	resultDir: string;
}

interface PreparedFakeMaestroTest {
	index: number;
	name: string;
	enabled: boolean;
	singleOceanPath: string;
	sweepOceanPath: string;
	netlistPath: string;
	design: { library: string; cell: string; view: string };
}

describe("simulation bundle export", () => {
	it("copies a schematic Spectre netlist returned by the managed Virtuoso bridge", async () => {
		const instance = await createFakeManagedInstance("schematic-bundle");
		const sourceDirectory = join(instance.workDir, "cadence-schematic-netlist");
		const sourcePrimaryPath = join(sourceDirectory, "input.scs");
		await writeSpectreNetlist(sourcePrimaryPath, "ota_lib", "ota_tb", "schematic", "ac ac start=1 stop=1G");

		const bridge = respondToCommands(instance, async (command) => {
			expect(command).toContain('vaSessionExportSchematicNetlist("ota_lib" "ota_tb" "schematic"');
			return { path: sourcePrimaryPath, virtuosoVersion: "IC25.1" };
		});
		const result = await exportManagedSchematicBundle({
			instanceId: "schematic-bundle",
			registryDir: instance.registryDir,
			library: "ota_lib",
			cell: "ota_tb",
			view: "schematic",
			outputDirectory: join(instance.workDir, "bundles"),
			timeoutMs: 2_000,
		});
		await bridge;

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.kind).toBe("schematic");
			expect(
				await readFile(join(result.value.bundleDirectory, "schematic", "netlist", "input.scs"), "utf8"),
			).toContain("ac ac start=1 stop=1G");
			expect(JSON.parse(await readFile(result.value.manifest.path, "utf8"))).toMatchObject({
				schemaVersion: 1,
				kind: "schematic-netlist-bundle",
				target: { library: "ota_lib", cell: "ota_tb", view: "schematic" },
				generator: { managedInstanceId: "schematic-bundle", simulationExecuted: false },
				validation: { status: "passed" },
			});
		}
	});

	it("exports and netlists every Maestro test in one session using each test's configured design", async () => {
		const instance = await createFakeManagedInstance("maestro-bundle");
		let commandIndex = 0;
		const bridge = respondToCommands(instance, async (command) => {
			commandIndex += 1;
			expect(commandIndex).toBe(1);
			expect(command).not.toContain("vaSessionCreateNetlistFromOcean");
			const bundleMatch = command.match(
				/vaSessionPrepareMaestroExportV4\("ota_lib" "ota_tb" "maestro" "([^"]+)" "all" ""/,
			);
			expect(bundleMatch).not.toBeNull();
			const bundleDirectory = bundleMatch?.[1] ?? "";
			const topOceanPath = join(bundleDirectory, "maestro", "maestro.ocn");
			const firstDirectory = join(bundleDirectory, "tests", "001");
			const secondDirectory = join(bundleDirectory, "tests", "002");
			const firstSourcePath = join(instance.workDir, "cadence-test-1", "input.scs");
			const secondSourcePath = join(instance.workDir, "cadence-test-2", "input.scs");
			await mkdir(firstDirectory, { recursive: true });
			await mkdir(secondDirectory, { recursive: true });
			await writeFile(
				topOceanPath,
				[
					'ocnSetXLMode("assembler")',
					'ocnxlTargetCellView( "ota_lib" "ota_tb" "maestro" ?mode "r" )',
					'ocnxlBeginTest("ac_test")',
					'ocnxlBeginTest("stb_test")',
					"ocnxlRun( ?mode 'sweepsAndCorners ?nominalCornerEnabled t)",
					"",
				].join("\n"),
				"utf8",
			);
			await writeSingleOcean(join(firstDirectory, "single.ocn"), "ota_lib", "ota_ac_tb");
			await writeSingleOcean(join(secondDirectory, "single.ocn"), "alternate_tb", "ota_stb_tb");
			await writeSweepOcean(join(firstDirectory, "sweep.ocn"), "ota_lib", "ota_tb", "ac_test", ["stb_test"]);
			await writeSweepOcean(join(secondDirectory, "sweep.ocn"), "ota_lib", "ota_tb", "stb_test", ["ac_test"]);
			await writeSpectreNetlist(firstSourcePath, "ota_lib", "ota_ac_tb", "schematic", "ac ac start=1 stop=1G");
			await writeSpectreNetlist(
				secondSourcePath,
				"alternate_tb",
				"ota_stb_tb",
				"schematic",
				"stb stb start=1 stop=1G",
			);
			return {
				scope: "all",
				topOceanPath,
				virtuosoVersion: "IC25.1",
				tests: [
					{
						index: 1,
						name: "ac_test",
						enabled: true,
						singleOceanPath: join(firstDirectory, "single.ocn"),
						sweepOceanPath: join(firstDirectory, "sweep.ocn"),
						netlistPath: firstSourcePath,
						design: { library: "ota_lib", cell: "ota_ac_tb", view: "schematic" },
					},
					{
						index: 2,
						name: "stb_test",
						enabled: false,
						singleOceanPath: join(secondDirectory, "single.ocn"),
						sweepOceanPath: join(secondDirectory, "sweep.ocn"),
						netlistPath: secondSourcePath,
						design: { library: "alternate_tb", cell: "ota_stb_tb", view: "schematic" },
					},
				],
			};
		});

		const result = await exportManagedMaestroBundle({
			instanceId: "maestro-bundle",
			registryDir: instance.registryDir,
			library: "ota_lib",
			cell: "ota_tb",
			view: "maestro",
			outputDirectory: join(instance.workDir, "bundles"),
			timeoutMs: 2_000,
		});
		await bridge;

		expect(result.ok).toBe(true);
		if (result.ok) {
			const manifest = JSON.parse(await readFile(result.value.manifest.path, "utf8"));
			expect(manifest).toMatchObject({
				schemaVersion: 2,
				kind: "maestro-simulation-bundle",
				scope: "all",
				generator: { maestroApplication: "Assembler", openMode: "read-only", simulationExecuted: false },
				topLevelOcean: {
					kind: "ocean-maestro",
					format: "ocean-xl",
					path: "maestro/maestro.ocn",
				},
				tests: [
					{
						name: "ac_test",
						enabled: true,
						status: "complete",
						design: { library: "ota_lib", cell: "ota_ac_tb", view: "schematic" },
						singleOcean: { path: "tests/001/single.ocn" },
						sweepOcean: { path: "tests/001/sweep.ocn" },
					},
					{
						name: "stb_test",
						enabled: false,
						status: "complete",
						design: { library: "alternate_tb", cell: "ota_stb_tb", view: "schematic" },
						singleOcean: { path: "tests/002/single.ocn" },
						sweepOcean: { path: "tests/002/sweep.ocn" },
					},
				],
			});
			expect(
				await readFile(join(result.value.bundleDirectory, "tests", "001", "netlist", "input.scs"), "utf8"),
			).toContain("ac ac start=1 stop=1G");
			expect(
				await readFile(join(result.value.bundleDirectory, "tests", "002", "netlist", "input.scs"), "utf8"),
			).toContain("stb stb start=1 stop=1G");
			expect(
				JSON.parse(await readFile(join(result.value.bundleDirectory, "tests", "001", "test.json"), "utf8")),
			).toMatchObject({
				oceanScripts: {
					singlePoint: "single.ocn",
					sweep: "sweep.ocn",
				},
			});
			expect(result.value.artifacts.map((artifact) => artifact.kind)).toEqual([
				"ocean-maestro",
				"ocean-single",
				"ocean-sweep",
				"spectre-netlist",
				"ocean-single",
				"ocean-sweep",
				"spectre-netlist",
			]);
			expect(commandIndex).toBe(1);
		}
	});

	it("exports only the top-level Maestro OCEAN script with top scope", async () => {
		const instance = await createFakeManagedInstance("maestro-top");
		const bridge = respondToCommands(instance, (command) => prepareSelectiveMaestroExport(instance, command));

		const result = await exportManagedMaestroBundle({
			instanceId: "maestro-top",
			registryDir: instance.registryDir,
			library: "ota_lib",
			cell: "ota_tb",
			view: "maestro",
			scope: "top",
			outputDirectory: join(instance.workDir, "bundles"),
			timeoutMs: 2_000,
		});
		await bridge;

		expect(result.ok).toBe(true);
		if (result.ok) {
			const manifest = JSON.parse(await readFile(result.value.manifest.path, "utf8"));
			expect(manifest).toMatchObject({
				scope: "top",
				topLevelOcean: { path: "maestro/maestro.ocn" },
				tests: [],
			});
			expect(result.value.artifacts.map((artifact) => artifact.kind)).toEqual(["ocean-maestro"]);
			expect(await readdir(result.value.bundleDirectory)).toEqual(["bundle.json", "maestro"]);
		}
	});

	it("exports every per-test artifact without the top-level script with tests scope", async () => {
		const instance = await createFakeManagedInstance("maestro-tests");
		const bridge = respondToCommands(instance, (command) => prepareSelectiveMaestroExport(instance, command));

		const result = await exportManagedMaestroBundle({
			instanceId: "maestro-tests",
			registryDir: instance.registryDir,
			library: "ota_lib",
			cell: "ota_tb",
			view: "maestro",
			scope: "tests",
			outputDirectory: join(instance.workDir, "bundles"),
			timeoutMs: 2_000,
		});
		await bridge;

		expect(result.ok).toBe(true);
		if (result.ok) {
			const manifest = JSON.parse(await readFile(result.value.manifest.path, "utf8"));
			expect(manifest.scope).toBe("tests");
			expect(manifest.topLevelOcean).toBeUndefined();
			expect(manifest.tests.map((test: { index: number }) => test.index)).toEqual([1, 2]);
			expect(result.value.artifacts).toHaveLength(6);
		}
	});

	it("exports only one named test while preserving its Maestro index with test scope", async () => {
		const instance = await createFakeManagedInstance("maestro-test");
		const bridge = respondToCommands(instance, (command) => prepareSelectiveMaestroExport(instance, command));

		const result = await exportManagedMaestroBundle({
			instanceId: "maestro-test",
			registryDir: instance.registryDir,
			library: "ota_lib",
			cell: "ota_tb",
			view: "maestro",
			scope: "test",
			testName: "stb_test",
			outputDirectory: join(instance.workDir, "bundles"),
			timeoutMs: 2_000,
		});
		await bridge;

		expect(result.ok).toBe(true);
		if (result.ok) {
			const manifest = JSON.parse(await readFile(result.value.manifest.path, "utf8"));
			expect(manifest).toMatchObject({
				scope: "test",
				requestedTestName: "stb_test",
				tests: [{ index: 2, name: "stb_test", singleOcean: { path: "tests/002/single.ocn" } }],
			});
			expect(manifest.topLevelOcean).toBeUndefined();
			expect(result.value.artifacts.map((artifact) => artifact.kind)).toEqual([
				"ocean-single",
				"ocean-sweep",
				"spectre-netlist",
			]);
		}
	});

	it("requires testName for test scope before contacting Virtuoso", async () => {
		const result = await exportManagedMaestroBundle({
			library: "ota_lib",
			cell: "ota_tb",
			view: "maestro",
			scope: "test",
		});

		expect(result).toMatchObject({
			ok: false,
			error: { type: "maestro_test_name_required" },
		});
	});
});

async function prepareSelectiveMaestroExport(instance: FakeManagedInstance, command: string): Promise<unknown> {
	const match = command.match(
		/vaSessionPrepareMaestroExportV4\("ota_lib" "ota_tb" "maestro" "([^"]+)" "(all|top|tests|test)" "([^"]*)"/,
	);
	expect(match).not.toBeNull();
	const bundleDirectory = match?.[1] ?? "";
	const scope = match?.[2] ?? "all";
	const requestedTestName = match?.[3] ?? "";
	const includeTop = scope === "all" || scope === "top";
	const testSpecs = [
		{ index: 1, name: "ac_test", library: "ota_lib", cell: "ota_ac_tb", analysis: "ac ac start=1 stop=1G" },
		{
			index: 2,
			name: "stb_test",
			library: "alternate_tb",
			cell: "ota_stb_tb",
			analysis: "stb stb start=1 stop=1G",
		},
	];
	const selectedTests =
		scope === "top" ? [] : scope === "test" ? testSpecs.filter((test) => test.name === requestedTestName) : testSpecs;
	const topOceanPath = includeTop ? join(bundleDirectory, "maestro", "maestro.ocn") : null;
	if (topOceanPath) {
		await writeFile(
			topOceanPath,
			[
				'ocnSetXLMode("assembler")',
				'ocnxlTargetCellView( "ota_lib" "ota_tb" "maestro" ?mode "r" )',
				...testSpecs.map((test) => `ocnxlBeginTest("${test.name}")`),
				"ocnxlRun( ?mode 'sweepsAndCorners ?nominalCornerEnabled t)",
				"",
			].join("\n"),
			"utf8",
		);
	}
	const tests: PreparedFakeMaestroTest[] = [];
	for (const test of selectedTests) {
		const testDirectory = join(bundleDirectory, "tests", test.index.toString().padStart(3, "0"));
		const sourcePath = join(instance.workDir, `selective-netlist-${scope}-${test.index}`, "input.scs");
		await mkdir(testDirectory, { recursive: true });
		await writeSingleOcean(join(testDirectory, "single.ocn"), test.library, test.cell);
		await writeSweepOcean(
			join(testDirectory, "sweep.ocn"),
			"ota_lib",
			"ota_tb",
			test.name,
			testSpecs.filter((candidate) => candidate.name !== test.name).map((candidate) => candidate.name),
		);
		await writeSpectreNetlist(sourcePath, test.library, test.cell, "schematic", test.analysis);
		tests.push({
			index: test.index,
			name: test.name,
			enabled: true,
			singleOceanPath: join(testDirectory, "single.ocn"),
			sweepOceanPath: join(testDirectory, "sweep.ocn"),
			netlistPath: sourcePath,
			design: { library: test.library, cell: test.cell, view: "schematic" },
		});
	}
	return { scope, topOceanPath, virtuosoVersion: "IC25.1", tests };
}

async function createFakeManagedInstance(instanceId: string): Promise<FakeManagedInstance> {
	const workDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-bundle-test-"));
	const registryDir = join(workDir, "registry");
	const sessionDir = join(workDir, "session");
	const commandDir = join(sessionDir, "commands");
	const resultDir = join(sessionDir, "results");
	const processedDir = join(sessionDir, "processed");
	const readyPath = join(sessionDir, "ready.json");
	const heartbeatPath = join(sessionDir, "heartbeat.json");
	await mkdir(commandDir, { recursive: true });
	await mkdir(resultDir, { recursive: true });
	await mkdir(processedDir, { recursive: true });
	await writeFile(readyPath, "{}\n", "utf8");
	await writeFile(heartbeatPath, "{}\n", "utf8");
	const registered = await registerManagedVirtuosoInstance(
		{
			protocolVersion: 1,
			instanceId,
			pid: process.pid,
			processStartedAt: new Date().toISOString(),
			mode: "headless",
			state: "ready",
			cwd: workDir,
			cdsLib: join(workDir, "cds.lib"),
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
	return { workDir, registryDir, sessionDir, commandDir, resultDir };
}

async function respondToCommands(
	instance: FakeManagedInstance,
	response: (command: string) => Promise<unknown>,
): Promise<void> {
	const seen = new Set<string>();
	let idleAttempts = 0;
	while (idleAttempts < 100) {
		const names = await readdir(instance.commandDir);
		const next = names.find((name) => name.endsWith(".il") && !seen.has(name));
		if (!next) {
			idleAttempts += 1;
			await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
			continue;
		}
		idleAttempts = 0;
		seen.add(next);
		const command = await readFile(join(instance.commandDir, next), "utf8");
		const value = await response(command);
		await writeFile(
			join(instance.resultDir, next.replace(/\.il$/, ".json")),
			`${JSON.stringify({ ok: true, value })}\n`,
			"utf8",
		);
		return;
	}
	throw new Error("Timed out waiting for managed Virtuoso commands.");
}

async function writeSpectreNetlist(
	path: string,
	library: string,
	cell: string,
	view: string,
	analysis: string,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		[
			`// Design library name: ${library}`,
			`// Design cell name: ${cell}`,
			`// Design view name: ${view}`,
			"simulator lang=spectre",
			'include "ade_e.scs"',
			analysis,
			"",
		].join("\n"),
		"utf8",
	);
	await writeFile(join(dirname(path), "ade_e.scs"), "simulator lang=spectre\n", "utf8");
}

async function writeSingleOcean(path: string, library: string, cell: string): Promise<void> {
	await writeFile(
		path,
		[`simulator( 'spectre )`, `design( "${library}" "${cell}" "schematic")`, "run()", ""].join("\n"),
		"utf8",
	);
}

async function writeSweepOcean(
	path: string,
	library: string,
	cell: string,
	activeTest: string,
	disabledTests: string[],
): Promise<void> {
	await writeFile(
		path,
		[
			'ocnSetXLMode("assembler")',
			`ocnxlTargetCellView( "${library}" "${cell}" "maestro" ?mode "r" )`,
			`ocnxlBeginTest("${activeTest}")`,
			...disabledTests.flatMap((test) => [`ocnxlBeginTest("${test}")`, `ocnxlDisableTest("${test}")`]),
			"ocnxlRun( ?mode 'sweepsAndCorners ?nominalCornerEnabled t)",
			"",
		].join("\n"),
		"utf8",
	);
}
