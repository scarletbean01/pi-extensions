import { heldReleasedAttempt, type factoryOperations, type Inspection, type LaunchResult, type ManagerAuthority } from "./operations.ts";

/** The managing Pi adapter: observe first, settle proven work, then dispatch only the observed eligible head. */
export function createFactoryQueueScheduler(options: {
	factory: ReturnType<typeof factoryOperations>;
	factoryId: string;
	authority: ManagerAuthority;
	assertAuthority?: () => void;
	assertAuthorityAndTrust?: (projectCwd?: string) => void;
	onInspection?: (view: Inspection) => void;
	onLaunch?: (result: LaunchResult) => void | Promise<void>;
}) {
	const { factory, factoryId, authority, assertAuthorityAndTrust } = options;
	const inspect = () => {
		const view = factory({ action: "inspect", factory_id: factoryId });
		options.onInspection?.(view);
		return view;
	};
	let inFlight: Promise<void> | undefined;
	return {
		advance(): Promise<void> {
			return inFlight ??= Promise.resolve().then(async () => {
				let view = inspect();
				if (view.factory.management !== "managed") return;
				if (heldReleasedAttempt(view)?.settlement?.execution_settlement.state === "settled" && !view.uncertainty.length) {
					const settled = await factory({ action: "settle_run", factory_id: factoryId, authority, assertAuthority: options.assertAuthority });
					if (!settled.settled) return; // the evidence changed at the settlement gate
					view = inspect();
				}
				const { eligible, input_id } = view.head_status;
				if (!eligible || !input_id) return;
				const result = await factory({ action: "launch", factory_id: factoryId, input_id, authority, assertAuthorityAndTrust });
				await options.onLaunch?.(result);
				inspect();
			}).finally(() => { inFlight = undefined; });
		},
	};
}
