/** Per-session capacity. A removed live child still owns its slot until its launch promise settles. */
export class WorkerPool<K> {
	private active = 0;
	private waiting = new Map<K, () => void>();
	private readonly limit: number;

	constructor(limit: number) { this.limit = Number.isSafeInteger(limit) && limit > 0 ? limit : 4; }
	isQueued(key: K) { return this.waiting.has(key); }
	remove(key: K) { this.waiting.delete(key); }
	clear() { this.waiting.clear(); }

	submit(key: K, run: (wasQueued: boolean) => Promise<void>) {
		const queued = this.active >= this.limit;
		const start = () => {
			this.active++;
			const release = () => {
				this.active--;
				const next = this.waiting.entries().next();
				if (!next.done) {
					this.waiting.delete(next.value[0]);
					next.value[1]();
				}
			};
			// A synchronous throw must still release the slot and start the next waiter.
			let running: Promise<void>;
			try { running = run(queued); } catch (error) { running = Promise.reject(error); }
			running.catch(() => {}).finally(release);
		};
		if (queued) this.waiting.set(key, start);
		else start();
	}
}

interface Batch<K, R> { key: string; count: number; active: Set<K>; results: { owner: K; result: R }[] }

/** Each launch holds one membership through queuing and execution; other groups cannot delay delivery. */
export class ResultBatches<K, R> {
	private open = new Set<Batch<K, R>>();
	private latest = new Map<string, Batch<K, R>>();
	constructor(privateLimit: number, deliver: (results: R[]) => void) { this.limit = privateLimit; this.deliver = deliver; }
	private readonly limit: number;
	private readonly deliver: (results: R[]) => void;

	join(key: string, owner: K): (result?: R) => void {
		let batch = this.latest.get(key);
		if (!batch || batch.count >= this.limit) {
			batch = { key, count: 0, active: new Set(), results: [] };
			this.latest.set(key, batch);
			this.open.add(batch);
		}
		const b = batch;
		b.count++;
		b.active.add(owner);
		return result => {
			if (!this.open.has(b) || !b.active.delete(owner)) return;
			if (result !== undefined) b.results.push({ owner, result });
			this.flush(b);
		};
	}
	remove(owner: K) {
		for (const b of this.open) {
			b.active.delete(owner);
			b.results = b.results.filter(r => r.owner !== owner);
			this.flush(b);
		}
	}
	clear() { this.latest.clear(); this.open.clear(); }
	private flush(b: Batch<K, R>) {
		if (b.active.size) return;
		this.open.delete(b);
		if (this.latest.get(b.key) === b) this.latest.delete(b.key);
		if (b.results.length) this.deliver(b.results.map(r => r.result));
	}
}
