/* ============================================================
   Camada de acesso a dados — O Casino da Malta
   ------------------------------------------------------------
   Um único módulo `API` que o app.js consome. Devolve sempre a
   MESMA forma de dados, quer esteja em MODO DEMO (dados
   fictícios de data.js) quer em MODO LIVE (Supabase).

   Regra de ouro (ver SPECS §1): o cliente NUNCA escreve saldos,
   NUNCA liquida mercados e NUNCA lê apostas alheias antes do
   apito. Toda a escrita sensível passa por RPCs SECURITY DEFINER
   e por RLS no Supabase (ver db/).
   ============================================================ */

import { supabase } from "./supabase.js";
import { DEMO_MODE } from "./config.js";
import { MOCK } from "./data.js";

/* ---------- Mapa de badges (código → etiqueta visível) ---------- */
const BADGE_LABELS = {
  rei: "🎩 Rei do Casino",
  conservador: "🧊 O Conservador",
  lunatico: "🌪️ O Lunático",
  anti_patria: "🇵🇹 O Anti-Pátria",
  sniper: "🎯 Sniper",
  fmi: "💸 Financiado pelo FMI",
};
const badgeLabel = (code) => BADGE_LABELS[code] || code;

/* ---------- Helpers ---------- */

function fmtKickoff(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  const tmr = new Date(now); tmr.setDate(now.getDate() + 1);
  const hh = d.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `Hoje · ${hh}`;
  if (d.toDateString() === yest.toDateString()) return `Ontem · ${hh}`;
  if (d.toDateString() === tmr.toDateString()) return `Amanhã · ${hh}`;
  return `${d.toLocaleDateString("pt-PT", { day: "2-digit", month: "short" })} · ${hh}`;
}

/* Estado de exibição a partir do estado real + kickoff.
   open = apostas abertas · live = livro aberto · done = liquidado/terminado */
function displayStatus(m) {
  const kicked = new Date(m.kickoff_at).getTime() <= Date.now();
  if (m.status === "settled" || m.status === "finished") return "done";
  if (m.status === "live" || kicked) return "live";
  return "open";
}

function throwErr(error, fallback) {
  const msg = error?.message || fallback || "Erro inesperado";
  throw new Error(msg);
}

/* ============================================================
   MODO DEMO — devolve os dados fictícios do protótipo
   ============================================================ */
const demoAPI = {
  isDemo: true,
  _loggedIn: false,

  async getSession() { return this._loggedIn ? { user: { id: "u1", email: MOCK.me.email } } : null; },
  onAuthChange() { return () => {}; },
  async signInWithGoogle() { this._loggedIn = true; },
  async signOut() { this._loggedIn = false; },

  async getMyProfile() {
    return {
      id: MOCK.me.id, name: MOCK.me.name, avatar: MOCK.me.avatar,
      email: MOCK.me.email, chips: MOCK.me.chips,
      isAdmin: MOCK.me.isAdmin, isApproved: true,
      badges: ["🎩 Rei do Casino", "🎯 Sniper — acertou um resultado exato", "🔥 3 vitórias seguidas"],
    };
  },

  async getMatches() { return MOCK.matches.map((m) => ({ ...m })); },
  async getFutures() { return MOCK.futures.map((f) => ({ ...f })); },

  async getMatchDetail(matchId) {
    const match = MOCK.matches.find((x) => x.id === matchId) || MOCK.matches[0];
    const open = match.status === "open";
    return {
      match: { ...match },
      open,
      markets: open ? (MOCK.markets[match.id] || MOCK.markets.m1) : [],
      reveal: open ? [] : (MOCK.reveal[match.id] || []),
    };
  },

  async placeBet() { return { ok: true }; },
  async getMyBets() {
    return {
      pending: MOCK.myBets.filter((b) => b.status === "pending"),
      settled: MOCK.myBets.filter((b) => b.status !== "pending"),
    };
  },

  async getLeaderboard() {
    return MOCK.players.map((p) => ({ ...p, isMe: p.id === MOCK.me.id }));
  },

  async getProfileStats() { return { ...MOCK.stats }; },
  async requestBailout() { return { ok: true }; },

  /* Admin */
  async getPendingPlayers() { return []; },
  async approvePlayer() { return { ok: true }; },
  async getBailouts() { return MOCK.admin.bailouts.map((b) => ({ ...b })); },
  async approveBailout() { return { ok: true }; },
  async getMatchesToSettle() { return MOCK.admin.toSettle.map((s) => ({ ...s })); },
  async getSettleForm(matchId) {
    const match = MOCK.matches.find((x) => x.id === matchId) || MOCK.matches[2];
    return { match: { ...match }, markets: MOCK.markets[match.id] || MOCK.markets.m1 };
  },
  async setMatchScore() { return { ok: true }; },
  async settleMarket() { return { ok: true }; },
  async voidMarket() { return { ok: true }; },
  async createMatch() { return { ok: true }; },
};

/* ============================================================
   MODO LIVE — Supabase
   ============================================================ */
const liveAPI = {
  isDemo: false,
  _settings: null,
  _uid: null,

  async _settingsMap() {
    if (this._settings) return this._settings;
    const { data } = await supabase.from("settings").select("key,value");
    this._settings = {};
    (data || []).forEach((r) => { this._settings[r.key] = r.value; });
    return this._settings;
  },

  /* ----- Auth ----- */
  async getSession() {
    const { data } = await supabase.auth.getSession();
    this._uid = data?.session?.user?.id || null;
    return data?.session || null;
  },
  onAuthChange(cb) {
    const { data } = supabase.auth.onAuthStateChange((_e, session) => {
      this._uid = session?.user?.id || null;
      cb(session);
    });
    return () => data?.subscription?.unsubscribe?.();
  },
  async signInWithGoogle() {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin + window.location.pathname },
    });
    if (error) throwErr(error, "Falha no login com o Google");
  },
  async signOut() { await supabase.auth.signOut(); },

  async _requireUid() {
    if (this._uid) return this._uid;
    const s = await this.getSession();
    return s?.user?.id || null;
  },

  /* ----- Perfil / saldo ----- */
  async getMyProfile() {
    const uid = await this._requireUid();
    if (!uid) return null;
    const { data: session } = await supabase.auth.getSession();
    const email = session?.session?.user?.email || "";

    const { data: profile, error } = await supabase
      .from("profiles").select("*").eq("id", uid).maybeSingle();
    if (error) throwErr(error, "Não consegui ler o perfil");
    if (!profile) return null; // trigger ainda não criou; app trata como pendente

    const { data: bal } = await supabase
      .from("balances").select("chips").eq("profile_id", uid).maybeSingle();
    const { data: myBadges } = await supabase
      .from("badges").select("code").eq("profile_id", uid);

    return {
      id: profile.id,
      name: profile.display_name,
      avatar: profile.avatar_emoji || "🎲",
      email,
      chips: bal?.chips ?? 0,
      isAdmin: !!profile.is_admin,
      isApproved: !!profile.is_approved,
      badges: (myBadges || []).map((b) => badgeLabel(b.code)),
    };
  },

  /* ----- Jogos ----- */
  async getMatches() {
    const { data: matches, error } = await supabase
      .from("matches").select("*").order("kickoff_at", { ascending: true });
    if (error) throwErr(error, "Não consegui carregar os jogos");
    const { data: pots } = await supabase.from("match_pots").select("*");
    const potMap = {};
    (pots || []).forEach((p) => { potMap[p.match_id] = p.pot; });
    return (matches || []).map((m) => ({
      id: String(m.id),
      stage: m.stage,
      teamA: m.team_a, flagA: m.flag_a || "", teamB: m.team_b, flagB: m.flag_b || "",
      kickoff: fmtKickoff(m.kickoff_at),
      kickoffAt: m.kickoff_at,
      status: displayStatus(m),
      scoreA: m.score_a, scoreB: m.score_b,
      pot: potMap[m.id] || 0,
    }));
  },

  async getFutures() {
    const uid = await this._requireUid();
    const { data: markets, error } = await supabase
      .from("markets")
      .select("id,name,closes_at,status,market_options(id,label)")
      .is("match_id", null)
      .order("id", { ascending: true });
    if (error) throwErr(error, "Não consegui carregar os mercados de longo prazo");
    const { data: totals } = await supabase.from("market_totals").select("*");
    const totMap = {};
    (totals || []).forEach((t) => { totMap[t.market_id] = t.pot; });

    let myBetsMap = {};
    if (uid && markets?.length) {
      const ids = markets.map((m) => m.id);
      const { data: myBets } = await supabase
        .from("bets").select("market_id,stake,market_options(label)")
        .eq("profile_id", uid).in("market_id", ids);
      (myBets || []).forEach((b) => {
        myBetsMap[b.market_id] = `${b.market_options?.label ?? "?"} · ${b.stake} fichas`;
      });
    }

    return (markets || []).map((m) => ({
      id: String(m.id),
      name: m.name,
      pot: totMap[m.id] || 0,
      locked: new Date(m.closes_at).getTime() <= Date.now() || m.status !== "open",
      myPick: myBetsMap[m.id] || null,
    }));
  },

  async getMatchDetail(matchId) {
    const { data: m, error } = await supabase
      .from("matches").select("*").eq("id", matchId).maybeSingle();
    if (error || !m) throwErr(error, "Jogo não encontrado");
    const status = displayStatus(m);
    const open = status === "open";

    const match = {
      id: String(m.id), stage: m.stage,
      teamA: m.team_a, flagA: m.flag_a || "", teamB: m.team_b, flagB: m.flag_b || "",
      kickoff: fmtKickoff(m.kickoff_at), status,
      scoreA: m.score_a, scoreB: m.score_b, pot: 0,
    };

    // Mercados + opções + pools
    const { data: markets } = await supabase
      .from("markets")
      .select("id,name,risk,closes_at,market_options(id,label,sort)")
      .eq("match_id", matchId)
      .order("id", { ascending: true });
    const mkIds = (markets || []).map((mk) => mk.id);

    const { data: pools } = mkIds.length
      ? await supabase.from("market_pools").select("*").in("market_id", mkIds)
      : { data: [] };
    const { data: totals } = mkIds.length
      ? await supabase.from("market_totals").select("*").in("market_id", mkIds)
      : { data: [] };
    const poolMap = {}; (pools || []).forEach((p) => { poolMap[`${p.market_id}:${p.option_id}`] = p.pool; });
    const totMap = {}; (totals || []).forEach((t) => { totMap[t.market_id] = t.pot; });

    const marketsOut = (markets || []).map((mk) => ({
      id: String(mk.id),
      risk: mk.risk,
      name: mk.name,
      pot: totMap[mk.id] || 0,
      options: (mk.market_options || [])
        .sort((a, b) => (a.sort || 0) - (b.sort || 0))
        .map((o) => ({ id: String(o.id), label: o.label, pool: poolMap[`${mk.id}:${o.id}`] || 0 })),
    }));
    match.pot = marketsOut.reduce((a, mk) => a + mk.pot, 0);

    // Livro aberto (só depois do apito; a RLS garante 0 linhas antes)
    let reveal = [];
    if (!open && mkIds.length) {
      const { data: bets } = await supabase
        .from("bets")
        .select("stake,market_options(label),markets!inner(name,match_id),profiles(display_name,avatar_emoji)")
        .eq("markets.match_id", matchId);
      reveal = (bets || []).map((b) => ({
        who: b.profiles?.display_name || "?",
        avatar: b.profiles?.avatar_emoji || "🎲",
        pick: `${b.markets?.name ?? ""} · ${b.market_options?.label ?? ""}`,
        stake: b.stake,
      }));
    }

    return { match, open, markets: marketsOut, reveal };
  },

  /* ----- Apostar ----- */
  async placeBet(marketId, optionId, stake) {
    const { error } = await supabase.rpc("place_bet", {
      p_market_id: Number(marketId), p_option_id: Number(optionId), p_stake: Number(stake),
    });
    if (error) throwErr(error, "Não foi possível registar a aposta");
    return { ok: true };
  },

  async getMyBets() {
    const uid = await this._requireUid();
    if (!uid) return { pending: [], settled: [] };

    const { data: bets, error } = await supabase
      .from("bets")
      .select("id,stake,option_id,market_id,market_options(label),markets(name,status,winning_option_id,closes_at,matches(team_a,flag_a,team_b,flag_b,kickoff_at))")
      .eq("profile_id", uid)
      .order("created_at", { ascending: false });
    if (error) throwErr(error, "Não consegui carregar as tuas apostas");

    // pagamentos recebidos por aposta
    const { data: payouts } = await supabase
      .from("transactions").select("amount,ref_bet_id").eq("profile_id", uid).eq("kind", "payout");
    const payMap = {}; (payouts || []).forEach((t) => { payMap[t.ref_bet_id] = (payMap[t.ref_bet_id] || 0) + t.amount; });

    const pending = [], settled = [];
    (bets || []).forEach((b) => {
      const mk = b.markets || {};
      const mt = mk.matches || {};
      const matchLabel = mt.team_a
        ? `${mt.flag_a || ""} ${mt.team_a} vs ${mt.team_b} ${mt.flag_b || ""} · ${fmtKickoff(mt.kickoff_at)}`
        : mk.name;
      const closed = new Date(mk.closes_at).getTime() <= Date.now();
      const row = {
        id: String(b.id),
        match: matchLabel,
        pick: `${mk.name ?? ""} · ${b.market_options?.label ?? ""}`,
        stake: b.stake,
        secret: !closed,
      };
      if (mk.status === "settled") {
        if (String(b.option_id) === String(mk.winning_option_id)) {
          row.status = "won"; row.payout = payMap[b.id] || 0;
        } else { row.status = "lost"; }
        settled.push(row);
      } else if (mk.status === "void") {
        row.status = "lost"; settled.push(row); // reembolsado; mostra como resolvido
      } else {
        row.status = "pending"; pending.push(row);
      }
    });
    return { pending, settled };
  },

  /* ----- Classificação ----- */
  async getLeaderboard() {
    const uid = await this._requireUid();
    const settings = await this._settingsMap();
    const minStake = Number(settings.min_stake ?? 5);
    const { data, error } = await supabase
      .from("leaderboard").select("*").order("chips", { ascending: false });
    if (error) throwErr(error, "Não consegui carregar a classificação");
    return (data || []).map((p) => ({
      id: p.id,
      name: p.display_name,
      avatar: p.avatar_emoji || "🎲",
      chips: p.chips,
      delta: p.delta || 0,
      badges: (p.badge_codes || []).map(badgeLabel),
      bankrupt: p.chips < minStake,
      isMe: p.id === uid,
    }));
  },

  async getProfileStats() {
    const uid = await this._requireUid();
    if (!uid) return { total: 0, won: 0, winRate: "0%" };
    const { data: bets } = await supabase
      .from("bets").select("option_id,markets(status,winning_option_id)").eq("profile_id", uid);
    const total = (bets || []).length;
    let settledN = 0, won = 0;
    (bets || []).forEach((b) => {
      if (b.markets?.status === "settled") {
        settledN++;
        if (String(b.option_id) === String(b.markets.winning_option_id)) won++;
      }
    });
    const winRate = settledN ? `${Math.round((won / settledN) * 100)}%` : "—";
    return { total, won, winRate };
  },

  async requestBailout(note) {
    const { error } = await supabase.rpc("request_bailout", { p_note: note || null });
    if (error) throwErr(error, "Não foi possível pedir o resgate");
    return { ok: true };
  },

  /* ----- Admin ----- */
  async getPendingPlayers() {
    const { data, error } = await supabase
      .from("profiles").select("id,display_name,avatar_emoji")
      .eq("is_approved", false).order("created_at", { ascending: true });
    if (error) throwErr(error, "Não consegui carregar os jogadores pendentes");
    return (data || []).map((p) => ({ id: p.id, who: p.display_name, avatar: p.avatar_emoji || "🎲" }));
  },
  async approvePlayer(id) {
    const { error } = await supabase.rpc("approve_player", { p_profile_id: id });
    if (error) throwErr(error, "Falha ao aprovar o jogador");
    return { ok: true };
  },

  async getBailouts() {
    const { data, error } = await supabase
      .from("bailout_requests")
      .select("id,note,profiles(display_name,avatar_emoji)")
      .eq("status", "pending").order("created_at", { ascending: true });
    if (error) throwErr(error, "Não consegui carregar os pedidos de bailout");
    return (data || []).map((b) => ({
      id: b.id, who: b.profiles?.display_name || "?",
      avatar: b.profiles?.avatar_emoji || "🎲", note: b.note || "",
    }));
  },
  async approveBailout(id) {
    const { error } = await supabase.rpc("approve_bailout", { p_request_id: id });
    if (error) throwErr(error, "Falha ao aprovar o bailout");
    return { ok: true };
  },

  async getMatchesToSettle() {
    // jogos com mercados por liquidar (status open/closed)
    const { data: markets } = await supabase
      .from("markets").select("match_id,status").not("match_id", "is", null);
    const counts = {};
    (markets || []).forEach((m) => {
      if (m.status === "open" || m.status === "closed") {
        counts[m.match_id] = (counts[m.match_id] || 0) + 1;
      }
    });
    const ids = Object.keys(counts);
    if (!ids.length) return [];
    const { data: matches } = await supabase
      .from("matches").select("*").in("id", ids).order("kickoff_at", { ascending: true });
    return (matches || []).map((m) => ({
      id: String(m.id),
      match: `${m.flag_a || ""} ${m.team_a} vs ${m.team_b} ${m.flag_b || ""}`,
      detail: `${counts[m.id]} mercado(s) por liquidar${m.score_a != null ? ` · resultado ${m.score_a}-${m.score_b}` : " · resultado por introduzir"}`,
    }));
  },

  async getSettleForm(matchId) {
    const { data: m } = await supabase.from("matches").select("*").eq("id", matchId).maybeSingle();
    const { data: markets } = await supabase
      .from("markets")
      .select("id,name,risk,status,winning_option_id,market_options(id,label,sort)")
      .eq("match_id", matchId).order("id", { ascending: true });
    return {
      match: {
        id: String(m.id), teamA: m.team_a, flagA: m.flag_a, teamB: m.team_b, flagB: m.flag_b,
        scoreA: m.score_a, scoreB: m.score_b,
      },
      markets: (markets || []).map((mk) => ({
        id: String(mk.id), name: mk.name, risk: mk.risk, status: mk.status,
        winningOptionId: mk.winning_option_id != null ? String(mk.winning_option_id) : null,
        options: (mk.market_options || [])
          .sort((a, b) => (a.sort || 0) - (b.sort || 0))
          .map((o) => ({ id: String(o.id), label: o.label })),
      })),
    };
  },

  async setMatchScore(matchId, a, b) {
    const { error } = await supabase.rpc("set_match_result", {
      p_match_id: Number(matchId), p_score_a: Number(a), p_score_b: Number(b),
    });
    if (error) throwErr(error, "Falha ao guardar o resultado");
    return { ok: true };
  },
  async settleMarket(marketId, winningOptionId) {
    const { error } = await supabase.rpc("settle_market", {
      p_market_id: Number(marketId), p_winning_option_id: Number(winningOptionId),
    });
    if (error) throwErr(error, "Falha ao liquidar o mercado");
    return { ok: true };
  },
  async voidMarket(marketId) {
    const { error } = await supabase.rpc("void_market", { p_market_id: Number(marketId) });
    if (error) throwErr(error, "Falha ao anular o mercado");
    return { ok: true };
  },
  async createMatch(payload) {
    const { error } = await supabase.rpc("create_match_with_markets", {
      p_stage: payload.stage,
      p_team_a: payload.teamA, p_flag_a: payload.flagA,
      p_team_b: payload.teamB, p_flag_b: payload.flagB,
      p_kickoff_at: payload.kickoffAt,
      p_knockout: !!payload.knockout,
    });
    if (error) throwErr(error, "Falha ao criar o jogo");
    return { ok: true };
  },
};

export const API = DEMO_MODE ? demoAPI : liveAPI;
export { DEMO_MODE };
