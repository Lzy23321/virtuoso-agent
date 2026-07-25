import type { VirtuosoSchematicJsonValue } from "./virtuoso-bridge.ts";

const schematicSummaryParameterNames = new Set([
	"model",
	"Wfg",
	"w",
	"l",
	"fingers",
	"nf",
	"m",
	"r",
	"c",
	"idc",
	"vdc",
	"acm",
	"acp",
]);

export function selectSchematicAgentParameters(
	parameters: Record<string, VirtuosoSchematicJsonValue>,
): Record<string, VirtuosoSchematicJsonValue> {
	const selected = Object.fromEntries(
		Object.entries(parameters).filter(([name]) => schematicSummaryParameterNames.has(name)),
	);
	return Object.keys(selected).length > 0 ? selected : { ...parameters };
}
