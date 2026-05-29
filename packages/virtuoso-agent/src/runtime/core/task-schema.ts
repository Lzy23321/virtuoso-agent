import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { fail, ok, type RuntimeResult } from "./result.ts";

export type SimulationBackend = "fake" | "spectre" | "ocean" | "ocean-xl";

export interface TaskDocument {
	name: string;
	parameters?: Record<
		string,
		{
			value: string | number | boolean;
			min?: string | number;
			max?: string | number;
		}
	>;
	simulation?: {
		backend: SimulationBackend;
		script?: string;
		netlist?: string;
		spectre?: {
			format?: "psfbin" | "psfxl";
			mode64?: boolean;
			escchars?: boolean;
			preset?: string;
			multithread?: boolean;
			lqtimeout?: number;
			maxWarnings?: number;
			maxNotices?: number;
			env?: string;
			ahdlLibDir?: string;
			logStatus?: boolean;
			additionalArgs?: string[];
		};
	};
	outputs?: Array<{
		name: string;
		target?: string;
	}>;
	safety?: {
		allowWrite?: boolean;
		dryRun?: boolean;
	};
}

export interface TaskValidationIssue {
	path: string;
	message: string;
}

export interface TaskValidationResult {
	task: TaskDocument;
	issues: TaskValidationIssue[];
}

export function validateTaskObject(input: unknown): RuntimeResult<TaskValidationResult> {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return fail({
			type: "task_schema_error",
			stage: "task_validation",
			message: "Task must be an object.",
		});
	}

	const task = input as Partial<TaskDocument>;
	const issues: TaskValidationIssue[] = [];

	if (typeof task.name !== "string" || task.name.trim() === "") {
		issues.push({ path: "name", message: "Task name is required." });
	}

	if (task.parameters !== undefined) {
		validateParameters(task.parameters, issues);
	}

	if (task.simulation !== undefined) {
		validateSimulation(task.simulation, issues);
	}

	if (task.outputs !== undefined) {
		validateOutputs(task.outputs, issues);
	}

	if (task.safety !== undefined) {
		validateSafety(task.safety, issues);
	}

	if (issues.length > 0) {
		return ok({ task: task as TaskDocument, issues });
	}

	return ok({ task: task as TaskDocument, issues });
}

function validateSimulation(input: unknown, issues: TaskValidationIssue[]): void {
	if (!isPlainObject(input)) {
		issues.push({ path: "simulation", message: "simulation must be an object." });
		return;
	}

	const backend = input.backend;
	if (!isSimulationBackend(backend)) {
		issues.push({ path: "simulation.backend", message: "backend must be fake, spectre, ocean, or ocean-xl." });
	}

	if (input.script !== undefined && !isNonEmptyString(input.script)) {
		issues.push({ path: "simulation.script", message: "simulation script must be a non-empty string." });
	}
	if (input.netlist !== undefined && !isNonEmptyString(input.netlist)) {
		issues.push({ path: "simulation.netlist", message: "simulation netlist must be a non-empty string." });
	}

	if (!isSimulationBackend(backend)) {
		return;
	}

	if (backend === "spectre" && !isNonEmptyString(input.netlist)) {
		issues.push({ path: "simulation.netlist", message: "spectre backend requires a netlist path." });
	}
	if ((backend === "ocean" || backend === "ocean-xl") && !isNonEmptyString(input.script)) {
		issues.push({ path: "simulation.script", message: `${backend} backend requires a script path.` });
	}
	if (input.spectre !== undefined) {
		validateSpectreOptions(input.spectre, issues);
	}
}

function validateSpectreOptions(input: unknown, issues: TaskValidationIssue[]): void {
	if (!isPlainObject(input)) {
		issues.push({ path: "simulation.spectre", message: "spectre options must be an object." });
		return;
	}

	if (input.format !== undefined && input.format !== "psfbin" && input.format !== "psfxl") {
		issues.push({ path: "simulation.spectre.format", message: "spectre format must be psfbin or psfxl." });
	}
	validateOptionalBoolean(input.mode64, "simulation.spectre.mode64", issues);
	validateOptionalBoolean(input.escchars, "simulation.spectre.escchars", issues);
	validateOptionalBoolean(input.multithread, "simulation.spectre.multithread", issues);
	validateOptionalBoolean(input.logStatus, "simulation.spectre.logStatus", issues);
	validateOptionalString(input.preset, "simulation.spectre.preset", issues);
	validateOptionalString(input.env, "simulation.spectre.env", issues);
	validateOptionalString(input.ahdlLibDir, "simulation.spectre.ahdlLibDir", issues);
	validateOptionalNumber(input.lqtimeout, "simulation.spectre.lqtimeout", issues);
	validateOptionalNumber(input.maxWarnings, "simulation.spectre.maxWarnings", issues);
	validateOptionalNumber(input.maxNotices, "simulation.spectre.maxNotices", issues);

	if (
		input.additionalArgs !== undefined &&
		(!Array.isArray(input.additionalArgs) || input.additionalArgs.some((arg) => typeof arg !== "string"))
	) {
		issues.push({ path: "simulation.spectre.additionalArgs", message: "spectre additionalArgs must be strings." });
	}
}

function validateParameters(input: unknown, issues: TaskValidationIssue[]): void {
	if (!isPlainObject(input)) {
		issues.push({ path: "parameters", message: "parameters must be an object." });
		return;
	}

	for (const [name, parameter] of Object.entries(input)) {
		const path = `parameters.${name}`;
		if (!isPlainObject(parameter)) {
			issues.push({ path, message: "parameter must be an object." });
			continue;
		}

		if (!isParameterValue(parameter.value)) {
			issues.push({ path: `${path}.value`, message: "parameter value must be a string, number, or boolean." });
		}
		if (parameter.min !== undefined && !isParameterBound(parameter.min)) {
			issues.push({ path: `${path}.min`, message: "parameter min must be a string or number." });
		}
		if (parameter.max !== undefined && !isParameterBound(parameter.max)) {
			issues.push({ path: `${path}.max`, message: "parameter max must be a string or number." });
		}
	}
}

function validateOutputs(input: unknown, issues: TaskValidationIssue[]): void {
	if (!Array.isArray(input)) {
		issues.push({ path: "outputs", message: "outputs must be an array." });
		return;
	}

	input.forEach((output, index) => {
		const path = `outputs.${index}`;
		if (!isPlainObject(output)) {
			issues.push({ path, message: "output must be an object." });
			return;
		}

		if (typeof output.name !== "string" || output.name.trim() === "") {
			issues.push({ path: `${path}.name`, message: "output name is required." });
		}
		if (output.target !== undefined && typeof output.target !== "string") {
			issues.push({ path: `${path}.target`, message: "output target must be a string." });
		}
	});
}

function validateSafety(input: unknown, issues: TaskValidationIssue[]): void {
	if (!isPlainObject(input)) {
		issues.push({ path: "safety", message: "safety must be an object." });
		return;
	}

	if (input.allowWrite !== undefined && typeof input.allowWrite !== "boolean") {
		issues.push({ path: "safety.allowWrite", message: "allowWrite must be a boolean." });
	}
	if (input.dryRun !== undefined && typeof input.dryRun !== "boolean") {
		issues.push({ path: "safety.dryRun", message: "dryRun must be a boolean." });
	}
}

function isPlainObject(input: unknown): input is Record<string, unknown> {
	return input !== null && typeof input === "object" && !Array.isArray(input);
}

function isSimulationBackend(input: unknown): input is SimulationBackend {
	return input === "fake" || input === "spectre" || input === "ocean" || input === "ocean-xl";
}

function isNonEmptyString(input: unknown): input is string {
	return typeof input === "string" && input.trim() !== "";
}

function isParameterValue(input: unknown): input is string | number | boolean {
	return typeof input === "string" || typeof input === "number" || typeof input === "boolean";
}

function isParameterBound(input: unknown): input is string | number {
	return typeof input === "string" || typeof input === "number";
}

function validateOptionalBoolean(input: unknown, path: string, issues: TaskValidationIssue[]): void {
	if (input !== undefined && typeof input !== "boolean") {
		issues.push({ path, message: "value must be a boolean." });
	}
}

function validateOptionalString(input: unknown, path: string, issues: TaskValidationIssue[]): void {
	if (input !== undefined && typeof input !== "string") {
		issues.push({ path, message: "value must be a string." });
	}
}

function validateOptionalNumber(input: unknown, path: string, issues: TaskValidationIssue[]): void {
	if (input !== undefined && typeof input !== "number") {
		issues.push({ path, message: "value must be a number." });
	}
}

export async function validateTaskFile(path: string): Promise<RuntimeResult<TaskValidationResult>> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		return fail({
			type: "task_read_error",
			stage: "task_validation",
			message: error instanceof Error ? error.message : String(error),
			details: { path },
		});
	}

	if (extname(path) !== ".json") {
		return fail({
			type: "task_schema_error",
			stage: "task_validation",
			message:
				"The initial scaffold supports JSON task files only. YAML support will be added with the real parser.",
			details: { path },
		});
	}

	try {
		return validateTaskObject(JSON.parse(raw));
	} catch (error) {
		return fail({
			type: "task_parse_error",
			stage: "task_validation",
			message: error instanceof Error ? error.message : String(error),
			details: { path },
		});
	}
}
