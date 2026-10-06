// 世界じゃんけん: マッチング + 同時公開 + チャット + ゴースト対戦 + レーティング + MCP
const BEATS = { r: "s", s: "p", p: "r" };
const judge = (a, b) => (a === b ? "draw" : BEATS[a] === b ? "win" : "lose");
const MOVES = ["r", "p", "s"];
const GHOST_WAIT_MS = 6000;
const CHAT_MAX = 40;
const CHAT_GAP_MS = 1000;

// 地域(大陸)ごとのロビー数。大きい地域は2つ、第1ロビーが満員になったら第2へ
const LOBBIES = { AS: 2, EU: 2, NA: 2, SA: 1, OC: 1, AF: 1 };
const CAP = 200;
const CONTINENT = { AN: "OC" };
const FALLBACK = "AS"; // 判定できない時（ローカル開発など）
const LOBBY_RE = /^([A-Z]{2})-([1-9])$/;

// レーティング（Elo）。ゴースト戦は対象外（相手がリアルタイムの人間でないため）
const INITIAL_RATING = 1500;
const K_FACTOR = 32;

async function pickLobby(req, env, want) {
  const m = LOBBY_RE.exec(want || "");
  if (m && Object.hasOwn(LOBBIES, m[1]) && +m[2] <= LOBBIES[m[1]]) return want;
  let r = req.cf?.continent;
  r = CONTINENT[r] || r;
  if (!Object.hasOwn(LOBBIES, r || "")) r = FALLBACK;
  if (LOBBIES[r] > 1) {
    const c = await env.LOBBY.get(env.LOBBY.idFromName(r + "-1")).fetch("https://lobby/count")
      .then((x) => x.json()).catch(() => ({ online: 0 }));
    if (c.online >= CAP) return r + "-2";
  }
  return r + "-1";
}

export class Lobby {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.players = new Set();
    this.mcpPlayers = new Map(); // pid -> player（MCP経由のプレイヤー）
    this.name = "";
    this.waiting = null;
    this.total = null;
    this.hist = []; // 直近の人間の手 {move, country}（ゴースト用）
  }

  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/count") return Response.json({ online: this.players.size });
    if (u.pathname.startsWith("/mcp/")) return this.handleMcp(u.pathname, req);
    if (req.headers.get("Upgrade") !== "websocket") return new Response("ws only", { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    this.name = req.headers.get("x-lobby") || this.name;
    const p = {
      ws: server,
      country: req.headers.get("x-country") || "XX",
      pid: req.headers.get("x-pid") || null,
      opp: null, ghost: null, move: null, timer: null, lastChat: 0,
    };
    this.players.add(p);
    if (this.total === null) this.total = (await this.state.storage.get("total")) || 0;
    this.stats();
    if (p.pid) this.fetchRating(p.pid).then((r) => this.send(p, { type: "rating", rating: r })).catch(() => {});
    server.addEventListener("message", (e) => this.onMessage(p, e.data));
    const bye = () => { this.unpair(p); this.players.delete(p); this.stats(); };
    server.addEventListener("close", bye);
    server.addEventListener("error", bye);
    return new Response(null, { status: 101, webSocket: client });
  }

  send(p, obj) {
    if (p.mcp && (obj.type === "stats" || obj.type === "waiting")) return; // MCP側には不要な通知
    try { p.ws.send(JSON.stringify(obj)); } catch {}
  }
  stats() { for (const p of this.players) this.send(p, { type: "stats", lobby: this.name, online: this.players.size, total: this.total }); }

  ratingDO() { return this.env?.RATING?.get(this.env.RATING.idFromName("global")); }

  async fetchRating(pid) {
    const do_ = this.ratingDO();
    if (!do_) return INITIAL_RATING;
    const r = await do_.fetch("https://rating/get?pid=" + encodeURIComponent(pid));
    return (await r.json()).rating;
  }

  // 両者が人間同士で勝負がついた時だけ呼ぶ。outcome は p から見た結果
  async applyRating(p, o, outcome) {
    const do_ = this.ratingDO();
    if (!do_ || !p.pid || !o.pid) return [null, null];
    try {
      const res = await do_.fetch("https://rating/rate", {
        method: "POST",
        body: JSON.stringify({ a: p.pid, b: o.pid, outcome }),
      });
      const { a, b } = await res.json();
      return [a, b];
    } catch { return [null, null]; }
  }

  unpair(p) {
    clearTimeout(p.timer);
    if (p.opp) { this.send(p.opp, { type: "left" }); p.opp.opp = null; p.opp.move = null; }
    if (this.waiting === p) this.waiting = null;
    p.opp = null; p.ghost = null; p.move = null;
  }

  onMessage(p, raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === "join") return this.join(p);
    if (m.type === "move" && MOVES.includes(m.move)) return void this.move(p, m.move);
    if (m.type === "chat") return this.chat(p, m.text);
  }

  join(p) {
    this.unpair(p);
    const w = this.waiting;
    if (w && w !== p && this.players.has(w)) {
      clearTimeout(w.timer);
      this.waiting = null;
      p.opp = w; w.opp = p;
      this.send(p, { type: "matched", country: w.country, ghost: false });
      this.send(w, { type: "matched", country: p.country, ghost: false });
      return;
    }
    this.waiting = p;
    this.send(p, { type: "waiting" });
    p.timer = setTimeout(() => {
      if (this.waiting !== p) return;
      this.waiting = null;
      const past = this.hist.length ? this.hist[Math.floor(Math.random() * this.hist.length)] : null;
      p.ghost = { move: past ? past.move : MOVES[Math.floor(Math.random() * 3)], country: past ? past.country : "XX" };
      this.send(p, { type: "matched", country: p.ghost.country, ghost: true });
    }, GHOST_WAIT_MS);
  }

  // 戻り値: 送信できたか（人間の相手とマッチ中かつレート制限内）
  chat(p, text) {
    if (!p.opp || typeof text !== "string") return false;
    text = text.replace(/[\r\n\t]+/g, " ").trim().slice(0, CHAT_MAX);
    const now = Date.now();
    if (!text || now - p.lastChat < CHAT_GAP_MS) return false;
    p.lastChat = now;
    this.send(p.opp, { type: "chat", text });
    this.send(p, { type: "chat", text, mine: true });
    return true;
  }

  async move(p, mv) {
    if (p.move || (!p.opp && !p.ghost)) return;
    p.move = mv;
    if (p.ghost) return this.finish(p, mv, p.ghost.move, p.ghost.country, true);
    const o = p.opp;
    if (!o.move) return this.send(p, { type: "locked" });
    const outcome = judge(mv, o.move);
    const [ra, rb] = await this.applyRating(p, o, outcome);
    // 通信中に相手が退出しているかもしれないので再確認
    if (!this.players.has(p)) return;
    this.finish(p, mv, o.move, o.country, false, false, ra);
    if (this.players.has(o)) this.finish(o, o.move, mv, p.country, false, true, rb);
  }

  finish(p, mine, theirs, oppCountry, ghost, second, rating) {
    this.send(p, { type: "result", you: mine, opp: theirs, outcome: judge(mine, theirs), country: oppCountry, ghost, rating: rating || undefined });
    if (!ghost) this.hist.push({ move: mine, country: p.country });
    if (this.hist.length > 50) this.hist.shift();
    if (!second) { this.total++; this.state.storage.put("total", this.total); }
    p.opp = null; p.ghost = null; p.move = null;
    if (!second) this.stats();
  }

  // ---- ここからMCP（AIエージェント）向け。HTTPのワンショット呼び出しを、
  // 通知(mcpPush)とキュー(inbox)/長ポーリング(waitNext)でWebSocket版と同じゲームロジックに橋渡しする ----

  getMcpPlayer(pid, country) {
    let p = this.mcpPlayers.get(pid);
    if (!p) {
      p = { mcp: true, pid, country, opp: null, ghost: null, move: null, timer: null, lastChat: 0, inbox: [], waiter: null };
      p.ws = { send: (raw) => this.mcpPush(p, JSON.parse(raw)) };
      this.mcpPlayers.set(pid, p);
      this.players.add(p);
    } else {
      p.country = country || p.country;
    }
    return p;
  }

  mcpPush(p, obj) {
    if (p.waiter) { const w = p.waiter; p.waiter = null; w(obj); return; }
    p.inbox.push(obj);
    if (p.inbox.length > 20) p.inbox.shift();
  }

  waitNext(p, ms) {
    if (p.inbox.length) return Promise.resolve(p.inbox.shift());
    return new Promise((resolve) => {
      const t = setTimeout(() => { p.waiter = null; resolve(null); }, ms);
      p.waiter = (obj) => { clearTimeout(t); resolve(obj); };
    });
  }

  async handleMcp(path, req) {
    this.name = req.headers.get("x-lobby") || this.name;
    const country = req.headers.get("x-country") || "XX";
    let body = {}; try { body = await req.json(); } catch {}
    const pid = typeof body.pid === "string" ? body.pid : "";
    if (!pid) return Response.json({ error: "pid_required" }, { status: 400 });

    if (path === "/mcp/join") {
      const p = this.getMcpPlayer(pid, country);
      this.join(p);
      const ev = await this.waitNext(p, GHOST_WAIT_MS + 1500);
      return Response.json({ lobby: this.name, online: this.players.size, event: ev });
    }
    const p = this.mcpPlayers.get(pid);
    if (!p) return Response.json({ error: "not_joined" }, { status: 400 });

    if (path === "/mcp/move") {
      if (!MOVES.includes(body.move)) return Response.json({ error: "bad_move" }, { status: 400 });
      await this.move(p, body.move);
      return Response.json({ event: p.inbox.length ? p.inbox.shift() : null });
    }
    if (path === "/mcp/state") {
      const ms = Math.min(Math.max(+body.timeout_ms || 15000, 1000), 25000);
      return Response.json({ event: await this.waitNext(p, ms) });
    }
    if (path === "/mcp/chat") {
      return Response.json({ sent: this.chat(p, body.text || "") });
    }
    if (path === "/mcp/leave") {
      this.unpair(p);
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  }
}

// レーティング専用のDurable Object（全ロビー共通の単一インスタンス）
export class Rating {
  constructor(state) { this.state = state; }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/get") {
      const pid = url.searchParams.get("pid") || "";
      const r = pid ? ((await this.state.storage.get("r:" + pid)) ?? INITIAL_RATING) : INITIAL_RATING;
      return Response.json({ rating: r });
    }
    if (url.pathname === "/rate" && req.method === "POST") {
      const { a, b, outcome } = await req.json();
      if (!a || !b) return Response.json({ error: "pid required" }, { status: 400 });
      const ra = (await this.state.storage.get("r:" + a)) ?? INITIAL_RATING;
      const rb = (await this.state.storage.get("r:" + b)) ?? INITIAL_RATING;
      const scoreA = outcome === "win" ? 1 : outcome === "lose" ? 0 : 0.5;
      const expA = 1 / (1 + 10 ** ((rb - ra) / 400));
      const na = Math.round(ra + K_FACTOR * (scoreA - expA));
      const nb = Math.round(rb + K_FACTOR * ((1 - scoreA) - (1 - expA)));
      await this.state.storage.put("r:" + a, na);
      await this.state.storage.put("r:" + b, nb);
      return Response.json({ a: { rating: na, delta: na - ra }, b: { rating: nb, delta: nb - rb } });
    }
    return new Response("not found", { status: 404 });
  }
}

// ---- MCP (Model Context Protocol) サーバー本体。/mcp に JSON-RPC 2.0 で接続する ----
const MCP_PROTOCOL_VERSION = "2025-06-18";

const MCP_TOOLS = [
  {
    name: "rps_join",
    description:
      "世界じゃんけんの対戦相手を探す。実在の人間とマッチするか、見つからなければ数秒でAIの「ゴースト」(過去の人間の手の記録)と対戦になる。初回はpidを省略するとサーバーが新しい匿名IDを発行して返すので、以後の呼び出しはそのpidを使うこと。応答のlobbyは以後の呼び出しに必ず渡すこと。",
    inputSchema: {
      type: "object",
      properties: {
        pid: { type: "string", description: "あなたの匿名ID。2回目以降は前回の応答のpidを渡す。省略すると新規発行され、レートは1500からになる" },
        lobby: { type: "string", description: "地域ロビー名（例: AS-1, EU-2）。省略すると接続元の地域から自動選択される" },
      },
    },
  },
  {
    name: "rps_move",
    description:
      "グー(r)・チョキ(s)・パー(p)のいずれかを出す。rps_joinで得たpidとlobbyを渡すこと。相手がまだ手を出していない場合はevent.type=\"locked\"が返るので、rps_stateで結果を待つこと。",
    inputSchema: {
      type: "object",
      properties: {
        pid: { type: "string" },
        lobby: { type: "string" },
        move: { type: "string", enum: ["r", "s", "p"], description: "r=グー, s=チョキ, p=パー" },
      },
      required: ["pid", "lobby", "move"],
    },
  },
  {
    name: "rps_state",
    description:
      "次の出来事（対戦相手からのチャット、勝敗結果、相手の退出など）を待ち受ける。指定時間内に何も起きなければevent=nullが返るので、必要なら再度呼び出してよい。",
    inputSchema: {
      type: "object",
      properties: {
        pid: { type: "string" },
        lobby: { type: "string" },
        timeout_ms: { type: "number", description: "待機時間（ミリ秒）。既定15000、最大25000" },
      },
      required: ["pid", "lobby"],
    },
  },
  {
    name: "rps_chat",
    description: "対戦中の相手に一言送る（心理戦用）。人間の相手とマッチ中かつ勝負がつく前だけ有効。1秒に1通まで、40字まで。",
    inputSchema: {
      type: "object",
      properties: { pid: { type: "string" }, lobby: { type: "string" }, text: { type: "string" } },
      required: ["pid", "lobby", "text"],
    },
  },
  {
    name: "rps_leave",
    description: "待機中のマッチングや進行中の対戦を取り消す。",
    inputSchema: {
      type: "object",
      properties: { pid: { type: "string" }, lobby: { type: "string" } },
      required: ["pid", "lobby"],
    },
  },
  {
    name: "rps_rating",
    description: "自分の現在のレート(Elo、初期1500)を取得する。",
    inputSchema: {
      type: "object",
      properties: { pid: { type: "string" } },
      required: ["pid"],
    },
  },
];

const PID_RE = /^[A-Za-z0-9_-]{1,64}$/;

async function callLobby(env, lobby, path, body, country) {
  const stub = env.LOBBY.get(env.LOBBY.idFromName(lobby));
  const res = await stub.fetch("https://lobby" + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-lobby": lobby, "x-country": country },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function mcpCallTool(name, args, req, env) {
  const country = req.cf?.country || "XX";
  let pid = typeof args.pid === "string" && PID_RE.test(args.pid) ? args.pid : "";

  if (name === "rps_rating") {
    if (!pid) return { error: "pid_required" };
    const do_ = env.RATING.get(env.RATING.idFromName("global"));
    const r = await do_.fetch("https://rating/get?pid=" + encodeURIComponent(pid));
    return r.json();
  }
  if (name === "rps_join") {
    if (!pid) pid = crypto.randomUUID();
    const lobby = await pickLobby(req, env, args.lobby);
    const out = await callLobby(env, lobby, "/mcp/join", { pid }, country);
    return { pid, lobby, ...out };
  }
  const lobby = typeof args.lobby === "string" && LOBBY_RE.test(args.lobby) ? args.lobby : "";
  if (!pid || !lobby) return { error: "pid_and_lobby_required" };
  if (name === "rps_move") {
    if (!MOVES.includes(args.move)) return { error: "bad_move" };
    return callLobby(env, lobby, "/mcp/move", { pid, move: args.move }, country);
  }
  if (name === "rps_state") {
    const timeout_ms = Math.min(Math.max(+args.timeout_ms || 15000, 1000), 25000);
    return callLobby(env, lobby, "/mcp/state", { pid, timeout_ms }, country);
  }
  if (name === "rps_chat") return callLobby(env, lobby, "/mcp/chat", { pid, text: String(args.text || "") }, country);
  if (name === "rps_leave") return callLobby(env, lobby, "/mcp/leave", { pid }, country);
  return { error: "unknown_tool" };
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function jrpc(body, status = 200) { return Response.json(body, { status, headers: CORS }); }
function jrpcResult(id, result) { return jrpc({ jsonrpc: "2.0", id, result }); }
function jrpcError(id, code, message) { return jrpc({ jsonrpc: "2.0", id, error: { code, message } }); }

async function mcpRpc(req, env) {
  let msg;
  try { msg = await req.json(); } catch { return jrpcError(null, -32700, "Parse error"); }
  if (Array.isArray(msg)) return jrpcError(null, -32600, "Batch requests are not supported");
  const { id, method, params } = msg || {};

  if (method === "initialize") {
    return jrpcResult(id, {
      protocolVersion: params?.protocolVersion || MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "world-rps", version: "1.0.0" },
    });
  }
  if (method === "ping") return jrpcResult(id, {});
  if (id === undefined) return new Response(null, { status: 202, headers: CORS }); // notifications/* 等は無視してよい
  if (method === "tools/list") return jrpcResult(id, { tools: MCP_TOOLS });
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      const result = await mcpCallTool(name, args, req, env);
      return jrpcResult(id, { content: [{ type: "text", text: JSON.stringify(result) }], isError: !!result?.error });
    } catch (e) {
      return jrpcResult(id, { content: [{ type: "text", text: JSON.stringify({ error: String(e?.message || e) }) }], isError: true });
    }
  }
  return jrpcError(id, -32601, "Method not found: " + method);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/mcp") {
      if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
      if (req.method === "GET") return new Response("MCPエンドポイント。POSTでJSON-RPC 2.0メッセージを送ってください。", { headers: { "content-type": "text/plain; charset=utf-8", ...CORS } });
      if (req.method !== "POST") return new Response("POST only", { status: 405 });
      return mcpRpc(req, env);
    }
    if (url.pathname === "/ws") {
      const lobby = await pickLobby(req, env, url.searchParams.get("lobby"));
      const h = new Headers(req.headers);
      h.set("x-country", req.cf?.country || "XX");
      h.set("x-lobby", lobby);
      const pid = url.searchParams.get("pid");
      if (pid && PID_RE.test(pid)) h.set("x-pid", pid);
      return env.LOBBY.get(env.LOBBY.idFromName(lobby)).fetch(new Request(req, { headers: h }));
    }
    return env.ASSETS.fetch(req);
  },
};
