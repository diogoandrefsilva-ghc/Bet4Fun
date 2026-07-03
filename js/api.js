/* ============================================================
   Camada de acesso a dados — Bet4Fun
   ------------------------------------------------------------
   Um único módulo `API` que o app.js consome. Fala sempre com o
   Supabase real (não há modo demo).

   Regra de ouro (ver SPECS §1): o cliente NUNCA escreve saldos,
   NUNCA liquida mercados e NUNCA lê apostas alheias antes do
   apito. Toda a escrita sensível passa por RPCs SECURITY DEFINER
   e por RLS no Supabase (ver db/).
   ============================================================ */

import { supabase } from "./supabase.js";

/* ---------- Mapa de badges (código → etiqueta visível) ---------- */
const BADGE_LABELS = {
  rei: "👑 Rei da Tabela",
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

/* Enriquece as linhas do livro de um mercado LIQUIDADO com o que cada um
   ganhou (pool betting — igual ao settle_market do SQL):
     vencedores → floor(pote * stake / pote_vencedor)  (resto p/ o maior)
     ninguém no vencedor → reembolso a todos
   Anexa line.result = {kind:'won',amount} | {kind:'lost'} | {kind:'refund'}. */
function enrichBookWithWinnings(mk, book) {
  if (mk.status !== "settled") return;
  const W = mk.winnerOptionId;
  const pot = mk.pot;
  const winnerPool = W ? (mk.options.find((o) => String(o.id) === String(W))?.pool || 0) : 0;

  if (pot > 0 && winnerPool > 0) {
    const winners = [];
    mk.options.forEach((o) => {
      (book[`${mk.id}:${o.id}`] || []).forEach((line) => {
        if (String(o.id) === String(W)) {
          line.result = { kind: "won", amount: Math.floor(pot * line.stake / winnerPool) };
          winners.push(line);
        } else {
          line.result = { kind: "lost" };
        }
      });
    });
    // resto de arredondamento → maior apostador vencedor (como no SQL)
    const remainder = pot - winners.reduce((a, l) => a + l.result.amount, 0);
    if (remainder > 0 && winners.length) {
      winners.reduce((a, b) => (b.stake > a.stake ? b : a)).result.amount += remainder;
    }
  } else {
    // ninguém acertou (ou pote vazio) → reembolso a todos os apostadores
    mk.options.forEach((o) => {
      (book[`${mk.id}:${o.id}`] || []).forEach((line) => { line.result = { kind: "refund" }; });
    });
  }
}

/* ============================================================
   Supabase — camada de dados real
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

  // Inscreve o utilizador no Bet4Fun no 1.º acesso (cria o perfil se faltar).
  // O auth.users é partilhado por várias apps — por isso a inscrição é feita
  // aqui, à chegada, e não por trigger global de signup (ver db/functions.sql).
  async ensureProfile() {
    const { error } = await supabase.rpc("ensure_profile");
    if (error) throwErr(error, "Não foi possível criar o perfil");
  },

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
      avatar: profile.avatar_emoji || "⚽",
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
    const uid = await this._requireUid();
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
      .select("id,name,risk,status,winning_option_id,closes_at,market_options(id,label,sort)")
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

    // A minha aposta em cada mercado (visível sempre — RLS deixa ver a própria)
    const mineMap = {};
    if (uid && mkIds.length) {
      const { data: mine } = await supabase
        .from("bets").select("market_id,option_id,stake")
        .eq("profile_id", uid).in("market_id", mkIds);
      (mine || []).forEach((b) => {
        mineMap[b.market_id] = { optionId: String(b.option_id), stake: b.stake };
      });
    }

    const marketsOut = (markets || []).map((mk) => ({
      id: String(mk.id),
      risk: mk.risk,
      name: mk.name,
      status: mk.status,
      pot: totMap[mk.id] || 0,
      mine: mineMap[mk.id] || null,
      winnerOptionId: mk.winning_option_id != null ? String(mk.winning_option_id) : null,
      options: (mk.market_options || [])
        .sort((a, b) => (a.sort || 0) - (b.sort || 0))
        .map((o) => ({ id: String(o.id), label: o.label, pool: poolMap[`${mk.id}:${o.id}`] || 0 })),
    }));
    match.pot = marketsOut.reduce((a, mk) => a + mk.pot, 0);

    // Livro aberto (só depois do apito; a RLS garante 0 linhas antes).
    // Agrupado por opção: { "marketId:optionId": [ {who, avatar, stake}, ... ] }
    const book = {};
    const stakeByProfile = {};   // profileId → { who, avatar, staked } (total no jogo)
    if (!open && mkIds.length) {
      const { data: bets } = await supabase
        .from("bets")
        .select("stake,market_id,option_id,profile_id,profiles(display_name,avatar_emoji)")
        .in("market_id", mkIds);
      (bets || []).forEach((b) => {
        const who = b.profiles?.display_name || "?";
        const avatar = b.profiles?.avatar_emoji || "⚽";
        const key = `${b.market_id}:${b.option_id}`;
        (book[key] || (book[key] = [])).push({ who, avatar, stake: b.stake });
        const acc = stakeByProfile[b.profile_id] || (stakeByProfile[b.profile_id] = { who, avatar, staked: 0 });
        acc.staked += b.stake;
      });
      Object.values(book).forEach((arr) => arr.sort((x, y) => y.stake - x.stake));
      // Quanto é que cada um ganhou (pool betting) — só nos mercados liquidados.
      marketsOut.forEach((mk) => enrichBookWithWinnings(mk, book));
    }

    // Fichas expiradas por jogo (aposta mínima obrigatória). Só depois do apito.
    //   reais   → tabela chip_expiries (débito já feito na liquidação)
    //   projetadas → quem apostou < mínimo mas o jogo ainda não liquidou
    let expiries = [];
    const settings = await this._settingsMap();
    const minMatch = Number(settings.min_match_stake ?? 100);
    if (!open && mkIds.length) {
      if (minMatch > 0) {
        const kickoffMs = new Date(m.kickoff_at).getTime();
        const { data: players } = await supabase
          .from("profiles").select("id,display_name,avatar_emoji,created_at").eq("is_approved", true);
        const { data: realRows } = await supabase
          .from("chip_expiries").select("profile_id,amount").eq("match_id", matchId);
        const realMap = {}; (realRows || []).forEach((e) => { realMap[e.profile_id] = e.amount; });
        expiries = (players || [])
          .filter((p) => new Date(p.created_at).getTime() <= kickoffMs)   // já cá estava ao apito
          .map((p) => {
            const staked = stakeByProfile[p.id]?.staked || 0;
            const real = realMap[p.id] ?? null;
            const amount = real != null ? real : Math.max(0, minMatch - staked);
            return {
              who: p.display_name, avatar: p.avatar_emoji || "⚽",
              staked, amount, expired: real != null,
            };
          })
          .filter((e) => e.amount > 0)
          .sort((a, b) => b.amount - a.amount);
      }
    }

    return { match, open, markets: marketsOut, book, expiries, minMatchStake: minMatch };
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
        market: mk.name ?? "",
        option: b.market_options?.label ?? "",
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
      avatar: p.avatar_emoji || "⚽",
      chips: p.chips,
      locked: p.locked || 0,   // fichas cativas (apostadas em eventos por liquidar)
      delta: p.delta || 0,
      badges: (p.badge_codes || []).map(badgeLabel),
      bankrupt: (p.chips - (p.locked || 0)) < minStake,  // teso = saldo gastável baixo
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

  // Histórico de apostas resolvidas de um jogador (para tocar na classificação).
  // As apostas alheias em mercados já fechados são públicas (RLS); o ganho é
  // recalculado pelo pool betting (não lê transações alheias).
  async getPlayerHistory(profileId) {
    const { data: bets, error } = await supabase
      .from("bets")
      .select("stake,option_id,market_id,created_at,market_options(label),markets(name,status,winning_option_id,matches(team_a,flag_a,team_b,flag_b,kickoff_at))")
      .eq("profile_id", profileId)
      .order("created_at", { ascending: false });
    if (error) throwErr(error, "Não consegui carregar o histórico");

    const settled = (bets || []).filter((b) => b.markets?.status === "settled");
    const ids = [...new Set(settled.map((b) => b.market_id))];
    const potMap = {}, poolMap = {};
    if (ids.length) {
      const { data: totals } = await supabase.from("market_totals").select("*").in("market_id", ids);
      (totals || []).forEach((t) => { potMap[t.market_id] = t.pot; });
      const { data: pools } = await supabase.from("market_pools").select("*").in("market_id", ids);
      (pools || []).forEach((p) => { poolMap[`${p.market_id}:${p.option_id}`] = p.pool; });
    }

    let won = 0, lost = 0;
    const items = settled.map((b) => {
      const mk = b.markets || {};
      const mt = mk.matches || {};
      const pot = potMap[b.market_id] || 0;
      const winnerPool = poolMap[`${b.market_id}:${mk.winning_option_id}`] || 0;
      let status = "lost", payout = 0;
      if (winnerPool === 0) {
        status = "refund";                                   // ninguém acertou → reembolso
      } else if (String(b.option_id) === String(mk.winning_option_id)) {
        status = "won"; won++; payout = Math.floor(pot * b.stake / winnerPool);
      } else {
        lost++;
      }
      return {
        match: mt.team_a ? `${mt.flag_a || ""} ${mt.team_a} vs ${mt.team_b} ${mt.flag_b || ""}` : (mk.name || ""),
        pick: `${mk.name ?? ""} · ${b.market_options?.label ?? ""}`,
        stake: b.stake, status, payout,
      };
    });
    return { items, won, lost };
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
    return (data || []).map((p) => ({ id: p.id, who: p.display_name, avatar: p.avatar_emoji || "⚽" }));
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
      avatar: b.profiles?.avatar_emoji || "⚽", note: b.note || "",
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
  // Formulário de edição de um jogo (admin): dados do jogo + mercados com pote
  async getEditForm(matchId) {
    const { data: m, error } = await supabase
      .from("matches").select("*").eq("id", matchId).maybeSingle();
    if (error || !m) throwErr(error, "Jogo não encontrado");
    const { data: markets } = await supabase
      .from("markets")
      .select("id,name,risk,status,winning_option_id,market_options(id,label,sort)")
      .eq("match_id", matchId).order("id", { ascending: true });
    const ids = (markets || []).map((mk) => mk.id);
    const { data: totals } = ids.length
      ? await supabase.from("market_totals").select("*").in("market_id", ids)
      : { data: [] };
    const totMap = {}; (totals || []).forEach((t) => { totMap[t.market_id] = t.pot; });
    return {
      match: {
        id: String(m.id), stage: m.stage,
        teamA: m.team_a, flagA: m.flag_a || "", teamB: m.team_b, flagB: m.flag_b || "",
        kickoffAt: m.kickoff_at, status: displayStatus(m),
        scoreA: m.score_a, scoreB: m.score_b,
      },
      markets: (markets || []).map((mk) => ({
        id: String(mk.id), name: mk.name, risk: mk.risk, status: mk.status,
        pot: totMap[mk.id] || 0, nOptions: (mk.market_options || []).length,
        winningOptionId: mk.winning_option_id != null ? String(mk.winning_option_id) : null,
        options: (mk.market_options || [])
          .sort((a, b) => (a.sort || 0) - (b.sort || 0))
          .map((o) => ({ id: String(o.id), label: o.label })),
      })),
    };
  },
  async updateMatch(matchId, stage, kickoffAt) {
    const { error } = await supabase.rpc("update_match", {
      p_match_id: Number(matchId), p_stage: stage || null, p_kickoff_at: kickoffAt || null,
    });
    if (error) throwErr(error, "Falha ao atualizar o jogo");
    return { ok: true };
  },
  async addMarket(matchId, name, risk, options) {
    const { error } = await supabase.rpc("add_market", {
      p_match_id: Number(matchId), p_name: name, p_risk: risk, p_options: options,
    });
    if (error) throwErr(error, "Falha ao adicionar o mercado");
    return { ok: true };
  },
  async removeMarket(marketId) {
    const { error } = await supabase.rpc("remove_market", { p_market_id: Number(marketId) });
    if (error) throwErr(error, "Falha ao remover o mercado");
    return { ok: true };
  },
  async removeMatch(matchId) {
    const { error } = await supabase.rpc("remove_match", { p_match_id: Number(matchId) });
    if (error) throwErr(error, "Falha ao apagar o jogo");
    return { ok: true };
  },
  /* ----- Mercados por defeito (admin) ----- */
  async getDefaultMarkets() {
    this._settings = null;   // ler fresco — a config pode ter mudado noutro ecrã
    const settings = await this._settingsMap();
    const v = settings.default_markets;
    return Array.isArray(v) && v.length
      ? v
      : ["Resultado (1X2)", "Mais/Menos 2.5 golos", "Resultado exato", "Decisão por penáltis"];
  },
  async setDefaultMarkets(names) {
    const { error } = await supabase.rpc("set_default_markets", { p_names: names });
    if (error) throwErr(error, "Falha ao guardar os mercados por defeito");
    this._settings = null;
    return { ok: true };
  },
  async applyDefaultMarkets() {
    const { data, error } = await supabase.rpc("apply_default_markets");
    if (error) throwErr(error, "Falha ao aplicar aos jogos existentes");
    return Number(data) || 0;
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

export const API = liveAPI;
