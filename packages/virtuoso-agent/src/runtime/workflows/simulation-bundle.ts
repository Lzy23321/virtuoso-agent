import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
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
export type MaestroExportScope = "all" | "top" | "tests" | "test";

export interface ExportSimulationBundleRequest extends ManagedVirtuosoRequest {
	library: string;
	cell: string;
	view: string;
	outputDirectory?: string;
	scope?: MaestroExportScope;
	testName?: string;
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
}

interface BundleArtifact {
	kind: "spectre-netlist" | "ocean-maestro" | "ocean-single" | "ocean-sweep";
	format: "spectre-scs" | "ocean" | "ocean-xl";
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

const SCHEMATIC_BUNDLE_SCHEMA_VERSION = 1;
const MAESTRO_BUNDLE_SCHEMA_VERSION = 2;

export async function exportManagedSchematicBundle(
	request: ExportSimulationBundleRequest,
): Promise<RuntimeResult<SimulationBundleResult>> {
	const resolvedInstance = await resolveBundleInstance(request);
	if (!resolvedInstance.ok) {
		return resolvedInstance;
	}
	const target = toTarget(request);
	const bundleDirectory = resolveBundleDirectory(request, resolvedInstance.value, "schematic");
	const netlistDirectory = join(bundleDirectory, "schematic", "netlist");
	try {
		await mkdir(dirname(netlistDirectory), { recursive: true });
	} catch (error) {
		return bundleIoFailure("bundle_prepare", bundleDirectory, error);
	}

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
	const generatedAt = new Date().toISOString();
	const netlistArtifact = await describeArtifact(
		bundleDirectory,
		"spectre-netlist",
		"spectre-scs",
		primaryPath,
		netlistDirectory,
		exported.value.path,
	);
	if (!netlistArtifact.ok) {
		return netlistArtifact;
	}
	const manifestValue = {
		schemaVersion: SCHEMATIC_BUNDLE_SCHEMA_VERSION,
		kind: "schematic-netlist-bundle",
		target,
		generatedAt,
		generator: {
			virtuosoVersion: exported.value.virtuosoVersion ?? null,
			managedInstanceId: resolvedInstance.value.instanceId,
			simulationExecuted: false,
		},
		artifacts: [netlistArtifact.value],
		validation: {
			status: "passed",
			checks: validated.value,
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
		artifacts: [toArtifactRef(netlistArtifact.value, bundleDirectory, generatedAt)],
		warnings: [],
		instance: resolvedInstance.value,
	});
}

export async function exportManagedMaestroBundle(
	request: ExportSimulationBundleRequest,
): Promise<RuntimeResult<SimulationBundleResult>> {
	const scope = request.scope ?? "all";
	if (scope === "test" && !request.testName) {
		return fail({
			type: "maestro_test_name_required",
			stage: "bundle_prepare",
			message: "testName is required when Maestro export scope is test.",
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
	} catch (error) {
		return bundleIoFailure("bundle_prepare", bundleDirectory, error);
	}

	const prepared = await executeExportCommand<PreparedMaestro>(
		resolvedInstance.value,
		request.timeoutMs,
		(resultPath, exportSkillPath) =>
			`unless(isCallable('vaSessionPrepareMaestroExportV4) load(${skillString(
				exportSkillPath,
			)}))\nvaSessionPrepareMaestroExportV4(${skillString(
				request.library,
			)} ${skillString(request.cell)} ${skillString(request.view)} ${skillString(bundleDirectory)} ${skillString(
				scope,
			)} ${skillString(request.testName ?? "")} ${skillString(resultPath)})`,
	);
	if (!prepared.ok) {
		return prepared;
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
		format: "text",
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
