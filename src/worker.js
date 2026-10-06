// 世界じゃんけん: マッチング + 同時公開 + チャット + ゴースト対戦 + レーティング
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

// レーティング（Elo）。ゴースト戦は対象外（相手がリアルタイムの人間でないため）
const INITIAL_RATING = 1500;
const K_FACTOR = 32;

async function pickLobby(req, env, url) {
  const want = url.searchParams.get("lobby") || "";
  const m = /^([A-Z]{2})-([1-9])$/.exec(want);
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
    this.name = "";
    this.waiting = null;
    this.total = null;
    this.hist = []; // 直近の人間の手 {move, country}（ゴースト用）
  }

  async fetch(req) {
    if (new URL(req.url).pathname === "/count") return Response.json({ online: this.players.size });
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

  send(p, obj) { try { p.ws.send(JSON.stringify(obj)); } catch {} }
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

  chat(p, text) {
    if (!p.opp || typeof text !== "string") return; // 人間の相手とマッチ中のみ
    text = text.replace(/[\r\n\t]+/g, " ").trim().slice(0, CHAT_MAX);
    const now = Date.now();
    if (!text || now - p.lastChat < CHAT_GAP_MS) return;
    p.lastChat = now;
    this.send(p.opp, { type: "chat", text });
    this.send(p, { type: "chat", text, mine: true });
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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const lobby = await pickLobby(req, env, url);
      const h = new Headers(req.headers);
      h.set("x-country", req.cf?.country || "XX");
      h.set("x-lobby", lobby);
      const pid = url.searchParams.get("pid");
      if (pid && /^[A-Za-z0-9_-]{8,64}$/.test(pid)) h.set("x-pid", pid);
      return env.LOBBY.get(env.LOBBY.idFromName(lobby)).fetch(new Request(req, { headers: h }));
    }
    return env.ASSETS.fetch(req);
  },
};
