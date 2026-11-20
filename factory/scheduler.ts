/**
 * A deliberately single-head queue driver. The adapter supplies only the current FIFO head;
 * launch remains responsible for authoritative eligibility, fencing and capacity checks.
 */
export function createFactoryQueueScheduler(options: {
	queue: () => readonly string[];
	launch: (inputId: string) => Promise<unknown>;
}) {
	let inFlight: Promise<void> | undefined;
	return {
		advance(): Promise<void> {
			if (inFlight) return inFlight;
			const head = options.queue()[0];
			if (!head) return Promise.resolve();
			inFlight = (async () => {
				try { await options.launch(head); }
				catch { /* the persisted head/blocker remains authoritative; try again on a later tick */ }
			})();
			return inFlight.finally(() => { inFlight = undefined; });
		},
	};
}
