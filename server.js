"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const market = require("./engine/market");
const bt = require("./engine/backtest");
const metrics = require("./engine/metrics");
const mc = require("./engine/montecarlo");
const snapMod = require("./engine/snapshot");
const { runSnapshot } = require("./engine/runner");
const { Store, HttpError, ROLES } = require("./engine/store");

const arg = process.argv.find(a => a.startsWith("--port="));
const PORT = arg ? parseInt(arg.slice(7), 10) : parseInt(process.env.PORT || "8073", 10);
const DATA_FILE = process.env.STRATEGY_DB || path.join(__dirname, "data", "strategies.json");
const WEB = path.join(__dirname, "web");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const store = new Store(DATA_FILE);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", c => {
      buf += c;
      if (buf.length > 2e6) req.destroy();
    });
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new HttpError(400, "请求体不是合法 JSON");
  }
}

function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(s);
}

function getRole(req) {
  const r = req.headers["x-role"] || "investor";
  if (!ROLES.includes(r)) throw new HttpError(400, `未知角色：${r}`);
  return r;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  try {
    if (p === "/api/system" && req.method === "GET") {
      return json(res, 200, { name: "invest-backtest", version: 2, title: "个人投资回测与风险分析平台", roles: ROLES });
    }
    if (p === "/api/market" && req.method === "POST") {
      const body = await readJson(req);
      const m = market.generateMarket(body || {});
      return json(res, 200, { dates: m.dates, rows: m.rows });
    }
    if (p === "/api/indicators" && req.method === "POST") {
      const body = await readJson(req);
      const rows = body.rows || [];
      const close = rows.map(r => r.close);
      const out = {};
      if (body.ma) out.ma = ind_sma(close, body.ma);
      if (body.rsi) out.rsi = ind_rsi(close, body.rsi);
      if (body.bb) out.bb = ind_boll(close, body.bb);
      return json(res, 200, out);
    }
    if (p === "/api/backtest" && req.method === "POST") {
      const body = await readJson(req);
      const m = market.generateMarket(body.market || {});
      const r = bt.backtest(m, body.options || {});
      const stats = metrics.summarize(r.equity, body.options || {});
      const equityPts = r.equity.map((v, i) => [i, Math.round(v * 100) / 100]);
      const ddPts = r.drawdown.map((v, i) => [i, Math.round(v * 10000) / 10000]);
      return json(res, 200, {
        dates: m.dates,
        rows: m.rows,
        equity: equityPts,
        drawdown: ddPts,
        trades: r.trades,
        stats,
        final_equity: Math.round(r.final_equity * 100) / 100,
        total_return: Math.round(r.total_return * 10000) / 10000,
      });
    }
    if (p === "/api/montecarlo" && req.method === "POST") {
      const body = await readJson(req);
      const r = mc.simulate(body.equity || [], body.nPaths, body.nSteps, body.seed);
      if (!r.quantiles) return json(res, 200, { quantiles: null, prob_loss: null, paths: [] });
      return json(res, 200, {
        quantiles: {
          p5: r.quantiles.p5.map((v, i) => [i, Math.round(v * 100) / 100]),
          p50: r.quantiles.p50.map((v, i) => [i, Math.round(v * 100) / 100]),
          p95: r.quantiles.p95.map((v, i) => [i, Math.round(v * 100) / 100]),
        },
        prob_loss: Math.round(r.prob_loss * 10000) / 10000,
        paths: r.paths.slice(0, 8).map(pathArr => pathArr.map((v, i) => [i, Math.round(v * 100) / 100])),
        start: r.start,
        steps: r.steps,
      });
    }

    // 沙箱：任意参数即席试算。同样走快照运行器——回测/风险/蒙特卡洛共用同一参数快照，
    // 但不做版本留痕。
    if (p === "/api/snapshot/run" && req.method === "POST") {
      const body = await readJson(req);
      const snap = snapMod.normalize(body.snapshot || body);
      return json(res, 200, { ...runSnapshot(snap), snapshot: snap });
    }

    // ---- 策略库 / 版本工作流 ----
    if (p === "/api/strategies" && req.method === "GET") {
      return json(res, 200, { strategies: store.listStrategies(getRole(req)), role: getRole(req) });
    }
    if (p === "/api/strategies" && req.method === "POST") {
      const role = getRole(req);
      const body = await readJson(req);
      const s = store.createStrategy(role, body);
      return json(res, 201, { strategy: store.getStrategy(role, s.id) });
    }

    let mm;
    if ((mm = p.match(/^\/api\/strategies\/([^/]+)$/))) {
      const id = decodeURIComponent(mm[1]);
      if (req.method === "GET") {
        const role = getRole(req);
        return json(res, 200, { strategy: store.getStrategy(role, id), role });
      }
      if (req.method === "PATCH") {
        const role = getRole(req);
        const body = await readJson(req);
        store.updateMeta(role, id, body);
        return json(res, 200, { strategy: store.getStrategy(role, id) });
      }
    }
    if ((mm = p.match(/^\/api\/strategies\/([^/]+)\/drafts$/)) && req.method === "POST") {
      const role = getRole(req);
      const body = await readJson(req);
      const id = decodeURIComponent(mm[1]);
      store.createDraft(role, id, body.snapshot);
      return json(res, 201, { strategy: store.getStrategy(role, id) });
    }
    if ((mm = p.match(/^\/api\/strategies\/([^/]+)\/withdraw$/)) && req.method === "POST") {
      const role = getRole(req);
      const body = await readJson(req);
      const id = decodeURIComponent(mm[1]);
      store.withdraw(role, id, body.comment);
      return json(res, 200, { strategy: store.getStrategy(role, id) });
    }
    if ((mm = p.match(/^\/api\/strategies\/([^/]+)\/versions\/(\d+)\/(draft|submit|review|run|trial)$/))) {
      const role = getRole(req);
      const body = req.method === "GET" ? {} : await readJson(req);
      const id = decodeURIComponent(mm[1]);
      const version = parseInt(mm[2], 10);
      const action = mm[3];
      if (action === "draft") {
        if (req.method !== "PUT") throw new HttpError(405, "method not allowed");
        store.saveDraft(role, id, version, body.snapshot || body);
        return json(res, 200, { strategy: store.getStrategy(role, id) });
      }
      if (action === "submit") {
        if (req.method !== "POST") throw new HttpError(405, "method not allowed");
        store.submit(role, id, version);
        return json(res, 200, { strategy: store.getStrategy(role, id) });
      }
      if (action === "review") {
        if (req.method !== "POST") throw new HttpError(405, "method not allowed");
        store.review(role, id, version, body.decision, body.comment);
        return json(res, 200, { strategy: store.getStrategy(role, id) });
      }
      if (action === "trial") {
        if (req.method !== "POST") throw new HttpError(405, "method not allowed");
        // 草稿试算：仅作者，不产生历史运行记录；运行器仍以该版本当前快照为唯一参数源
        const s = store._getStrategy(id);
        const v = store._getVersion(s, version);
        if (role !== "author") throw new HttpError(403, "仅策略作者可试算草稿");
        if (v.status !== "draft" && v.status !== "rejected") throw new HttpError(409, "仅草稿/已驳回版本可试算");
        return json(res, 200, runSnapshot(v.snapshot));
      }
      if (action === "run") {
        if (req.method !== "POST") throw new HttpError(405, "method not allowed");
        const out = store.runVersion(role, id, version);
        return json(res, 200, { strategy: store.getStrategy(role, id), run: out.run, result: out.result });
      }
    }

    let f = p === "/" ? "/index.html" : p;
    const fp = path.normalize(path.join(WEB, f));
    if (!fp.startsWith(WEB)) return json(res, 403, { error: "forbidden" });
    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      const ext = path.extname(fp).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      return fs.createReadStream(fp).pipe(res);
    }
    return json(res, 404, { error: "not found" });
  } catch (e) {
    if (e instanceof HttpError) return json(res, e.status, { error: e.message });
    return json(res, 500, { error: e.message });
  }
});

const { sma: ind_sma, rsi: ind_rsi, bollinger: ind_boll } = require("./engine/indicators");

server.listen(PORT, "127.0.0.1", () => {
  console.log(`invest-backtest running at http://127.0.0.1:${PORT}`);
});
