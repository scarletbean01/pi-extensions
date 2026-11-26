/** Host backend identity and manifest helper (dependency-free to avoid circular imports). */

export type HostBackendName = "herdr" | "hc";
export const HOST_BACKENDS: readonly HostBackendName[] = ["herdr", "hc"];

export type HostNodeRef = Record<string, unknown>;

export function hostBackendOf(manifest: { host_backend?: HostBackendName }): HostBackendName {
	return manifest.host_backend ?? "herdr";
}
