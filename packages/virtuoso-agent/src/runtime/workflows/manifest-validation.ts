import type { CellViewRef } from "../core/inspection.ts";
import { fail, ok, type RuntimeResult } from "../core/result.ts";
import type { VirtuosoMaestroInspect, VirtuosoSchematicInspect } from "./virtuoso-bridge.ts";

interface ManifestValidationIssue {
	path: string;
	message: string;
}

const MAX_REPORTED_ISSUES = 20;

export function validateVirtuosoSchematicInspect(
	input: unknown,
	expectedTarget?: CellViewRef,
): RuntimeResult<VirtuosoSchematicInspect> {
	const issues: ManifestValidationIssue[] = [];
	if (!isRecord(input)) {
		return invalidManifest("schematic", [{ path: "$", message: "Expected an object." }]);
	}

	expectLiteral(input.kind, "schematic-inspect", "kind", issues);
	expectLiteral(input.schemaVersion, "0.1", "schemaVersion", issues);
	validateTarget(input.target, "target", expectedTarget, issues);
	expectRecord(input.source, "source", issues);
	expectRecord(input.connectivity, "connectivity", issues);
	expectRecord(input.summary, "summary", issues);
	validateArray(input.instances, "instances", issues, validateSchematicInstance);
	validateArray(input.terminals, "terminals", issues, validateSchematicTerminal);
	validateArray(input.nets, "nets", issues, validateSchematicNet);
	validateArray(input.connections, "connections", issues, validateSchematicConnection);
	validateArray(input.references, "references", issues, (value, path, nestedIssues) => {
		if (!isRecord(value)) {
			addIssue(nestedIssues, path, "Expected an object.");
		}
	});
	validateStringArray(input.warnings, "warnings", issues);

	return issues.length > 0
		? invalidManifest("schematic", issues, input)
		: ok(input as unknown as VirtuosoSchematicInspect);
}

export function validateVirtuosoMaestroInspect(
	input: unknown,
	expectedTarget?: CellViewRef,
): RuntimeResult<VirtuosoMaestroInspect> {
	const issues: ManifestValidationIssue[] = [];
	if (!isRecord(input)) {
		return invalidManifest("maestro", [{ path: "$", message: "Expected an object." }]);
	}

	expectLiteral(input.kind, "maestro-inspect", "kind", issues);
	expectString(input.schemaVersion, "schemaVersion", issues);
	validateTarget(input.target, "target", expectedTarget, issues);
	expectRecord(input.source, "source", issues);
	validateMaestroSession(input.session, "session", issues);
	expectRecord(input.storage, "storage", issues);
	validateMaestroSummary(input.summary, "summary", issues);
	validateMaestroSetup(input.maestro, "maestro", issues);
	validateArray(input.tests, "tests", issues, validateMaestroTest);
	validateStringArray(input.warnings, "warnings", issues);

	return issues.length > 0
		? invalidManifest("maestro", issues, input)
		: ok(input as unknown as VirtuosoMaestroInspect);
}

function validateSchematicInstance(value: unknown, path: string, issues: ManifestValidationIssue[]): void {
	if (!isRecord(value)) {
		addIssue(issues, path, "Expected an object.");
		return;
	}
	expectString(value.name, `${path}.name`, issues);
	validateTarget(value.master, `${path}.master`, undefined, issues);
	expectRecord(value.placement, `${path}.placement`, issues);
	expectRecord(value.parameters, `${path}.parameters`, issues);
}

function validateSchematicTerminal(value: unknown, path: string, issues: ManifestValidationIssue[]): void {
	if (!isRecord(value)) {
		addIssue(issues, path, "Expected an object.");
		return;
	}
	expectString(value.name, `${path}.name`, issues);
	expectNullableString(value.direction, `${path}.direction`, issues);
	expectNumber(value.width, `${path}.width`, issues);
}

function validateSchematicNet(value: unknown, path: string, issues: ManifestValidationIssue[]): void {
	if (!isRecord(value)) {
		addIssue(issues, path, "Expected an object.");
		return;
	}
	expectString(value.name, `${path}.name`, issues);
	expectNullableString(value.signalType, `${path}.signalType`, issues);
	expectBoolean(value.isGlobal, `${path}.isGlobal`, issues);
	expectNumber(value.width, `${path}.width`, issues);
}

function validateSchematicConnection(value: unknown, path: string, issues: ManifestValidationIssue[]): void {
	if (!isRecord(value)) {
		addIssue(issues, path, "Expected an object.");
		return;
	}
	expectNullableString(value.net, `${path}.net`, issues);
	if (!isRecord(value.endpoint)) {
		addIssue(issues, `${path}.endpoint`, "Expected an object.");
		return;
	}
	const endpoint = value.endpoint;
	if (endpoint.kind !== "instance-terminal" && endpoint.kind !== "top-terminal") {
		addIssue(issues, `${path}.endpoint.kind`, "Expected instance-terminal or top-terminal.");
		return;
	}
	if (endpoint.kind === "instance-terminal") {
		expectString(endpoint.instance, `${path}.endpoint.instance`, issues);
	}
	expectString(endpoint.terminal, `${path}.endpoint.terminal`, issues);
	expectNullableString(endpoint.direction, `${path}.endpoint.direction`, issues);
	expectNumber(endpoint.width, `${path}.endpoint.width`, issues);
}

function validateMaestroSession(value: unknown, path: string, issues: ManifestValidationIssue[]): void {
	if (!isRecord(value)) {
		addIssue(issues, path, "Expected an object.");
		return;
	}
	expectString(value.name, `${path}.name`, issues);
	expectBoolean(value.valid, `${path}.valid`, issues);
	expectBoolean(value.singleTest, `${path}.singleTest`, issues);
	expectBoolean(value.modified, `${path}.modified`, issues);
	expectBoolean(value.closedAfterInspect, `${path}.closedAfterInspect`, issues);
}

function validateMaestroSummary(value: unknown, path: string, issues: ManifestValidationIssue[]): void {
	if (!isRecord(value)) {
		addIssue(issues, path, "Expected an object.");
		return;
	}
	for (const name of [
		"tests",
		"enabledTests",
		"globalVariables",
		"testVariableEntries",
		"uniqueTestVariables",
		"corners",
		"analysisEntries",
		"outputs",
	]) {
		expectNumber(value[name], `${path}.${name}`, issues);
	}
	if (!isRecord(value.parameters)) {
		addIssue(issues, `${path}.parameters`, "Expected an object.");
		return;
	}
	for (const name of ["total", "enabled", "disabled", "withValue"]) {
		expectNumber(value.parameters[name], `${path}.parameters.${name}`, issues);
	}
}

function validateMaestroSetup(value: unknown, path: string, issues: ManifestValidationIssue[]): void {
	if (!isRecord(value)) {
		addIssue(issues, path, "Expected an object.");
		return;
	}
	validateArray(value.globalVariables, `${path}.globalVariables`, issues);
	validateArray(value.parameters, `${path}.parameters`, issues);
}

function validateMaestroTest(value: unknown, path: string, issues: ManifestValidationIssue[]): void {
	if (!isRecord(value)) {
		addIssue(issues, path, "Expected an object.");
		return;
	}
	expectString(value.name, `${path}.name`, issues);
	expectBoolean(value.enabled, `${path}.enabled`, issues);
	if (!isRecord(value.design)) {
		addIssue(issues, `${path}.design`, "Expected an object.");
	} else {
		expectNullableString(value.design.library, `${path}.design.library`, issues);
		expectNullableString(value.design.cell, `${path}.design.cell`, issues);
		expectNullableString(value.design.view, `${path}.design.view`, issues);
	}
	expectNullableString(value.simulator, `${path}.simulator`, issues);
	validateArray(value.analyses, `${path}.analyses`, issues, (analysis, analysisPath, nestedIssues) => {
		if (!isRecord(analysis)) {
			addIssue(nestedIssues, analysisPath, "Expected an object.");
			return;
		}
		expectString(analysis.type, `${analysisPath}.type`, nestedIssues);
		expectBoolean(analysis.enabled, `${analysisPath}.enabled`, nestedIssues);
		expectRecord(analysis.effectiveSettings, `${analysisPath}.effectiveSettings`, nestedIssues);
	});
	validateArray(value.designVariables, `${path}.designVariables`, issues);
	validateArray(value.corners, `${path}.corners`, issues, validateMaestroCorner);
	validateArray(value.outputsSetup, `${path}.outputsSetup`, issues);
	if (!isRecord(value.netlist)) {
		addIssue(issues, `${path}.netlist`, "Expected an object.");
	} else {
		expectNullableString(value.netlist.directory, `${path}.netlist.directory`, issues);
		expectBoolean(value.netlist.available, `${path}.netlist.available`, issues);
	}
}

function validateMaestroCorner(value: unknown, path: string, issues: ManifestValidationIssue[]): void {
	if (!isRecord(value)) {
		addIssue(issues, path, "Expected an object.");
		return;
	}
	expectString(value.name, `${path}.name`, issues);
	validateArray(value.processCorner, `${path}.processCorner`, issues);
	validateArray(value.modelFiles, `${path}.modelFiles`, issues, (model, modelPath, nestedIssues) => {
		if (!isRecord(model)) {
			addIssue(nestedIssues, modelPath, "Expected an object.");
			return;
		}
		expectNullableString(model.configuredPath, `${modelPath}.configuredPath`, nestedIssues);
		expectNullableString(model.path, `${modelPath}.path`, nestedIssues);
		expectBoolean(model.available, `${modelPath}.available`, nestedIssues);
		expectNullableString(model.section, `${modelPath}.section`, nestedIssues);
	});
	expectRecord(value.variables, `${path}.variables`, issues);
}

function validateTarget(
	value: unknown,
	path: string,
	expected: CellViewRef | undefined,
	issues: ManifestValidationIssue[],
): void {
	if (!isRecord(value)) {
		addIssue(issues, path, "Expected an object.");
		return;
	}
	expectString(value.library, `${path}.library`, issues);
	expectString(value.cell, `${path}.cell`, issues);
	expectString(value.view, `${path}.view`, issues);
	if (
		expected &&
		(value.library !== expected.library || value.cell !== expected.cell || value.view !== expected.view)
	) {
		addIssue(issues, path, `Returned target does not match ${expected.library}/${expected.cell}/${expected.view}.`);
	}
}

function validateArray(
	value: unknown,
	path: string,
	issues: ManifestValidationIssue[],
	validateItem?: (value: unknown, path: string, issues: ManifestValidationIssue[]) => void,
): void {
	if (!Array.isArray(value)) {
		addIssue(issues, path, "Expected an array.");
		return;
	}
	if (!validateItem) {
		return;
	}
	value.forEach((item, index) => {
		validateItem(item, `${path}[${index}]`, issues);
	});
}

function validateStringArray(value: unknown, path: string, issues: ManifestValidationIssue[]): void {
	validateArray(value, path, issues, (item, itemPath, nestedIssues) => {
		expectString(item, itemPath, nestedIssues);
	});
}

function expectRecord(value: unknown, path: string, issues: ManifestValidationIssue[]): void {
	if (!isRecord(value)) {
		addIssue(issues, path, "Expected an object.");
	}
}

function expectString(value: unknown, path: string, issues: ManifestValidationIssue[]): void {
	if (typeof value !== "string") {
		addIssue(issues, path, "Expected a string.");
	}
}

function expectNullableString(value: unknown, path: string, issues: ManifestValidationIssue[]): void {
	if (value !== null && typeof value !== "string") {
		addIssue(issues, path, "Expected a string or null.");
	}
}

function expectNumber(value: unknown, path: string, issues: ManifestValidationIssue[]): void {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		addIssue(issues, path, "Expected a finite number.");
	}
}

function expectBoolean(value: unknown, path: string, issues: ManifestValidationIssue[]): void {
	if (typeof value !== "boolean") {
		addIssue(issues, path, "Expected a boolean.");
	}
}

function expectLiteral(value: unknown, expected: string, path: string, issues: ManifestValidationIssue[]): void {
	if (value !== expected) {
		addIssue(issues, path, `Expected ${JSON.stringify(expected)}.`);
	}
}

function addIssue(issues: ManifestValidationIssue[], path: string, message: string): void {
	if (issues.length < MAX_REPORTED_ISSUES) {
		issues.push({ path, message });
	}
}

function invalidManifest<T>(
	kind: "schematic" | "maestro",
	issues: ManifestValidationIssue[],
	input?: Record<string, unknown>,
): RuntimeResult<T> {
	return fail({
		type: `${kind}_manifest_invalid`,
		stage: "manifest_validation",
		message: `${kind === "schematic" ? "Schematic" : "Maestro"} manifest validation failed.`,
		details: {
			issues: issues.slice(0, MAX_REPORTED_ISSUES),
			...(typeof input?.schemaVersion === "string" ? { schemaVersion: input.schemaVersion } : {}),
			...(typeof input?.kind === "string" ? { kind: input.kind } : {}),
		},
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
