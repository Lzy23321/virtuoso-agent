import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { executeVirtuosoBridgeSessionCommand, skillString } from "../backends/virtuoso/bridge.ts";
import {
	type LiveManagedVirtuosoInstance,
	resolveManagedVirtuosoInstance,
} from "../backends/virtuoso/instance-registry.ts";
import type { ArtifactRef, CellViewRef } from "../core/inspection.ts";
import { fail, ok, type RuntimeResult } from "../core/result.ts";
import type { ManagedVirtuosoRequest } from "./managed-virtuoso.ts";

export type SimulationBundleKind = "schematic" | "maestro";
export type MaestroExportScope = "none" | "all" | "top" | "tests" | "test";
export type MaestroOutputExportMode = "none" | "definitions" | "results" | "all";
export type MaestroSchematicInstancesMode = "none" | "top-level";
export type SchematicNetlistMode = "none" | "spectre";

export interface ExportSimulationBundleRequest extends ManagedVirtuosoRequest {
	library: string;
	cell: string;
	view: string;
	outputDirectory?: string;
	scope?: MaestroExportScope;
	testName?: string;
	outputs?: MaestroOutputExportMode;
	historyName?: string;
	schematicInstances?: MaestroSchematicInstancesMode;
	outputTestName?: string;
	netlist?: SchematicNetlistMode;
}

export interface SimulationBundleResult {
	target: CellViewRef;
	kind: SimulationBundleKind;
	bundleDirectory: string;
	manifest: ArtifactRef;
	artifacts: ArtifactRef[];
	warnings: string[];
	instance: LiveManagedVirtuosoInstance;
}

interface ExportedNetlist {
	path: string;
	virtuosoVersion?: string;
}

interface PreparedMaestroTest {
	index: number;
	name: string;
	enabled: boolean;
	singleOceanPath: string;
	sweepOceanPath: string;
	netlistPath: string;
	design: CellViewRef;
}

interface PreparedMaestro {
	scope: MaestroExportScope;
	topOceanPath: string | null;
	virtuosoVersion: string;
	tests: PreparedMaestroTest[];
	outputsMode: MaestroOutputExportMode;
	outputDefinitionsPath: string | null;
	outputResultsPath: string | null;
	outputResultsHistoryName: string | null;
	schematicInstancesMode: MaestroSchematicInstancesMode;
	schematicInstancesPath: string | null;
}

interface BundleArtifact {
	kind:
		| "spectre-netlist"
		| "ocean-maestro"
		| "ocean-single"
		| "ocean-sweep"
		| "output-definitions"
		| "output-results"
		| "schematic-instances";
	format: "spectre-scs" | "ocean" | "ocean-xl" | "csv" | "json";
	path: string;
	directory?: string;
	originalPath?: string;
	sha256: string;
}

interface MaestroBundleTest {
	index: number;
	name: string;
	enabled: boolean;
	status: "complete";
	design: CellViewRef;
	singleOcean: BundleArtifact;
	sweepOcean: BundleArtifact;
	netlist: BundleArtifact;
}

interface SchematicPoint {
	x: number;
	y: number;
}

interface SchematicBoundingBox {
	lowerLeft: SchematicPoint;
	upperRight: SchematicPoint;
	width: number;
	height: number;
}

interface SchematicDirectInstance {
	name: string;
	master: CellViewRef;
	transform: {
		origin: SchematicPoint;
		orientation: string;
		magnification: number;
	};
	boundingBox: SchematicBoundingBox;
}

interface SchematicInstancesEntry {
	design: CellViewRef;
	tests: string[];
	boundingBox: SchematicBoundingBox;
	directInstanceCount: number;
	instances: SchematicDirectInstance[];
}

interface SchematicInstancesExport {
	schemaVersion: 1;
	hierarchyPolicy: "top-level-only";
	recursive: false;
	schematics: SchematicInstancesEntry[];
}

const SCHEMATIC_BUNDLE_SCHEMA_VERSION = 1;
const MAESTRO_BUNDLE_SCHEMA_VERSION = 2;

export async function exportManagedSchematicBundle(
	request: ExportSimulationBundleRequest,
): Promise<RuntimeResult<SimulationBundleResult>> {
	const netlist = request.netlist ?? "spectre";
	const schematicInstances = request.schematicInstances ?? "none";
	if (netlist === "none" && schematicInstances === "none") {
		return fail({
			type: "schematic_export_empty",
			stage: "bundle_prepare",
			message: "Schematic export must select the Spectre netlist, top-level instances, or both.",
		});
	}
	const resolvedInstance = await resolveBundleInstance(request);
	if (!resolvedInstance.ok) {
		return resolvedInstance;
	}
	const target = toTarget(request);
	const bundleDirectory = resolveBundleDirectory(request, resolvedInstance.value, "schematic");
	const netlistDirectory = join(bundleDirectory, "schematic", "netlist");
	const schematicInstancesPath = join(bundleDirectory, "schematic", "instances.json");
	try {
		await mkdir(join(bundleDirectory, "schematic"), { recursive: true });
	} catch (error) {
		return bundleIoFailure("bundle_prepare", bundleDirectory, error);
	}

	const generatedAt = new Date().toISOString();
	const artifacts: BundleArtifact[] = [];
	const validationChecks: string[] = [];
	let virtuosoVersion: string | null = null;

	if (netlist === "spectre") {
		const exported = await executeExportCommand<ExportedNetlist>(
			resolvedInstance.value,
			request.timeoutMs,
			(resultPath, exportSkillPath) =>
				`unless(isCallable('vaSessionExportSchematicNetlist) load(${skillString(
					exportSkillPath,
				)}))\nvaSessionExportSchematicNetlist(${skillString(
					request.library,
				)} ${skillString(request.cell)} ${skillString(request.view)} ${skillString(resultPath)})`,
		);
		if (!exported.ok) {
			return exported;
		}
		const copied = await copyNetlistDirectory(exported.value.path, netlistDirectory);
		if (!copied.ok) {
			return copied;
		}
		const primaryPath = join(netlistDirectory, "input.scs");
		const validated = await validateSpectreNetlist(primaryPath, target);
		if (!validated.ok) {
			return validated;
		}
		const described = await describeArtifact(
			bundleDirectory,
			"spectre-netlist",
			"spectre-scs",
			primaryPath,
			netlistDirectory,
			exported.value.path,
		);
		if (!described.ok) {
			return described;
		}
		artifacts.push(described.value);
		validationChecks.push(...validated.value);
		virtuosoVersion = exported.value.virtuosoVersion ?? null;
	}

	if (schematicInstances === "top-level") {
		const exported = await executeExportCommand<ExportedNetlist>(
			resolvedInstance.value,
			request.timeoutMs,
			(resultPath, exportSkillPath) =>
				`unless(isCallable('vaSessionExportSchematicInstances) load(${skillString(
					exportSkillPath,
				)}))\nvaSessionExportSchematicInstances(${skillString(
					request.library,
				)} ${skillString(request.cell)} ${skillString(request.view)} ${skillString(
					schematicInstancesPath,
				)} ${skillString(resultPath)})`,
		);
		if (!exported.ok) {
			return exported;
		}
		const normalized = await normalizeSchematicInstancesExport(exported.value.path);
		if (!normalized.ok) {
			return normalized;
		}
		const described = await describeArtifact(bundleDirectory, "schematic-instances", "json", exported.value.path);
		if (!described.ok) {
			return described;
		}
		artifacts.push(described.value);
		validationChecks.push(
			"schematic instances artifact contains only direct top-level instances and disables recursive hierarchy export",
		);
		virtuosoVersion ??= exported.value.virtuosoVersion ?? null;
	}

	const manifestValue = {
		schemaVersion: SCHEMATIC_BUNDLE_SCHEMA_VERSION,
		kind: "schematic-netlist-bundle",
		target,
		generatedAt,
		generator: {
			virtuosoVersion,
			managedInstanceId: resolvedInstance.value.instanceId,
			simulationExecuted: false,
		},
		selection: { netlist, schematicInstances },
		artifacts,
		validation: {
			status: "passed",
			checks: validationChecks,
		},
		warnings: [],
	};
	const manifest = await writeBundleManifest(bundleDirectory, manifestValue, generatedAt);
	if (!manifest.ok) {
		return manifest;
	}
	return ok({
		target,
		kind: "schematic",
		bundleDirectory,
		manifest: manifest.value,
		artifacts: artifacts.map((artifact) => toArtifactRef(artifact, bundleDirectory, generatedAt)),
		warnings: [],
		instance: resolvedInstance.value,
	});
}

export async function exportManagedMaestroBundle(
	request: ExportSimulationBundleRequest,
): Promise<RuntimeResult<SimulationBundleResult>> {
	const scope = request.scope ?? "all";
	const outputs = request.outputs ?? "none";
	const schematicInstances = request.schematicInstances ?? "none";
	if (request.outputTestName && outputs === "none") {
		return fail({
			type: "maestro_output_test_not_applicable",
			stage: "bundle_prepare",
			message: "outputTestName requires outputs to be definitions, results, or all.",
		});
	}
	if (scope === "test" && !request.testName) {
		return fail({
			type: "maestro_test_name_required",
			stage: "bundle_prepare",
			message: "testName is required when Maestro export scope is test.",
		});
	}
	if (request.historyName && outputs !== "results" && outputs !== "all") {
		return fail({
			type: "maestro_output_history_not_applicable",
			stage: "bundle_prepare",
			message: "historyName is only supported when outputs is results or all.",
		});
	}
	if (scope === "none" && request.testName && schematicInstances !== "top-level") {
		return fail({
			type: "maestro_test_name_not_applicable",
			stage: "bundle_prepare",
			message: "testName with scope none requires schematicInstances to be top-level.",
		});
	}
	if (scope === "none" && outputs === "none" && schematicInstances === "none") {
		return fail({
			type: "maestro_export_empty",
			stage: "bundle_prepare",
			message: "Maestro export scope none must select outputs or top-level schematic instances.",
		});
	}
	const resolvedInstance = await resolveBundleInstance(request);
	if (!resolvedInstance.ok) {
		return resolvedInstance;
	}
	const target = toTarget(request);
	const bundleDirectory = resolveBundleDirectory(request, resolvedInstance.value, "maestro");
	try {
		await mkdir(bundleDirectory, { recursive: true });
		if (scope === "all" || scope === "top") {
			await mkdir(join(bundleDirectory, "maestro"), { recursive: true });
		}
		if (scope === "all" || scope === "tests" || scope === "test") {
			await mkdir(join(bundleDirectory, "tests"), { recursive: true });
		}
		if (outputs === "definitions" || outputs === "all") {
			await mkdir(join(bundleDirectory, "outputs", "definitions"), { recursive: true });
		}
		if (outputs === "results" || outputs === "all") {
			await mkdir(join(bundleDirectory, "outputs", "results"), { recursive: true });
		}
		if (schematicInstances === "top-level") {
			await mkdir(join(bundleDirectory, "schematics"), { recursive: true });
		}
	} catch (error) {
		return bundleIoFailure("bundle_prepare", bundleDirectory, error);
	}

	const prepared = await executeExportCommand<PreparedMaestro>(
		resolvedInstance.value,
		request.timeoutMs,
		(resultPath, exportSkillPath) =>
			`unless(isCallable('vaSessionPrepareMaestroExportV7) load(${skillString(
				exportSkillPath,
			)}))\nvaSessionPrepareMaestroExportV7(${skillString(
				request.library,
			)} ${skillString(request.cell)} ${skillString(request.view)} ${skillString(bundleDirectory)} ${skillString(
				scope,
			)} ${skillString(request.testName ?? "")} ${skillString(outputs)} ${skillString(
				request.historyName ?? "",
			)} ${skillString(schematicInstances)} ${skillString(request.outputTestName ?? "")} ${skillString(
				resultPath,
			)})`,
	);
	if (!prepared.ok) {
		return prepared;
	}
	if (prepared.value.outputsMode !== outputs) {
		return fail({
			type: "maestro_output_export_mode_mismatch",
			stage: "bundle_validation",
			message: `Cadence returned output mode ${prepared.value.outputsMode}, expected ${outputs}.`,
		});
	}
	if ((outputs === "definitions" || outputs === "all") && !prepared.value.outputDefinitionsPath) {
		return fail({
			type: "maestro_output_definitions_missing",
			stage: "bundle_validation",
			message: "Cadence did not return the requested aggregate output definitions CSV.",
		});
	}
	if (
		(outputs === "results" || outputs === "all") &&
		(!prepared.value.outputResultsPath || !prepared.value.outputResultsHistoryName)
	) {
		return fail({
			type: "maestro_output_results_missing",
			stage: "bundle_validation",
			message: "Cadence did not return the requested aggregate output results CSV and history.",
		});
	}
	if (prepared.value.schematicInstancesMode !== schematicInstances) {
		return fail({
			type: "maestro_schematic_instances_mode_mismatch",
			stage: "bundle_validation",
			message: `Cadence returned schematic instances mode ${prepared.value.schematicInstancesMode}, expected ${schematicInstances}.`,
		});
	}
	if (schematicInstances === "top-level" && !prepared.value.schematicInstancesPath) {
		return fail({
			type: "maestro_schematic_instances_missing",
			stage: "bundle_validation",
			message: "Cadence did not return the requested aggregate top-level schematic instances artifact.",
		});
	}

	const generatedAt = new Date().toISOString();
	const validationChecks: string[] = [];
	let topArtifact: BundleArtifact | undefined;
	if (prepared.value.topOceanPath) {
		const topValidation = await validateTopLevelMaestroOcean(prepared.value.topOceanPath, target);
		if (!topValidation.ok) {
			return topValidation;
		}
		const described = await describeArtifact(
			bundleDirectory,
			"ocean-maestro",
			"ocean-xl",
			prepared.value.topOceanPath,
		);
		if (!described.ok) {
			return described;
		}
		topArtifact = described.value;
		validationChecks.push(...topValidation.value);
	}

	const tests: MaestroBundleTest[] = [];
	const artifacts: ArtifactRef[] = topArtifact ? [toArtifactRef(topArtifact, bundleDirectory, generatedAt)] : [];
	for (const test of prepared.value.tests) {
		const testDirectory = join(bundleDirectory, "tests", formatTestIndex(test.index));
		const netlistDirectory = join(testDirectory, "netlist");
		const singleValidation = await validateSingleOcean(test.singleOceanPath, test.design);
		if (!singleValidation.ok) {
			return singleValidation;
		}
		const sweepValidation = await validateTestSweepOcean(test.sweepOceanPath, target, test.name);
		if (!sweepValidation.ok) {
			return sweepValidation;
		}
		const copied = await copyNetlistDirectory(test.netlistPath, netlistDirectory);
		if (!copied.ok) {
			return copied;
		}
		const primaryPath = join(netlistDirectory, "input.scs");
		const netlistValidation = await validateSpectreNetlist(primaryPath, test.design);
		if (!netlistValidation.ok) {
			return netlistValidation;
		}
		const singleArtifact = await describeArtifact(bundleDirectory, "ocean-single", "ocean", test.singleOceanPath);
		if (!singleArtifact.ok) {
			return singleArtifact;
		}
		const sweepArtifact = await describeArtifact(bundleDirectory, "ocean-sweep", "ocean-xl", test.sweepOceanPath);
		if (!sweepArtifact.ok) {
			return sweepArtifact;
		}
		const netlistArtifact = await describeArtifact(
			bundleDirectory,
			"spectre-netlist",
			"spectre-scs",
			primaryPath,
			netlistDirectory,
			test.netlistPath,
		);
		if (!netlistArtifact.ok) {
			return netlistArtifact;
		}
		const testValue: MaestroBundleTest = {
			index: test.index,
			name: test.name,
			enabled: test.enabled,
			status: "complete",
			design: test.design,
			singleOcean: singleArtifact.value,
			sweepOcean: sweepArtifact.value,
			netlist: netlistArtifact.value,
		};
		tests.push(testValue);
		artifacts.push(
			toArtifactRef(singleArtifact.value, bundleDirectory, generatedAt),
			toArtifactRef(sweepArtifact.value, bundleDirectory, generatedAt),
			toArtifactRef(netlistArtifact.value, bundleDirectory, generatedAt),
		);
		try {
			await writeFile(
				join(testDirectory, "test.json"),
				`${JSON.stringify(
					{
						index: test.index,
						name: test.name,
						enabled: test.enabled,
						design: test.design,
						oceanScripts: {
							singlePoint: "single.ocn",
							sweep: "sweep.ocn",
						},
						primaryNetlist: "netlist/input.scs",
					},
					null,
					2,
				)}\n`,
				"utf8",
			);
		} catch (error) {
			return bundleIoFailure("test_manifest_write", testDirectory, error);
		}
	}
	if (tests.length > 0) {
		validationChecks.push(
			"each single-point OCEAN script contains simulator, design, and run commands",
			"each per-test sweep OCEAN script selects only its target test in sweepsAndCorners mode",
			"each test has a freshly generated Spectre input.scs matching its configured design",
		);
	}

	let outputDefinitionsArtifact: BundleArtifact | undefined;
	if (prepared.value.outputDefinitionsPath) {
		const validation = await validateOutputCsv(
			prepared.value.outputDefinitionsPath,
			"output_definitions_validation",
			/^Test,Name,Type,Output,/m,
		);
		if (!validation.ok) {
			return validation;
		}
		if (request.outputTestName) {
			const filtered = await filterOutputCsvByTest(
				prepared.value.outputDefinitionsPath,
				/^Test,Name,Type,Output,/,
				request.outputTestName,
			);
			if (!filtered.ok) {
				return filtered;
			}
		}
		const described = await describeArtifact(
			bundleDirectory,
			"output-definitions",
			"csv",
			prepared.value.outputDefinitionsPath,
		);
		if (!described.ok) {
			return described;
		}
		outputDefinitionsArtifact = described.value;
		artifacts.push(toArtifactRef(described.value, bundleDirectory, generatedAt));
		validationChecks.push("output definitions CSV contains one aggregate table with a Test column");
	}

	let outputResultsArtifact: BundleArtifact | undefined;
	let outputResultsHistoryName: string | undefined;
	if (prepared.value.outputResultsPath || prepared.value.outputResultsHistoryName) {
		if (!prepared.value.outputResultsPath || !prepared.value.outputResultsHistoryName) {
			return fail({
				type: "maestro_output_results_incomplete",
				stage: "bundle_validation",
				message: "Cadence returned incomplete output results metadata.",
				details: {
					outputResultsPath: prepared.value.outputResultsPath,
					outputResultsHistoryName: prepared.value.outputResultsHistoryName,
				},
			});
		}
		const validation = await validateOutputCsv(
			prepared.value.outputResultsPath,
			"output_results_validation",
			/^Test,Output,/m,
		);
		if (!validation.ok) {
			return validation;
		}
		if (request.outputTestName) {
			const filtered = await filterOutputCsvByTest(
				prepared.value.outputResultsPath,
				/^Test,Output,/,
				request.outputTestName,
			);
			if (!filtered.ok) {
				return filtered;
			}
		}
		outputResultsHistoryName = prepared.value.outputResultsHistoryName;
		const resultsDirectory = join(bundleDirectory, "outputs", "results", safeName(outputResultsHistoryName));
		const resultsPath = join(resultsDirectory, "all.csv");
		try {
			await mkdir(resultsDirectory, { recursive: true });
			await rename(prepared.value.outputResultsPath, resultsPath);
		} catch (error) {
			return bundleIoFailure("output_results_move", resultsPath, error, {
				sourcePath: prepared.value.outputResultsPath,
			});
		}
		const described = await describeArtifact(bundleDirectory, "output-results", "csv", resultsPath);
		if (!described.ok) {
			return described;
		}
		outputResultsArtifact = described.value;
		artifacts.push(toArtifactRef(described.value, bundleDirectory, generatedAt));
		validationChecks.push("output results CSV contains one aggregate Detail view table with a Test column");
	}

	let schematicInstancesArtifact: BundleArtifact | undefined;
	let schematicInstancesSummary: { schematics: number; directInstances: number } | undefined;
	if (prepared.value.schematicInstancesPath) {
		const normalized = await normalizeSchematicInstancesExport(prepared.value.schematicInstancesPath);
		if (!normalized.ok) {
			return normalized;
		}
		const described = await describeArtifact(
			bundleDirectory,
			"schematic-instances",
			"json",
			prepared.value.schematicInstancesPath,
		);
		if (!described.ok) {
			return described;
		}
		schematicInstancesArtifact = described.value;
		schematicInstancesSummary = {
			schematics: normalized.value.schematics.length,
			directInstances: normalized.value.schematics.reduce(
				(total, schematic) => total + schematic.directInstanceCount,
				0,
			),
		};
		artifacts.push(toArtifactRef(described.value, bundleDirectory, generatedAt));
		validationChecks.push(
			"schematic instances artifact contains only direct top-level instances and disables recursive hierarchy export",
		);
	}

	const manifestValue = {
		schemaVersion: MAESTRO_BUNDLE_SCHEMA_VERSION,
		kind: "maestro-simulation-bundle",
		target,
		scope,
		...(scope === "test" ? { requestedTestName: request.testName } : {}),
		generatedAt,
		generator: {
			virtuosoVersion: prepared.value.virtuosoVersion,
			managedInstanceId: resolvedInstance.value.instanceId,
			maestroApplication: "Assembler",
			openMode: "read-only",
			simulationExecuted: false,
		},
		...(topArtifact ? { topLevelOcean: topArtifact } : {}),
		tests,
		...(outputs !== "none"
			? {
					outputs: {
						mode: outputs,
						...(request.outputTestName ? { testName: request.outputTestName } : {}),
						...(outputDefinitionsArtifact ? { definitions: outputDefinitionsArtifact } : {}),
						...(outputResultsArtifact && outputResultsHistoryName
							? {
									results: {
										historyName: outputResultsHistoryName,
										view: "Detail",
										artifact: outputResultsArtifact,
									},
								}
							: {}),
					},
				}
			: {}),
		...(schematicInstancesArtifact && schematicInstancesSummary
			? {
					schematicInstances: {
						mode: schematicInstances,
						hierarchyPolicy: "top-level-only",
						recursive: false,
						...schematicInstancesSummary,
						artifact: schematicInstancesArtifact,
					},
				}
			: {}),
		validation: {
			status: "passed",
			checks: validationChecks,
		},
		warnings: [],
	};
	const manifest = await writeBundleManifest(bundleDirectory, manifestValue, generatedAt);
	if (!manifest.ok) {
		return manifest;
	}
	return ok({
		target,
		kind: "maestro",
		bundleDirectory,
		manifest: manifest.value,
		artifacts,
		warnings: [],
		instance: resolvedInstance.value,
	});
}

async function resolveBundleInstance(
	request: ExportSimulationBundleRequest,
): Promise<RuntimeResult<LiveManagedVirtuosoInstance>> {
	return resolveManagedVirtuosoInstance({
		registryDir: request.registryDir,
		instanceId: request.instanceId,
		cdsLib: request.cdsLib,
		requireUi: false,
	});
}

async function executeExportCommand<TValue>(
	instance: LiveManagedVirtuosoInstance,
	timeoutMs: number | undefined,
	expression: (resultPath: string, exportSkillPath: string) => string,
): Promise<RuntimeResult<TValue>> {
	const exportSkillPath = join(dirname(instance.bridgePath), "simulation-export.il");
	const executed = await executeVirtuosoBridgeSessionCommand<TValue>({
		sessionDir: instance.sessionDir,
		heartbeatPath: instance.heartbeatPath,
		expression: (resultPath) => expression(resultPath, exportSkillPath),
		timeoutMs,
	});
	return executed.ok ? ok(executed.value.value) : executed;
}

function resolveBundleDirectory(
	request: ExportSimulationBundleRequest,
	instance: LiveManagedVirtuosoInstance,
	kind: SimulationBundleKind,
): string {
	const baseDirectory = resolve(request.outputDirectory ?? join(instance.cwd, ".virtuoso-agent", "bundles"));
	const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
	return join(
		baseDirectory,
		`${timestamp}_${kind}_${safeName(request.library)}_${safeName(request.cell)}_${randomUUID()}`,
	);
}

async function copyNetlistDirectory(
	originalPrimaryPath: string,
	destinationDirectory: string,
): Promise<RuntimeResult<void>> {
	try {
		const primary = await stat(originalPrimaryPath);
		if (!primary.isFile() || primary.size === 0) {
			return fail({
				type: "netlist_primary_invalid",
				stage: "bundle_copy",
				message: `Cadence returned an empty or non-file netlist path: ${originalPrimaryPath}`,
				details: { originalPrimaryPath },
			});
		}
		await cp(dirname(originalPrimaryPath), destinationDirectory, {
			recursive: true,
			errorOnExist: true,
			force: false,
		});
		return ok(undefined);
	} catch (error) {
		return bundleIoFailure("bundle_copy", destinationDirectory, error, { originalPrimaryPath });
	}
}

async function validateSpectreNetlist(path: string, target: CellViewRef): Promise<RuntimeResult<string[]>> {
	const content = await readRequiredText(path, "spectre_netlist_validation");
	if (!content.ok) {
		return content;
	}
	const checks = [
		["simulator lang=spectre", "netlist declares simulator lang=spectre"],
		[`// Design library name: ${target.library}`, "netlist identifies the expected design library"],
		[`// Design cell name: ${target.cell}`, "netlist identifies the expected design cell"],
		[`// Design view name: ${target.view}`, "netlist identifies the expected design view"],
	] as const;
	const missing = checks.filter(([needle]) => !content.value.includes(needle));
	if (missing.length > 0) {
		return fail({
			type: "spectre_netlist_invalid",
			stage: "bundle_validation",
			message: `Spectre netlist validation failed: ${path}`,
			details: { path, missing: missing.map(([, description]) => description) },
		});
	}
	return ok(checks.map(([, description]) => description));
}

async function validateTopLevelMaestroOcean(path: string, target: CellViewRef): Promise<RuntimeResult<string[]>> {
	const content = await readRequiredText(path, "maestro_ocean_validation");
	if (!content.ok) {
		return content;
	}
	const targetCall = `ocnxlTargetCellView( "${target.library}" "${target.cell}" "${target.view}"`;
	if (
		!content.value.includes('ocnSetXLMode("assembler")') ||
		!content.value.includes(targetCall) ||
		!content.value.includes("ocnxlBeginTest(") ||
		!/ocnxlRun\(\s*\?mode\s+'sweepsAndCorners\b/.test(content.value)
	) {
		return fail({
			type: "maestro_sweeps_ocean_invalid",
			stage: "bundle_validation",
			message: `Maestro Sweeps and Corners OCEAN validation failed: ${path}`,
			details: { path },
		});
	}
	return ok([
		"Sweeps and Corners OCEAN script uses Assembler mode",
		"Sweeps and Corners OCEAN script targets the expected Maestro cellview",
		"Sweeps and Corners OCEAN script contains Maestro tests",
		"Sweeps and Corners OCEAN script selects sweepsAndCorners run mode",
	]);
}

async function validateTestSweepOcean(
	path: string,
	target: CellViewRef,
	testName: string,
): Promise<RuntimeResult<void>> {
	const content = await readRequiredText(path, "test_sweep_ocean_validation");
	if (!content.ok) {
		return content;
	}
	const targetCall = `ocnxlTargetCellView( "${target.library}" "${target.cell}" "${target.view}"`;
	if (
		!content.value.includes('ocnSetXLMode("assembler")') ||
		!content.value.includes(targetCall) ||
		!content.value.includes(`ocnxlBeginTest("${testName}")`) ||
		content.value.includes(`ocnxlDisableTest("${testName}")`) ||
		!/ocnxlRun\(\s*\?mode\s+'sweepsAndCorners\b/.test(content.value)
	) {
		return fail({
			type: "test_sweep_ocean_invalid",
			stage: "bundle_validation",
			message: `Per-test sweep OCEAN validation failed: ${path}`,
			details: { path, testName },
		});
	}
	return ok(undefined);
}

async function validateSingleOcean(path: string, target: CellViewRef): Promise<RuntimeResult<void>> {
	const content = await readRequiredText(path, "single_ocean_validation");
	if (!content.ok) {
		return content;
	}
	const designCall = `design( "${target.library}" "${target.cell}" "schematic")`;
	const hasCadenceNetlistDesign = /design\(\s*"[^"\r\n]+\/netlist\/netlist"\s*\)/.test(content.value);
	if (
		!content.value.includes("simulator( 'spectre )") ||
		(!content.value.includes(designCall) && !hasCadenceNetlistDesign) ||
		!content.value.includes("run()")
	) {
		return fail({
			type: "single_ocean_invalid",
			stage: "bundle_validation",
			message: `Single-point OCEAN validation failed: ${path}`,
			details: { path },
		});
	}
	return ok(undefined);
}

async function readRequiredText(path: string, stage: string): Promise<RuntimeResult<string>> {
	try {
		const file = await stat(path);
		if (!file.isFile() || file.size === 0) {
			return fail({
				type: "bundle_artifact_empty",
				stage,
				message: `Required artifact is empty or is not a file: ${path}`,
				details: { path },
			});
		}
		return ok(await readFile(path, "utf8"));
	} catch (error) {
		return bundleIoFailure(stage, path, error);
	}
}

async function validateOutputCsv(path: string, stage: string, header: RegExp): Promise<RuntimeResult<void>> {
	const content = await readRequiredText(path, stage);
	if (!content.ok) {
		return content;
	}
	if (!header.test(content.value)) {
		return fail({
			type: "maestro_output_csv_invalid",
			stage: "bundle_validation",
			message: `Cadence output CSV does not contain the expected aggregate header: ${path}`,
			details: { path },
		});
	}
	return ok(undefined);
}

async function filterOutputCsvByTest(path: string, header: RegExp, testName: string): Promise<RuntimeResult<void>> {
	const content = await readRequiredText(path, "output_test_filter");
	if (!content.ok) {
		return content;
	}
	const lines = content.value.replace(/\r\n/g, "\n").split("\n");
	const headerIndex = lines.findIndex((line) => header.test(line));
	if (headerIndex === -1) {
		return fail({
			type: "maestro_output_csv_invalid",
			stage: "output_test_filter",
			message: `Could not find the expected Test column while filtering: ${path}`,
			details: { path, testName },
		});
	}
	const filtered = [
		...lines.slice(0, headerIndex + 1),
		...lines.slice(headerIndex + 1).filter((line) => line === "" || readCsvFirstField(line) === testName),
	];
	try {
		await writeFile(path, filtered.join("\n"), "utf8");
		return ok(undefined);
	} catch (error) {
		return bundleIoFailure("output_test_filter", path, error, { testName });
	}
}

function readCsvFirstField(line: string): string | undefined {
	if (!line.startsWith('"')) {
		const comma = line.indexOf(",");
		return comma === -1 ? undefined : line.slice(0, comma);
	}
	let value = "";
	for (let index = 1; index < line.length; index++) {
		const character = line[index];
		if (character !== '"') {
			value += character;
			continue;
		}
		if (line[index + 1] === '"') {
			value += '"';
			index++;
			continue;
		}
		return line[index + 1] === "," ? value : undefined;
	}
	return undefined;
}

async function normalizeSchematicInstancesExport(path: string): Promise<RuntimeResult<SchematicInstancesExport>> {
	const content = await readRequiredText(path, "schematic_instances_validation");
	if (!content.ok) {
		return content;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(content.value);
	} catch (error) {
		return fail({
			type: "maestro_schematic_instances_invalid",
			stage: "bundle_validation",
			message: `Cadence schematic instances artifact is not valid JSON: ${path}`,
			details: { path, error: error instanceof Error ? error.message : String(error) },
		});
	}
	if (!isSchematicInstancesExport(parsed)) {
		return fail({
			type: "maestro_schematic_instances_invalid",
			stage: "bundle_validation",
			message: `Cadence schematic instances artifact does not match the top-level-only schema: ${path}`,
			details: { path },
		});
	}

	const byDesign = new Map<string, SchematicInstancesEntry>();
	for (const schematic of parsed.schematics) {
		const key = JSON.stringify(schematic.design);
		const existing = byDesign.get(key);
		if (!existing) {
			byDesign.set(key, {
				...schematic,
				tests: [...new Set(schematic.tests)],
			});
			continue;
		}
		if (
			JSON.stringify(existing.boundingBox) !== JSON.stringify(schematic.boundingBox) ||
			JSON.stringify(existing.instances) !== JSON.stringify(schematic.instances)
		) {
			return fail({
				type: "maestro_schematic_instances_conflict",
				stage: "bundle_validation",
				message: `The same schematic design returned conflicting placement data: ${key}`,
				details: { path, design: schematic.design },
			});
		}
		existing.tests = [...new Set([...existing.tests, ...schematic.tests])];
	}
	const normalized: SchematicInstancesExport = {
		schemaVersion: 1,
		hierarchyPolicy: "top-level-only",
		recursive: false,
		schematics: [...byDesign.values()],
	};
	try {
		await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
		return ok(normalized);
	} catch (error) {
		return bundleIoFailure("schematic_instances_write", path, error);
	}
}

function isSchematicInstancesExport(value: unknown): value is SchematicInstancesExport {
	return (
		isRecord(value) &&
		value.schemaVersion === 1 &&
		value.hierarchyPolicy === "top-level-only" &&
		value.recursive === false &&
		Array.isArray(value.schematics) &&
		value.schematics.every(isSchematicInstancesEntry)
	);
}

function isSchematicInstancesEntry(value: unknown): value is SchematicInstancesEntry {
	return (
		isRecord(value) &&
		isCellViewRef(value.design) &&
		Array.isArray(value.tests) &&
		value.tests.every((test) => typeof test === "string") &&
		isSchematicBoundingBox(value.boundingBox) &&
		isFiniteNumber(value.directInstanceCount) &&
		Array.isArray(value.instances) &&
		value.instances.every(isSchematicDirectInstance) &&
		value.directInstanceCount === value.instances.length
	);
}

function isSchematicDirectInstance(value: unknown): value is SchematicDirectInstance {
	return (
		isRecord(value) &&
		typeof value.name === "string" &&
		isCellViewRef(value.master) &&
		isRecord(value.transform) &&
		isSchematicPoint(value.transform.origin) &&
		typeof value.transform.orientation === "string" &&
		isFiniteNumber(value.transform.magnification) &&
		isSchematicBoundingBox(value.boundingBox)
	);
}

function isCellViewRef(value: unknown): value is CellViewRef {
	return (
		isRecord(value) &&
		typeof value.library === "string" &&
		typeof value.cell === "string" &&
		typeof value.view === "string"
	);
}

function isSchematicBoundingBox(value: unknown): value is SchematicBoundingBox {
	return (
		isRecord(value) &&
		isSchematicPoint(value.lowerLeft) &&
		isSchematicPoint(value.upperRight) &&
		isFiniteNumber(value.width) &&
		isFiniteNumber(value.height)
	);
}

function isSchematicPoint(value: unknown): value is SchematicPoint {
	return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

async function describeArtifact(
	bundleDirectory: string,
	kind: BundleArtifact["kind"],
	format: BundleArtifact["format"],
	path: string,
	directory?: string,
	originalPath?: string,
): Promise<RuntimeResult<BundleArtifact>> {
	try {
		const content = await readFile(path);
		return ok({
			kind,
			format,
			path: relative(bundleDirectory, path),
			...(directory ? { directory: relative(bundleDirectory, directory) } : {}),
			...(originalPath ? { originalPath } : {}),
			sha256: createHash("sha256").update(content).digest("hex"),
		});
	} catch (error) {
		return bundleIoFailure("artifact_describe", path, error);
	}
}

async function writeBundleManifest(
	bundleDirectory: string,
	value: unknown,
	createdAt: string,
): Promise<RuntimeResult<ArtifactRef>> {
	const path = join(bundleDirectory, "bundle.json");
	try {
		await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		return ok({ kind: "simulation-bundle-manifest", format: "json", path, createdAt });
	} catch (error) {
		return bundleIoFailure("bundle_manifest_write", path, error);
	}
}

function toArtifactRef(artifact: BundleArtifact, bundleDirectory: string, createdAt: string): ArtifactRef {
	return {
		kind: artifact.kind,
		format: artifact.format === "csv" || artifact.format === "json" ? artifact.format : "text",
		path: join(bundleDirectory, artifact.path),
		createdAt,
	};
}

function toTarget(request: ExportSimulationBundleRequest): CellViewRef {
	return { library: request.library, cell: request.cell, view: request.view };
}

function formatTestIndex(index: number): string {
	return index.toString().padStart(3, "0");
}

function safeName(value: string): string {
	return value.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "") || "target";
}

function bundleIoFailure<T>(
	stage: string,
	path: string,
	error: unknown,
	details: Record<string, unknown> = {},
): RuntimeResult<T> {
	return fail({
		type: "simulation_bundle_io_error",
		stage,
		message: error instanceof Error ? error.message : String(error),
		details: { path, ...details },
	});
}
