"use strict";
// 参数快照：草稿送审时冻结市场/策略/交易/蒙特卡洛参数。
// 快照一旦冻结（送审）即不可变；回测、风险指标与蒙特卡洛共用同一份快照，
// 任何一处都不接受游离参数——这是「同一参数快照」语义的唯一入口。
const crypto = require("crypto");

const STRATEGY_TYPES = ["ma_cross", "rsi", "boll", "buy_hold"];
const STOP_MODES = ["fixed", "atr", "trail"];

// 新建草稿/沙箱时使用的缺省参数，与前端表单初值保持一致。
function defaultSnapshot() {
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
    montecarlo: { nPaths: 300, nSteps: 252, seedStrategy: "market_offset" },
  };
}

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function num(obj, key, dflt, min, max) {
  const v = obj[key] == null ? dflt : obj[key];
  if (!isNum(v)) throw new Error(`参数 ${key} 必须是数值`);
  if (min != null && v < min) throw new Error(`参数 ${key} 不能小于 ${min}`);
  if (max != null && v > max) throw new Error(`参数 ${key} 不能大于 ${max}`);
  return v;
}

function intNum(obj, key, dflt, min, max) {
  const v = num(obj, key, dflt, min, max);
  return Math.round(v);
}

// 按白名单清洗并归一化草稿输入，冻结前所有字段都被填满，
// 因此引擎以后如何改缺省值都不会影响历史快照。
function normalize(input) {
  const s = input || {};
  const mk = s.market || {};
  const st = s.strategy || {};
  const op = s.options || {};
  const mc = s.montecarlo || {};

  const type = STRATEGY_TYPES.includes(st.type) ? st.type : "ma_cross";
  const stopMode = STOP_MODES.includes(op.stopMode) ? op.stopMode : "fixed";

  const snap = {
    market: {
      seed: intNum(mk, "seed", 42, -2147483648, 2147483647),
      days: intNum(mk, "days", 400, 60, 2000),
      start: num(mk, "start", 100, 1e-9),
      drift: num(mk, "drift", 0.0004),
      vol: num(mk, "vol", 0.012, 0),
    },
    strategy: {
      type,
      fast: intNum(st, "fast", 10, 1),
      slow: intNum(st, "slow", 30, 1),
      rsiN: intNum(st, "rsiN", 14, 1),
      rsiBuy: num(st, "rsiBuy", 30, 0, 100),
      rsiSell: num(st, "rsiSell", 70, 0, 100),
      bbN: intNum(st, "bbN", 20, 1),
      bbK: num(st, "bbK", 2, 0),
    },
    options: {
      cash: num(op, "cash", 100000, 1e-9),
      feeRate: num(op, "feeRate", 0.0005, 0),
      slippageBp: num(op, "slippageBp", 5, 0),
      positionRatio: Math.max(0, Math.min(1, num(op, "positionRatio", 1, 0, 1))),
      stopMode,
      stopLoss: num(op, "stopLoss", 0.05, 0),
      takeProfit: num(op, "takeProfit", 0.15, 0),
      atrN: Math.max(2, intNum(op, "atrN", 14, 2)),
      atrStopMult: num(op, "atrStopMult", 2, 0),
      atrTargetMult: num(op, "atrTargetMult", 4, 0),
      atrVolN: Math.max(2, intNum(op, "atrVolN", 50, 2)),
      volLowK: num(op, "volLowK", 0.7),
      volHighK: num(op, "volHighK", 1.3),
      volLowMult: num(op, "volLowMult", 0.8, 0),
      volHighMult: num(op, "volHighMult", 1.5, 0),
      riskFree: num(op, "riskFree", 0.02),
      periodsPerYear: Math.max(1, intNum(op, "periodsPerYear", 252, 1)),
    },
    montecarlo: {
      nPaths: Math.max(20, Math.min(2000, intNum(mc, "nPaths", 300, 20, 2000))),
      nSteps: Math.max(10, Math.min(2000, intNum(mc, "nSteps", 252, 10, 2000))),
      seedStrategy: mc.seedStrategy === "explicit" ? "explicit" : "market_offset",
      seed: mc.seedStrategy === "explicit" ? intNum(mc, "seed", 43, -2147483648, 2147483647) : undefined,
    },
  };
  if (snap.strategy.fast >= snap.strategy.slow) throw new Error("快线周期必须小于慢线周期");
  return snap;
}

// 稳定序列化：对象键按字典序排序，保证相同参数得到相同哈希。
function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") + "}";
}

function hashSnapshot(snap) {
  return crypto.createHash("sha256").update(canonicalize(snap)).digest("hex").slice(0, 16);
}

// 蒙特卡洛有效种子：默认策略 = 市场种子 + 1（结果确定且随市场种子变化）；
// 显式策略则使用快照内固定种子。种子本身也是快照的一部分，记录在每次运行上。
function mcSeed(snap) {
  if (snap.montecarlo.seedStrategy === "explicit") return snap.montecarlo.seed;
  return snap.market.seed + 1;
}

// 深冻结：快照随版本存档后任何代码都不能再改写它。
function deepFreeze(obj) {
  for (const k of Object.keys(obj)) {
    if (obj[k] && typeof obj[k] === "object") deepFreeze(obj[k]);
  }
  return Object.freeze(obj);
}

module.exports = {
  STRATEGY_TYPES,
  STOP_MODES,
  defaultSnapshot,
  normalize,
  canonicalize,
  hashSnapshot,
  mcSeed,
  deepFreeze,
};
