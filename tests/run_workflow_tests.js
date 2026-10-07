"use strict";
const assert = require("assert");
const os = require("os");
const fs = require("fs");
const path = require("path");
const snapMod = require("../engine/snapshot");
const { Store, HttpError } = require("../engine/store");
const { runSnapshot } = require("../engine/runner");

let passed = 0;
let failed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log("ok  -", name);
  } catch (e) {
    failed++;
    console.log("FAIL -", name, "::", e.message);
  }
}

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strat-"));
  return new Store(path.join(dir, "strategies.json"));
}
function expectError(fn, status, part) {
  try { fn(); }
  catch (e) {
    assert(e instanceof HttpError, "应当抛出 HttpError，实际：" + e.message);
    if (status) assert.strictEqual(e.status, status, `状态码期望 ${status}，实际 ${e.status}`);
    if (part) assert(e.message.includes(part), `错误信息应包含「${part}」，实际：${e.message}`);
    return;
  }
  throw new assert.AssertionError({ message: "期望抛出错误但未抛出" });
}

// ---------- 快照 ----------

t("快照归一化补齐全部缺省字段", () => {
  const s = snapMod.normalize({ strategy: { type: "rsi" } });
  assert.strictEqual(s.market.seed, 42);
  assert.strictEqual(s.options.feeRate, 0.0005);
  assert.strictEqual(s.strategy.type, "rsi");
  assert.strictEqual(s.montecarlo.nPaths, 300);
  assert.strictEqual(s.options.cash, 100000);
});

t("快照稳定序列化与哈希：相同参数同哈希、不同参数不同哈希", () => {
  const a = snapMod.normalize({ market: { seed: 1 } });
  const b = snapMod.normalize({ market: { seed: 1 } });
  const c = snapMod.normalize({ market: { seed: 2 } });
  assert.strictEqual(snapMod.canonicalize(a), snapMod.canonicalize(b));
  assert.strictEqual(snapMod.hashSnapshot(a), snapMod.hashSnapshot(b));
  assert.notStrictEqual(snapMod.hashSnapshot(a), snapMod.hashSnapshot(c));
});

t("键顺序不同不影响哈希", () => {
  const a = snapMod.normalize({ strategy: { type: "ma_cross", fast: 5, slow: 20 } });
  const b = snapMod.normalize({ strategy: { slow: 20, fast: 5, type: "ma_cross" } });
  assert.strictEqual(snapMod.hashSnapshot(a), snapMod.hashSnapshot(b));
});

t("蒙特卡洛种子策略：market_offset = 市场种子+1，explicit 用固定值", () => {
  const a = snapMod.normalize({ market: { seed: 42 }, montecarlo: { seedStrategy: "market_offset" } });
  assert.strictEqual(snapMod.mcSeed(a), 43);
  const b = snapMod.normalize({ market: { seed: 42 }, montecarlo: { seedStrategy: "explicit", seed: 99 } });
  assert.strictEqual(snapMod.mcSeed(b), 99);
});

t("快照校验拒绝非法参数", () => {
  // snapshot 是引擎层，抛普通 Error；HTTP 状态码由 store/server 包装
  assert.throws(() => snapMod.normalize({ strategy: { fast: 30, slow: 10 } }), /快线/);
  assert.throws(() => snapMod.normalize({ market: { days: 10 } }), /days/); // 越界拒绝，由引擎层负责夹取
  assert.throws(() => snapMod.normalize({ market: { vol: -1 } }), /vol/);
});

t("快照可深冻结不可改", () => {
  const s = snapMod.normalize({});
  snapMod.deepFreeze(s);
  assert(Object.isFrozen(s));
  assert(Object.isFrozen(s.market));
  assert.throws(() => { s.market.seed = 1; }, TypeError);
});

// ---------- 运行器 ----------

t("同一快照的回测/风险/蒙特卡洛结果确定且一致", () => {
  const s = snapMod.normalize({ market: { seed: 11, days: 500 }, options: { stopMode: "atr" } });
  const a = runSnapshot(s);
  const b = runSnapshot(s);
  assert.strictEqual(a.final_equity, b.final_equity);
  assert.deepStrictEqual(a.equity, b.equity);
  assert.deepStrictEqual(a.montecarlo.quantiles, b.montecarlo.quantiles);
  assert.strictEqual(a.snapshot_hash, snapMod.hashSnapshot(s));
  assert.strictEqual(a.mc_seed, snapMod.mcSeed(s));
  assert(Number.isFinite(a.stats.sharpe));
});

t("运行器结果与手工组合引擎一致", () => {
  const market = require("../engine/market");
  const bt = require("../engine/backtest");
  const metrics = require("../engine/metrics");
  const s = snapMod.normalize({ market: { seed: 5, days: 300 }, strategy: { type: "boll" } });
  const out = runSnapshot(s);
  const m = market.generateMarket(s.market);
  const r = bt.backtest(m, { ...s.options, strategy: s.strategy });
  const stats = metrics.summarize(r.equity, { ...s.options, strategy: s.strategy });
  assert.strictEqual(out.final_equity, Math.round(r.final_equity * 100) / 100);
  assert.strictEqual(out.stats.sharpe, stats.sharpe);
  assert.strictEqual(out.trades.length, r.trades.length);
});

// ---------- 工作流状态机 ----------

t("作者创建策略即得到 v1 草稿", () => {
  const st = tmpStore();
  const s = st.createStrategy("author", { title: "甲" });
  assert.strictEqual(s.versions.length, 1);
  assert.strictEqual(s.versions[0].status, "draft");
  assert.strictEqual(s.published_version, null);
});

t("非作者不能创建策略；非评审员不能审批；非作者不能送审/撤回", () => {
  const st = tmpStore();
  expectError(() => st.createStrategy("reviewer", { title: "x" }), 403);
  expectError(() => st.createStrategy("investor", { title: "x" }), 403);
  const s = st.createStrategy("author", { title: "x" });
  expectError(() => st.submit("reviewer", s.id, 1), 403);
  expectError(() => st.review("author", s.id, 1, "approve"), 403);
  expectError(() => st.withdraw("reviewer", s.id), 403);
});

t("草稿可改，送审后快照冻结不可改", () => {
  const st = tmpStore();
  const s = st.createStrategy("author", { title: "x", snapshot: { market: { seed: 1 } } });
  st.saveDraft("author", s.id, 1, { market: { seed: 9 } });
  assert.strictEqual(st._getStrategy(s.id).versions[0].snapshot.market.seed, 9);
  st.submit("author", s.id, 1);
  expectError(() => st.saveDraft("author", s.id, 1, { market: { seed: 10 } }), 409, "冻结");
});

t("评审通过 → 已发布且成为当前版本；旧版保留", () => {
  const st = tmpStore();
  const s = st.createStrategy("author", { title: "x" });
  st.submit("author", s.id, 1);
  st.review("reviewer", s.id, 1, "approve", "ok");
  const g = st.getStrategy("author", s.id);
  assert.strictEqual(g.versions[0].status, "published");
  assert.strictEqual(g.published_version, 1);
  assert.strictEqual(g.versions[0].review.decision, "approve");
});

t("评审驳回 → 退回作者，改后可重新送审再通过", () => {
  const st = tmpStore();
  const s = st.createStrategy("author", { title: "x" });
  st.submit("author", s.id, 1);
  expectError(() => st.review("investor", s.id, 1, "approve"), 403);
  st.review("reviewer", s.id, 1, "reject", "参数太激进");
  let g = st.getStrategy("author", s.id);
  assert.strictEqual(g.versions[0].status, "rejected");
  // 驳回意见可读
  assert.strictEqual(g.versions[0].review.comment, "参数太激进");
  // 修改驳回版本 → 自动回到草稿
  st.saveDraft("author", s.id, 1, { market: { seed: 2 } });
  assert.strictEqual(st._getStrategy(s.id).versions[0].status, "draft");
  st.submit("author", s.id, 1);
  st.review("reviewer", s.id, 1, "approve", "");
  assert.strictEqual(st.getStrategy("author", s.id).published_version, 1);
});

t("发布后才能新建下一版草稿；开放版本存在时禁止新建", () => {
  const st = tmpStore();
  const s = st.createStrategy("author", { title: "x" });
  // v1 草稿还在
  expectError(() => st.createDraft("author", s.id), 409);
  st.submit("author", s.id, 1);
  // 评审中也不能新建
  expectError(() => st.createDraft("author", s.id), 409);
  st.review("reviewer", s.id, 1, "approve");
  const v2 = st.createDraft("author", s.id);
  assert.strictEqual(v2.version, 2);
  assert.strictEqual(v2.base_version, 1);
});

t("撤回只作用当前发布版本，旧版本仍可由作者直接回测", () => {
  const st = tmpStore();
  const s = st.createStrategy("author", { title: "x" });
  st.submit("author", s.id, 1);
  st.review("reviewer", s.id, 1, "approve");
  st.withdraw("author", s.id, "行情变了");
  const g = st.getStrategy("author", s.id);
  assert.strictEqual(g.versions[0].status, "withdrawn");
  assert.strictEqual(g.published_version, null);
  // 撤回后作者仍可运行旧版本（直接回测）
  const gate = st.canRun(g, g.versions[0], "author");
  assert.strictEqual(gate.ok, true);
});

t("投资者只能运行当前已发布版本；草稿/评审中/已撤回/已驳回均拒绝", () => {
  const st = tmpStore();
  const s = st.createStrategy("author", { title: "x" });
  expectError(() => st.runVersion("investor", s.id, 1), 403, "冻结");
  st.submit("author", s.id, 1);
  expectError(() => st.runVersion("investor", s.id, 1), 403, "已发布");
  st.review("reviewer", s.id, 1, "reject");
  expectError(() => st.runVersion("investor", s.id, 1), 403);
  st.saveDraft("author", s.id, 1, {});
  st.submit("author", s.id, 1);
  st.review("reviewer", s.id, 1, "approve");
  const ok = st.runVersion("investor", s.id, 1);
  assert(ok.run.id.startsWith("run_"));
  st.withdraw("author", s.id);
  expectError(() => st.runVersion("investor", s.id, 1), 403, "已发布");
});

t("作者/评审员可运行任何已冻结版本（评审中、旧版、撤回版）", () => {
  const st = tmpStore();
  const s = st.createStrategy("author", { title: "x" });
  st.submit("author", s.id, 1);
  assert(st.runVersion("reviewer", s.id, 1).run);
  st.review("reviewer", s.id, 1, "approve");
  // 发 v2，v1 变为旧发布版
  st.createDraft("author", s.id, { market: { seed: 3 } });
  st.submit("author", s.id, 2);
  st.review("reviewer", s.id, 2, "approve");
  // 旧版 v1 仍可直接回测
  assert(st.runVersion("author", s.id, 1).run);
  assert(st.runVersion("reviewer", s.id, 2).run);
});

t("草稿不能留痕运行；只有作者能试算且不产生记录", () => {
  const st = tmpStore();
  const s = st.createStrategy("author", { title: "x" });
  expectError(() => st.runVersion("author", s.id, 1), 403, "冻结");
  expectError(() => st.runVersion("reviewer", s.id, 1), 403);
  assert.strictEqual(st.listRuns(s.id).length, 0);
});

t("撤回不改写历史运行结果（记录只追加、快照哈希不变）", () => {
  const st = tmpStore();
  const s = st.createStrategy("author", { title: "x", snapshot: { market: { seed: 8 } } });
  st.submit("author", s.id, 1);
  st.review("reviewer", s.id, 1, "approve");
  const before = st.runVersion("investor", s.id, 1).run;
  const hashBefore = before.snapshot_hash;
  const retBefore = before.total_return;
  st.withdraw("author", s.id);
  const runs = st.listRuns(s.id);
  assert.strictEqual(runs.length, 1);
  assert.strictEqual(runs[0].snapshot_hash, hashBefore);
  assert.strictEqual(runs[0].total_return, retBefore);
  assert.strictEqual(runs[0].version, 1);
  // 用同快照再跑，终值逐位一致
  const again = st.runVersion("author", s.id, 1).run;
  assert.strictEqual(again.total_return, retBefore);
  assert.strictEqual(again.snapshot_hash, hashBefore);
});

t("v1 与 v2 参数不同则哈希不同，各自结果互不影响", () => {
  const st = tmpStore();
  const s = st.createStrategy("author", { title: "x", snapshot: { market: { seed: 1 } } });
  st.submit("author", s.id, 1);
  st.review("reviewer", s.id, 1, "approve");
  const r1 = st.runVersion("investor", s.id, 1).run;
  st.createDraft("author", s.id, { market: { seed: 2 } });
  st.submit("author", s.id, 2);
  st.review("reviewer", s.id, 2, "approve");
  const r2 = st.runVersion("investor", s.id, 2).run;
  assert.notStrictEqual(r1.snapshot_hash, r2.snapshot_hash);
  // v1 旧版现在不是当前发布，投资者被拒，但作者仍可跑且结果不变
  expectError(() => st.runVersion("investor", s.id, 1), 403, "当前已发布");
  const r1again = st.runVersion("author", s.id, 1).run;
  assert.strictEqual(r1again.total_return, r1.total_return);
});

t("存储持久化到磁盘并可重新加载", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strat-persist-"));
  const file = path.join(dir, "strategies.json");
  const a = new Store(file);
  const s = a.createStrategy("author", { title: "持久" });
  a.submit("author", s.id, 1);
  a.review("reviewer", s.id, 1, "approve");
  a.runVersion("investor", s.id, 1);
  const b = new Store(file);
  const g = b.getStrategy("investor", s.id);
  assert.strictEqual(g.title, "持久");
  assert.strictEqual(g.published_version, 1);
  assert.strictEqual(g.runs.length, 1);
  assert.strictEqual(g.versions[0].snapshot.market.days, 400);
});

t("版本视图按角色给出操作标记", () => {
  const st = tmpStore();
  const s = st.createStrategy("author", { title: "x" });
  const inv = st.getStrategy("investor", s.id).versions[0];
  assert.strictEqual(inv.can_run, false);
  assert.strictEqual(inv.can_edit, false);
  const aut = st.getStrategy("author", s.id).versions[0];
  assert.strictEqual(aut.can_edit, true);
  assert.strictEqual(aut.can_submit, true);
});

t("非法审批决定被拒绝；评审中以外不能审批", () => {
  const st = tmpStore();
  const s = st.createStrategy("author", { title: "x" });
  st.submit("author", s.id, 1);
  expectError(() => st.review("reviewer", s.id, 1, "maybe"), 400);
  st.review("reviewer", s.id, 1, "approve");
  expectError(() => st.review("reviewer", s.id, 1, "approve"), 409);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
