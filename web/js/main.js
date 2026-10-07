const { createApp } = Vue;

function smaArr(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

// 沙箱表单初值（与 engine/snapshot.defaultSnapshot 一致）
function defaultModel() {
  return {
    market: { seed: 42, days: 400, start: 100, drift: 0.0004, vol: 0.012 },
    strategy: { type: "ma_cross", fast: 10, slow: 30, rsiN: 14, rsiBuy: 30, rsiSell: 70, bbN: 20, bbK: 2 },
    options: {
      cash: 100000, feeRate: 0.0005, slippageBp: 5, positionRatio: 1,
      stopMode: "fixed", stopLoss: 0.05, takeProfit: 0.15,
      atrN: 14, atrStopMult: 2, atrTargetMult: 4, atrVolN: 50,
      volLowK: 0.7, volHighK: 1.3, volLowMult: 0.8, volHighMult: 1.5,
      riskFree: 0.02, periodsPerYear: 252,
    },
    montecarlo: { nPaths: 300, nSteps: 252, seedStrategy: "market_offset", seed: 43 },
  };
}

function cloneModel(m) {
  return JSON.parse(JSON.stringify(m));
}

const app = createApp({
  data() {
    return {
      busy: false,
      role: "investor",
      tab: "library",
      // 沙箱表单
      form: defaultModel(),
      // 策略库
      strategies: [],
      current: null,
      newTitle: "",
      // 草稿编辑器
      editor: { open: false, version: null },
      editModel: defaultModel(),
      // 结果
      stats: null,
      trades: [],
      equity: null,
      drawdown: null,
      rows: null,
      mcQuant: null,
      mcProb: null,
      mcPaths: 0,
      mcSteps: 0,
      source: null,
    };
  },
  computed: {
    // 编辑草稿时表单绑定到 editModel，否则绑定沙箱 form
    model() {
      return this.editor.open ? this.editModel : this.form;
    },
    mcProbLabel() {
      return this.mcProb == null ? "—" : (this.mcProb * 100).toFixed(1) + "%";
    },
    canCreateDraft() {
      if (!this.current || this.role !== "author") return false;
      return !this.current.versions.some(v => ["draft", "in_review", "rejected"].includes(v.status));
    },
  },
  methods: {
    // ---------- 角色 / 标签 ----------
    async changeRole() {
      API.role = this.role;
      this.strategies = [];
      this.current = null;
      this.closeEditor();
      await this.loadList();
    },
    async switchTab(t) {
      this.tab = t;
      if (t === "library") {
        this.closeEditor();
        await this.loadList();
      }
    },

    // ---------- 策略库 ----------
    async loadList() {
      const r = await API.listStrategies();
      this.strategies = r.strategies;
    },
    async openStrategy(id) {
      const r = await API.getStrategy(id);
      this.current = r.strategy;
    },
    async createStrategy() {
      const title = this.newTitle.trim();
      if (!title) return;
      this.busy = true;
      try {
        const r = await API.createStrategy({ title, snapshot: this.snapshotFromModel(this.form) });
        this.current = r.strategy;
        this.newTitle = "";
        await this.loadList();
      } catch (e) {
        alert("创建失败：" + e.message);
      } finally {
        this.busy = false;
      }
    },
    async newDraft() {
      this.busy = true;
      try {
        // 以当前发布版本（否则最后一个版本）的快照为新草稿初值
        const base = this.current.versions.find(v => v.is_current)
          || this.current.versions[this.current.versions.length - 1];
        const r = await API.createDraft(this.current.id, base.snapshot);
        this.current = r.strategy;
        const v = this.current.versions[this.current.versions.length - 1];
        this.openEditor(v);
        await this.loadList();
      } catch (e) {
        alert("新建草稿失败：" + e.message);
      } finally {
        this.busy = false;
      }
    },
    async withdraw() {
      const comment = prompt("撤回说明（可选）：", "");
      if (comment === null) return;
      this.busy = true;
      try {
        const r = await API.withdraw(this.current.id, comment);
        this.current = r.strategy;
        await this.loadList();
      } catch (e) {
        alert("撤回失败：" + e.message);
      } finally {
        this.busy = false;
      }
    },

    // ---------- 草稿编辑 ----------
    openEditor(v) {
      this.editor = { open: true, version: v.version };
      this.editModel = this.modelFromSnapshot(v.snapshot);
      this.tab = "library";
    },
    cancelEditor() {
      this.closeEditor();
    },
    closeEditor() {
      this.editor = { open: false, version: null };
    },
    currentEditVersion() {
      return this.current.versions.find(v => v.version === this.editor.version);
    },
    async saveDraft() {
      this.busy = true;
      try {
        const r = await API.saveDraft(this.current.id, this.editor.version, this.snapshotFromModel(this.editModel));
        this.current = r.strategy;
        alert("草稿已保存");
      } catch (e) {
        alert("保存失败：" + e.message);
      } finally {
        this.busy = false;
      }
    },
    async saveAndSubmit() {
      this.busy = true;
      try {
        let r = await API.saveDraft(this.current.id, this.editor.version, this.snapshotFromModel(this.editModel));
        r = await API.submitVersion(this.current.id, this.editor.version);
        this.current = r.strategy;
        this.closeEditor();
        await this.loadList();
      } catch (e) {
        alert("送审失败：" + e.message);
      } finally {
        this.busy = false;
      }
    },
    async trialDraft() {
      this.busy = true;
      try {
        // 先保存再试算，保证试算看到的就是当前编辑参数
        const r0 = await API.saveDraft(this.current.id, this.editor.version, this.snapshotFromModel(this.editModel));
        this.current = r0.strategy;
        const out = await API.trialVersion(this.current.id, this.editor.version);
        this.applyResult(out, {
          label: `${this.current.title} v${this.editor.version} 草稿试算（不留痕）`,
          hash: out.snapshot_hash, runId: null, mcSeed: out.mc_seed,
        });
      } catch (e) {
        alert("试算失败：" + e.message);
      } finally {
        this.busy = false;
      }
    },

    // ---------- 评审 ----------
    async decide(version, decision) {
      let comment = "";
      if (decision === "reject") {
        comment = prompt("驳回意见（将退回作者修改）：", "");
        if (comment === null) return;
      } else {
        comment = prompt("通过意见（可选）：", "") || "";
      }
      this.busy = true;
      try {
        const r = await API.reviewVersion(this.current.id, version, decision, comment);
        this.current = r.strategy;
        await this.loadList();
      } catch (e) {
        alert("审批失败：" + e.message);
      } finally {
        this.busy = false;
      }
    },
    async submitFromList(v) {
      this.busy = true;
      try {
        const r = await API.submitVersion(this.current.id, v.version);
        this.current = r.strategy;
        await this.loadList();
      } catch (e) {
        alert("送审失败：" + e.message);
      } finally {
        this.busy = false;
      }
    },

    // ---------- 运行 ----------
    async runVersion(version) {
      this.busy = true;
      try {
        const r = await API.runVersion(this.current.id, version);
        this.current = r.strategy;
        const out = r.result;
        const st = this.current.versions.find(v => v.version === version).status_label;
        this.applyResult(out, {
          label: `${this.current.title} v${version}（${st}）`,
          hash: r.run.snapshot_hash, runId: r.run.id, mcSeed: r.run.mc_seed,
        });
      } catch (e) {
        alert("运行失败：" + e.message);
      } finally {
        this.busy = false;
      }
    },
    async trialStored(version) {
      this.busy = true;
      try {
        const out = await API.trialVersion(this.current.id, version);
        this.applyResult(out, {
          label: `${this.current.title} v${version} 草稿试算（不留痕）`,
          hash: out.snapshot_hash, runId: null, mcSeed: out.mc_seed,
        });
      } catch (e) {
        alert("试算失败：" + e.message);
      } finally {
        this.busy = false;
      }
    },
    async runAll() {
      this.busy = true;
      try {
        const out = await API.snapshotRun(this.snapshotFromModel(this.form));
        this.applyResult(out, { label: "沙箱即席试算（不入库）", hash: out.snapshot_hash, runId: null, mcSeed: out.mc_seed });
      } catch (e) {
        alert("执行失败：" + e.message);
      } finally {
        this.busy = false;
      }
    },
    async saveAsNewStrategy() {
      const title = prompt("策略名称：", "我的策略 " + new Date().toLocaleDateString());
      if (!title || !title.trim()) return;
      this.busy = true;
      try {
        const r = await API.createStrategy({ title: title.trim(), snapshot: this.snapshotFromModel(this.form) });
        this.current = r.strategy;
        this.tab = "library";
        await this.loadList();
        this.openEditor(this.current.versions[0]);
      } catch (e) {
        alert("保存失败：" + e.message);
      } finally {
        this.busy = false;
      }
    },

    // ---------- 结果渲染 ----------
    applyResult(out, source) {
      this.stats = out.stats;
      this.trades = out.trades || [];
      this.equity = out.equity;
      this.drawdown = out.drawdown;
      this.rows = out.rows;
      this.mcQuant = out.montecarlo && out.montecarlo.quantiles;
      this.mcProb = out.montecarlo ? out.montecarlo.prob_loss : null;
      this.mcPaths = out.montecarlo && out.montecarlo.paths ? out.montecarlo.paths.length : 0;
      this.mcSteps = out.montecarlo ? out.montecarlo.steps : 0;
      this.source = source;
      this.$nextTick(() => this.drawCharts());
    },
    drawCharts() {
      const close = this.rows.map(x => x.close);
      const overlays = [];
      const st = this.source ? this._drawnStrategy() : null;
      if (st && st.type === "ma_cross") {
        overlays.push({ color: "#ffd166", data: smaArr(close, st.fast) });
        overlays.push({ color: "#7a5cff", data: smaArr(close, st.slow) });
      }
      Charts.kline(this.$refs.kchart, this.rows, overlays);
      Charts.series(this.$refs.echart, this.equity, { color: "#4f8cff" });
      if (this.mcQuant && this.$refs.mchart) Charts.band(this.$refs.mchart, this.mcQuant, {});
    },
    _drawnStrategy() {
      // 结果对应的策略参数：版本运行/草稿试算取版本快照，沙箱取当前表单
      if (this.editor.open) return this.editModel.strategy;
      if (this.current && this.source && /v\d+/.test(this.source.label)) {
        const m = this.source.label.match(/v(\d+)/);
        const v = this.current.versions.find(x => x.version === parseInt(m[1], 10));
        if (v) return v.snapshot.strategy;
      }
      return this.form.strategy;
    },

    // ---------- 快照/表单转换 ----------
    snapshotFromModel(m) {
      return cloneModel(m);
    },
    modelFromSnapshot(s) {
      const d = defaultModel();
      return {
        market: { ...d.market, ...s.market },
        strategy: { ...d.strategy, ...s.strategy },
        options: { ...d.options, ...s.options },
        montecarlo: { ...d.montecarlo, ...s.montecarlo },
      };
    },

    // ---------- 展示辅助 ----------
    stLabel(st) {
      return { draft: "草稿", in_review: "评审中", published: "已发布", rejected: "已驳回", withdrawn: "已撤回" }[st] || st;
    },
    roleLabel(r) {
      return { author: "作者", reviewer: "评审员", investor: "投资者" }[r] || r;
    },
    fmtTime(t) {
      if (!t) return "—";
      return t.replace("T", " ").slice(0, 16);
    },
  },
  async mounted() {
    API.role = this.role;
    await this.loadList().catch(() => {});
    // 沙箱结果预热
    this.runAll();
  },
});

app.mount("#app");
