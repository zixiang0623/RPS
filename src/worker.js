// 世界じゃんけん: 待機列マッチング + 同時公開 + チャット + ゴースト対戦
const BEATS = { r: "s", s: "p", p: "r" };
const judge = (a, b) => (a === b ? "draw" : BEATS[a] === b ? "win" : "lose");
const MOVES = ["r", "p", "s"];
const GHOST_WAIT_MS = 6000;
const CHAT_MAX = 40;
const CHAT_GAP_MS = 1000;

export class Lobby {
  constructor(state) {
    this.state = state;
    this.players = new Set();
    this.queue = []; // 待機列（先頭が最古）
    this.total = null;
    this.hist = []; // 直近の人間の手 {move, country}（ゴースト用）
  }

  async fetch(req) {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("ws only", { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const p = { ws: server, country: req.headers.get("x-country") || "XX", opp: null, ghost: null, move: null, timer: null, last: null, lastChat: 0 };
    this.players.add(p);
    if (this.total === null) this.total = (await this.state.storage.get("total")) || 0;
    this.stats();
    server.addEventListener("message", (e) => this.onMessage(p, e.data));
    const bye = () => { this.unpair(p); this.players.delete(p); this.stats(); };
    server.addEventListener("close", bye);
    server.addEventListener("error", bye);
    return new Response(null, { status: 101, webSocket: client });
  }

  send(p, obj) { try { p.ws.send(JSON.stringify(obj)); } catch {} }
  stats() { for (const p of this.players) this.send(p, { type: "stats", online: this.players.size, total: this.total }); }
  sendQueue() { this.queue.forEach((q, i) => this.send(q, { type: "waiting", pos: i + 1, size: this.queue.length })); }

  unpair(p) {
    clearTimeout(p.timer);
    if (p.opp) { this.send(p.opp, { type: "left" }); p.opp.opp = null; p.opp.move = null; }
    const k = this.queue.indexOf(p);
    if (k >= 0) { this.queue.splice(k, 1); this.sendQueue(); }
    p.opp = null; p.ghost = null; p.move = null;
  }

  onMessage(p, raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === "join") return this.join(p);
    if (m.type === "move" && MOVES.includes(m.move)) return this.move(p, m.move);
    if (m.type === "chat") return this.chat(p, m.text);
  }

  join(p) {
    this.unpair(p);
    // 列の先頭から探す。直前の対戦相手とは連続でマッチさせない
    const i = this.queue.findIndex((w) => w !== p && w !== p.last && w.last !== p && this.players.has(w));
    if (i >= 0) {
      const [w] = this.queue.splice(i, 1);
      clearTimeout(w.timer);
      p.opp = w; w.opp = p; p.last = w; w.last = p;
      this.send(p, { type: "matched", country: w.country, ghost: false });
      this.send(w, { type: "matched", country: p.country, ghost: false });
      this.sendQueue();
      return;
    }
    this.queue.push(p);
    this.sendQueue();
    p.timer = setTimeout(() => {
      const k = this.queue.indexOf(p);
      if (k < 0) return;
      this.queue.splice(k, 1);
      const past = this.hist.length ? this.hist[Math.floor(Math.random() * this.hist.length)] : null;
      p.ghost = { move: past ? past.move : MOVES[Math.floor(Math.random() * 3)], country: past ? past.country : "XX" };
      this.send(p, { type: "matched", country: p.ghost.country, ghost: true });
      this.sendQueue();
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

  move(p, mv) {
    if (p.move || (!p.opp && !p.ghost)) return;
    p.move = mv;
    if (p.ghost) return this.finish(p, mv, p.ghost.move, p.ghost.country, true);
    const o = p.opp;
    if (!o.move) return this.send(p, { type: "locked" });
    this.finish(p, mv, o.move, o.country, false);
    this.finish(o, o.move, mv, p.country, false, true);
  }

  finish(p, mine, theirs, oppCountry, ghost, second) {
    this.send(p, { type: "result", you: mine, opp: theirs, outcome: judge(mine, theirs), country: oppCountry, ghost });
    if (!ghost) this.hist.push({ move: mine, country: p.country });
    if (this.hist.length > 50) this.hist.shift();
    if (!second) { this.total++; this.state.storage.put("total", this.total); }
    p.opp = null; p.ghost = null; p.move = null;
    if (!second) this.stats();
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const h = new Headers(req.headers);
      h.set("x-country", req.cf?.country || "XX");
      return env.LOBBY.get(env.LOBBY.idFromName("global")).fetch(new Request(req, { headers: h }));
    }
    return env.ASSETS.fetch(req);
  },
};
