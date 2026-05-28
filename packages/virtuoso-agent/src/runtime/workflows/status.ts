export interface VirtuosoStatus {
	package: string;
	mode: "scaffold";
	bridgeConnected: boolean;
	message: string;
}

export async function getVirtuosoStatus(): Promise<VirtuosoStatus> {
	return {
		package: "@lzy23321/virtuoso-agent",
		mode: "scaffold",
		bridgeConnected: false,
		message: "Virtuoso runtime scaffold is installed. Real bridge connection is not implemented yet.",
	};
}
