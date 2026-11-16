export function createNeonStore(BaseStore, request) {
  return class NeonStore extends BaseStore {
    constructor() { super(); this.backend = 'neon'; }
    async load() {
      const state = await request('/snapshot');
      this.data = state.data; this.initialized = state.initialized;
      return this;
    }
    async initialize() { await this.load(); this.initialized = true; }
    async commit(mutations, { guards = [], note = 'Saved from dashboard', validate } = {}) {
      if (this.busy || this.uncertain) throw new Error('Reload the journal before saving again.');
      if (!mutations.length) return;
      this.busy = true;
      const transactionId = crypto.randomUUID();
      try {
        await this.load();
        if (validate) validate(this, mutations);
        let result;
        try { result = await request('/commit', { transactionId, mutations, guards, note }); }
        catch (error) {
          if (error.uncertain) {
            try {
              await this.load();
              if (this.all('history').some(h => h.transactionId === transactionId)) return { transactionId, recovered: true };
              // A missing audit row after a lost response does not prove the write failed.
            } catch {}
            this.uncertain = true;
          }
          throw error;
        }
        try { await this.load(); }
        catch { this.uncertain = true; throw new Error('Saved to Neon, but reload failed. Reload before another save.'); }
        return result;
      } finally { this.busy = false; }
    }
  };
}
