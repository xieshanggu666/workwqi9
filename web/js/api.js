const API = {
  role: "investor",

  async _req(url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ "X-Role": this.role }, opts.headers || {});
    const r = await fetch(url, opts);
    if (!r.ok) {
      let msg = r.statusText;
      try { const j = await r.json(); msg = j.error || j.detail || msg; } catch (e) {}
      throw new Error(msg);
    }
    return r.json();
  },
  system() { return this._req("/api/system"); },
  market(params) {
    return this._req("/api/market", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
  },
  backtest(market, options) {
    return this._req("/api/backtest", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ market, options }),
    });
  },
  montecarlo(equity, nPaths, nSteps, seed) {
    return this._req("/api/montecarlo", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ equity, nPaths, nSteps, seed }),
    });
  },
  snapshotRun(snapshot) {
    return this._req("/api/snapshot/run", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshot }),
    });
  },

  // ---- 策略库 ----
  listStrategies() { return this._req("/api/strategies"); },
  createStrategy(payload) {
    return this._req("/api/strategies", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },
  getStrategy(id) { return this._req("/api/strategies/" + encodeURIComponent(id)); },
  updateMeta(id, payload) {
    return this._req("/api/strategies/" + encodeURIComponent(id), {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },
  createDraft(id, snapshot) {
    return this._req(`/api/strategies/${encodeURIComponent(id)}/drafts`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshot }),
    });
  },
  saveDraft(id, version, snapshot) {
    return this._req(`/api/strategies/${encodeURIComponent(id)}/versions/${version}/draft`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshot }),
    });
  },
  submitVersion(id, version) {
    return this._req(`/api/strategies/${encodeURIComponent(id)}/versions/${version}/submit`, { method: "POST" });
  },
  reviewVersion(id, version, decision, comment) {
    return this._req(`/api/strategies/${encodeURIComponent(id)}/versions/${version}/review`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, comment }),
    });
  },
  withdraw(id, comment) {
    return this._req(`/api/strategies/${encodeURIComponent(id)}/withdraw`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comment }),
    });
  },
  runVersion(id, version) {
    return this._req(`/api/strategies/${encodeURIComponent(id)}/versions/${version}/run`, { method: "POST" });
  },
  trialVersion(id, version) {
    return this._req(`/api/strategies/${encodeURIComponent(id)}/versions/${version}/trial`, { method: "POST" });
  },
};
