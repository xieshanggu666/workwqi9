"use strict";
// 快照运行器：给定一份冻结的参数快照，一次性产出回测、风险指标与蒙特卡洛。
// 三者共用同一份快照——调用方无法给风险指标或蒙特卡洛另传一套参数。
const market = require("./market");
const bt = require("./backtest");
const metrics = require("./metrics");
const mc = require("./montecarlo");
const snapMod = require("./snapshot");

function round(v, d) {
  const p = Math.pow(10, d);
  return Math.round(v * p) / p;
}

function compactEquity(equity) {
  return equity.map((v, i) => [i, round(v, 2)]);
}

// 从快照执行一次完整运行。返回结果与 /api/backtest + /api/montecarlo 同构，
// 另带快照哈希与实际生效的蒙特卡洛种子，用于运行留痕。
function runSnapshot(snap) {
  const m = market.generateMarket(snap.market);
  const options = { ...snap.options, strategy: snap.strategy };
  const r = bt.backtest(m, options);
  const stats = metrics.summarize(r.equity, options);
  const seed = snapMod.mcSeed(snap);
  const sim = mc.simulate(r.equity, snap.montecarlo.nPaths, snap.montecarlo.nSteps, seed);

  const quantiles = sim.quantiles
    ? {
      p5: sim.quantiles.p5.map((v, i) => [i, round(v, 2)]),
      p50: sim.quantiles.p50.map((v, i) => [i, round(v, 2)]),
      p95: sim.quantiles.p95.map((v, i) => [i, round(v, 2)]),
    }
    : null;

  return {
    snapshot_hash: snapMod.hashSnapshot(snap),
    mc_seed: seed,
    dates: m.dates,
    rows: m.rows,
    equity: compactEquity(r.equity),
    drawdown: r.drawdown.map((v, i) => [i, round(v, 4)]),
    trades: r.trades,
    stats,
    final_equity: round(r.final_equity, 2),
    total_return: round(r.total_return, 4),
    montecarlo: {
      quantiles,
      prob_loss: sim.prob_loss == null ? null : round(sim.prob_loss, 4),
      paths: sim.paths.slice(0, 8).map(p => p.map((v, i) => [i, round(v, 2)])),
      start: sim.start,
      steps: sim.steps,
    },
  };
}

module.exports = { runSnapshot };
