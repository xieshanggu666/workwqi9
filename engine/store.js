"use strict";
// 策略库存储：策略 / 版本 / 运行记录的状态机与持久化。
//
// 版本生命周期（每个策略线性递增版本号，版本记录只追加、不改写、不删除）：
//   draft（草稿）  --作者送审-->   in_review（评审中）
//   in_review      --评审员通过--> published（已发布，成为当前发布版本）
//   in_review      --评审员驳回--> rejected（已驳回，作者可改后重新送审）
//   rejected       --作者修改-->   draft（回到草稿）
//   published      --作者撤回-->   withdrawn（撤回）
// 每个策略至多一个「开放中」版本（draft / in_review / rejected）；发布或撤回后
// 才能基于当前参数新建下一版草稿。已发布的旧版本永久保留、可直接回测。
const fs = require("fs");
const path = require("path");
const snapMod = require("./snapshot");
const { runSnapshot } = require("./runner");

const ROLES = ["author", "reviewer", "investor"];
const OPEN_STATES = ["draft", "in_review", "rejected"];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function nowIso() {
  return new Date().toISOString();
}

class Store {
  constructor(file) {
    this.file = file;
    this.data = { strategies: [], runs: [] };
    if (file && fs.existsSync(file)) {
      this.data = JSON.parse(fs.readFileSync(file, "utf8"));
    }
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  reset() {
    this.data = { strategies: [], runs: [] };
    this.save();
  }

  _getStrategy(id) {
    const s = this.data.strategies.find(x => x.id === id);
    if (!s) throw new HttpError(404, "策略不存在");
    return s;
  }

  _getVersion(s, version) {
    const v = s.versions.find(x => x.version === version);
    if (!v) throw new HttpError(404, `版本 v${version} 不存在`);
    return v;
  }

  _openVersion(s) {
    return s.versions.find(v => OPEN_STATES.includes(v.status)) || null;
  }

  // ---- 策略 ----

  createStrategy(role, { title, description, snapshot }) {
    if (role !== "author") throw new HttpError(403, "仅策略作者可创建策略");
    if (!title || !String(title).trim()) throw new HttpError(400, "策略名称不能为空");
    const id = "st_" + (this.data.strategies.reduce((m, x) => Math.max(m, Number(x.id.slice(3)) || 0), 0) + 1);
    const s = {
      id,
      title: String(title).trim(),
      description: String(description || ""),
      author: role,
      published_version: null,
      created_at: nowIso(),
      versions: [],
    };
    this.data.strategies.push(s);
    this._newDraft(s, snapshot, true);
    this.save();
    return s;
  }

  updateMeta(role, id, patch) {
    if (role !== "author") throw new HttpError(403, "仅策略作者可修改策略信息");
    const s = this._getStrategy(id);
    if (patch.title !== undefined) {
      if (!String(patch.title).trim()) throw new HttpError(400, "策略名称不能为空");
      s.title = String(patch.title).trim();
    }
    if (patch.description !== undefined) s.description = String(patch.description);
    this.save();
    return s;
  }

  // ---- 版本 ----

  _newDraft(s, snapshotInput, isFirst) {
    const open = this._openVersion(s);
    if (open && !isFirst) throw new HttpError(409, `v${open.version} 尚未关闭（${open.status}），请先送审/发布/撤回后再新建版本`);
    const snapshot = snapMod.normalize(snapshotInput || snapMod.defaultSnapshot());
    const version = (s.versions.length ? s.versions[s.versions.length - 1].version : 0) + 1;
    const v = {
      version,
      status: "draft",
      snapshot,
      snapshot_hash: snapMod.hashSnapshot(snapshot),
      base_version: s.published_version,
      created_at: nowIso(),
      submitted_at: null,
      published_at: null,
      withdrawn_at: null,
      review: null,
    };
    s.versions.push(v);
    return v;
  }

  // 新建下一版草稿（从当前发布版本复制参数起步）；首个草稿随策略创建一并产生。
  createDraft(role, id, snapshot) {
    if (role !== "author") throw new HttpError(403, "仅策略作者可新建版本草稿");
    const s = this._getStrategy(id);
    const v = this._newDraft(s, snapshot || undefined, false);
    this.save();
    return v;
  }

  // 修改草稿（或被驳回版本）参数：仅在版本冻结前允许；送审后快照只读。
  saveDraft(role, id, version, patch) {
    if (role !== "author") throw new HttpError(403, "仅策略作者可保存草稿");
    const s = this._getStrategy(id);
    const v = this._getVersion(s, version);
    if (v.status !== "draft" && v.status !== "rejected") {
      throw new HttpError(409, `v${version} 当前为「${statusLabel(v.status)}」，参数已冻结，不能修改`);
    }
    const merged = {
      market: { ...v.snapshot.market, ...(patch.market || {}) },
      strategy: { ...v.snapshot.strategy, ...(patch.strategy || {}) },
      options: { ...v.snapshot.options, ...(patch.options || {}) },
      montecarlo: { ...v.snapshot.montecarlo, ...(patch.montecarlo || {}) },
    };
    v.snapshot = snapMod.normalize(merged);
    v.snapshot_hash = snapMod.hashSnapshot(v.snapshot);
    if (v.status === "rejected") v.status = "draft";
    this.save();
    return v;
  }

  // 送审：此刻冻结快照（深冻结并留哈希），评审与运行都以冻结内容为准。
  submit(role, id, version) {
    if (role !== "author") throw new HttpError(403, "仅策略作者可送审");
    const s = this._getStrategy(id);
    const v = this._getVersion(s, version);
    if (v.status !== "draft" && v.status !== "rejected") {
      throw new HttpError(409, `v${version} 当前为「${statusLabel(v.status)}」，不能送审`);
    }
    v.status = "in_review";
    v.submitted_at = nowIso();
    v.review = null;
    snapMod.deepFreeze(v.snapshot);
    this.save();
    return v;
  }

  review(role, id, version, decision, comment) {
    if (role !== "reviewer") throw new HttpError(403, "仅评审员可审批");
    if (decision !== "approve" && decision !== "reject") throw new HttpError(400, "审批决定必须是 approve 或 reject");
    const s = this._getStrategy(id);
    const v = this._getVersion(s, version);
    if (v.status !== "in_review") throw new HttpError(409, `v${version} 不在评审中`);
    v.review = { decision, comment: String(comment || ""), reviewed_at: nowIso() };
    if (decision === "approve") {
      // 旧发布版本保持 published 不变（仍可直接回测），仅切换「当前发布版本」指针
      v.status = "published";
      v.published_at = nowIso();
      s.published_version = v.version;
    } else {
      v.status = "rejected";
    }
    this.save();
    return v;
  }

  // 撤回：只作用于当前发布版本，只改状态不改快照；历史运行记录原样保留。
  withdraw(role, id, comment) {
    if (role !== "author") throw new HttpError(403, "仅策略作者可撤回");
    const s = this._getStrategy(id);
    if (s.published_version == null) throw new HttpError(409, "该策略没有已发布版本");
    const v = this._getVersion(s, s.published_version);
    v.status = "withdrawn";
    v.withdrawn_at = nowIso();
    v.withdraw_comment = String(comment || "");
    s.published_version = null;
    this.save();
    return v;
  }

  // ---- 运行 ----

  // 角色 × 状态决定能否运行：
  //   投资者：仅当前发布版本（published_version 指针所指版本）；
  //   作者/评审员：任何已冻结版本（评审中/已发布/已撤回/已驳回……快照已冻结即可复现）；
  //   草稿未冻结，不能作为留痕运行（可在沙箱试算）。
  canRun(s, v, role) {
    if (v.status === "draft") return { ok: false, reason: "草稿尚未冻结，送审后才能作为版本运行" };
    if (role === "investor" && !(s.published_version === v.version && v.status === "published")) {
      return { ok: false, reason: "投资者只能运行当前已发布版本" };
    }
    return { ok: true };
  }

  runVersion(role, id, version) {
    const s = this._getStrategy(id);
    const v = this._getVersion(s, version);
    const gate = this.canRun(s, v, role);
    if (!gate.ok) throw new HttpError(403, gate.reason);
    const result = runSnapshot(v.snapshot);
    const rec = {
      id: "run_" + (this.data.runs.reduce((m, x) => Math.max(m, Number(x.id.slice(4)) || 0), 0) + 1),
      strategy_id: id,
      strategy_title: s.title,
      version,
      role,
      snapshot_hash: v.snapshot_hash,
      mc_seed: result.mc_seed,
      created_at: nowIso(),
      final_equity: result.final_equity,
      total_return: result.total_return,
      stats: result.stats,
      prob_loss: result.montecarlo.prob_loss,
      n_trades: result.trades.length,
    };
    // 历史结果只追加：撤回/再发布/参数修改都不触碰任何既有记录
    this.data.runs.push(rec);
    this.save();
    return { run: rec, result };
  }

  listRuns(id) {
    return this.data.runs.filter(r => r.strategy_id === id).sort((a, b) => b.id.localeCompare(a.id));
  }

  // ---- 查询视图（带角色相关标记） ----

  listStrategies(role) {
    return this.data.strategies.map(s => {
      const open = this._openVersion(s);
      const latest = s.versions[s.versions.length - 1];
      return {
        id: s.id,
        title: s.title,
        description: s.description,
        published_version: s.published_version,
        latest_version: latest ? latest.version : null,
        latest_status: latest ? latest.status : null,
        open_version: open ? open.version : null,
        open_status: open ? open.status : null,
        run_count: this.data.runs.filter(r => r.strategy_id === s.id).length,
      };
    });
  }

  getStrategy(role, id) {
    const s = this._getStrategy(id);
    const runs = this.listRuns(id);
    return {
      id: s.id,
      title: s.title,
      description: s.description,
      published_version: s.published_version,
      created_at: s.created_at,
      versions: s.versions.map(v => this._versionView(s, v, role)),
      runs,
    };
  }

  _versionView(s, v, role) {
    const gate = this.canRun(s, v, role);
    return {
      version: v.version,
      status: v.status,
      status_label: statusLabel(v.status),
      snapshot_hash: v.snapshot_hash,
      base_version: v.base_version,
      created_at: v.created_at,
      submitted_at: v.submitted_at,
      published_at: v.published_at,
      withdrawn_at: v.withdrawn_at,
      review: v.review,
      withdraw_comment: v.withdraw_comment || null,
      is_current: s.published_version === v.version,
      can_edit: role === "author" && (v.status === "draft" || v.status === "rejected"),
      can_submit: role === "author" && (v.status === "draft" || v.status === "rejected"),
      can_review: role === "reviewer" && v.status === "in_review",
      can_withdraw: role === "author" && s.published_version === v.version && v.status === "published",
      can_run: gate.ok,
      run_blocked_reason: gate.ok ? null : gate.reason,
      snapshot: v.snapshot,
    };
  }
}

function statusLabel(st) {
  return { draft: "草稿", in_review: "评审中", published: "已发布", rejected: "已驳回", withdrawn: "已撤回" }[st] || st;
}

module.exports = { Store, HttpError, ROLES, OPEN_STATES, statusLabel };
