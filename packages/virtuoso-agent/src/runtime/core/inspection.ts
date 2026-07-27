export interface CellViewRef {
	library: string;
	cell: string;
	view: string;
}

export type ArtifactFormat = "json" | "text" | "log" | "csv" | "binary";

export interface ArtifactRef {
	kind: string;
	format: ArtifactFormat;
	path: string;
	createdAt: string;
}
