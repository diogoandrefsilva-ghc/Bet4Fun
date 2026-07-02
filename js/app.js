/* ============================================================
   Bet4Fun — app (router + ecrãs)
   ------------------------------------------------------------
   Ligado ao Supabase via js/api.js. Cada render*() busca dados
   reais. As funções chamadas por onclick inline são expostas em
   window no fim do ficheiro (este módulo é ESM).
   ============================================================ */

import { API } from "./api.js";
import { IS_CONFIGURED } from "./config.js";

const $ = (sel) => document.querySelector(sel);

const state = {
  session: null,
  profile: null,
  slip: null,     // { marketId, optionId, matchLabel, marketName, optionLabel, potTotal, optionPool, stake }
  detail: null,   // último detalhe de jogo carregado (para o boletim)
};

/* ---------- Router ---------- */

const routes = {
  "": renderJogos,
  jogos: renderJogos,
  jogo: renderJogoDetalhe,
  apostas: renderApostas,
  classificacao: renderClassificacao,
  perfil: renderPerfil,
  admin: renderAdmin,
  settle: renderSettle,
  criar: renderCriarJogo,
};

async function navigate() {
  if (!state.session) { renderLogin(); return; }
  if (!state.profile) {
    try { state.profile = await API.getMyProfile(); }
    catch (e) { renderError(e); return; }
  }
  if (!state.profile || !state.profile.isApproved) { renderPending(); return; }

  const [route, param] = location.hash.replace(/^#\/?/, "").split("/");
  const view = routes[route] || renderJogos;
  closeSlip();
  try {
    await view(param);
  } catch (e) {
    renderError(e);
    return;
  }
  updateTabs(route || "jogos");
  window.scrollTo(0, 0);
}

window.addEventListener("hashchange", navigate);

function updateTabs(route) {
  const map = {
    jogos: "jogos", jogo: "jogos", apostas: "apostas",
    classificacao: "classificacao", perfil: "perfil",
    admin: "perfil", settle: "perfil", criar: "perfil",
  };
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === (map[route] || "jogos"));
  });
}

/* ---------- Estados globais (loading / erro) ---------- */

function loadingScreen(msg = "A carregar…") {
  return `<div class="empty"><span class="ico">⚽</span>${msg}</div>`;
}

function renderError(e) {
  console.error(e);
  $("#app").innerHTML = `
    <div class="login">
      <div class="big-logo">⚽💥</div>
      <h1>Ups.</h1>
      <p class="tagline">${escapeHtml(e?.message || "Algo correu mal.")}</p>
      <button class="btn-secondary" style="max-width:320px" onclick="location.reload()">Tentar de novo</button>
    </div>`;
}

/* ---------- Login ---------- */

function renderLogin() {
  $("#app").innerHTML = `
    <div class="login">
      <div class="big-logo">⚽</div>
      <h1>Bet4Fun</h1>
      <p class="tagline">Mundial 2026 · Prognósticos de futebol e picardia entre amigos. Zero dinheiro real — só fichas e prestígio.</p>

      <div class="login-card">
        <div class="lc-title">Como funciona</div>
        <ol class="rules">
          <li><span class="n">1</span><span class="t">Recebes <strong>fichas virtuais</strong> quando o admin te aprova.</span></li>
          <li><span class="n">2</span><span class="t">Apostas fichas no resultado dos jogos <strong>antes do apito</strong>.</span></li>
          <li><span class="n">3</span><span class="t">Quem acerta divide o <strong>pote</strong> de cada aposta entre si. Sobes (ou afundas) na tabela.</span></li>
        </ol>
      </div>

      <button class="btn-google" onclick="doLogin()">
        <span class="g">G</span> Entrar com o Google
      </button>
      <p class="fine">Só para a malta convidada. Depois de entrares, ficas à espera que o admin te dê as fichas iniciais.</p>
    </div>`;
}

async function doLogin() {
  try {
    await API.signInWithGoogle(); // redireciona para o Google e volta
  } catch (e) { renderError(e); }
}

async function doLogout() {
  await API.signOut();
  state.session = null;
  state.profile = null;
  location.hash = "";
  await navigate();
}

/* ---------- Ecrã: à espera de aprovação ---------- */

function renderPending() {
  const name = state.profile?.name ? `, ${escapeHtml(state.profile.name)}` : "";
  $("#app").innerHTML = `
    <div class="login">
      <div class="big-logo">🕰️</div>
      <h1>Quase lá${name}!</h1>
      <p class="tagline">Estás à espera que o admin te deixe entrar no grupo. Assim que fores aprovado, recebes as tuas fichas iniciais.</p>
      <button class="btn-primary" style="max-width:320px" onclick="refreshPending()">Já me aprovaram? Verificar 🔄</button>
      <button class="btn-secondary" style="max-width:320px;margin-top:10px;border-color:transparent;color:var(--text-faint)" onclick="doLogout()">Terminar sessão</button>
    </div>`;
}

async function refreshPending() {
  state.profile = null;
  await navigate();
}

/* ---------- Shell (header + tabbar) ---------- */

function shell(content) {
  const chips = (state.profile?.chips ?? 0).toLocaleString("pt-PT");
  $("#app").innerHTML = `
    <div class="app">
      <header class="header">
        <div class="brand"><span class="logo">⚽</span> Bet4Fun</div>
        <div class="chip-balance">🪙 ${chips}</div>
      </header>
      <main class="main">${content}</main>
      <nav class="tabbar">
        <div class="tabbar-inner">
          <button class="tab" data-tab="jogos" onclick="location.hash='#/jogos'"><span class="icon">⚽</span>Jogos</button>
          <button class="tab" data-tab="apostas" onclick="location.hash='#/apostas'"><span class="icon">🎟️</span>Apostas</button>
          <button class="tab" data-tab="classificacao" onclick="location.hash='#/classificacao'"><span class="icon">🏆</span>Classificação</button>
          <button class="tab" data-tab="perfil" onclick="location.hash='#/perfil'"><span class="icon">😎</span>Perfil</button>
        </div>
      </nav>
      <div class="slip" id="slip"></div>
      <div class="toast" id="toast"></div>
    </div>`;
}

/* ---------- Ecrã: Jogos ---------- */

function matchCard(m) {
  const statusTag =
    m.status === "live" ? `<span class="tag tag-live"><span class="dot"></span> Ao vivo</span>` :
    m.status === "open" ? `<span class="tag tag-open">Apostas abertas</span>` :
    `<span class="tag tag-done">Terminado</span>`;

  const hasScore = m.scoreA != null && m.scoreB != null;
  const mid = (m.status === "open" || !hasScore)
    ? `<span class="vs">VS</span><span class="time">${m.kickoff}</span>`
    : `<span class="score">${m.scoreA} – ${m.scoreB}</span><span class="time">${m.kickoff}</span>`;

  return `
    <button class="card tappable match-card" onclick="location.hash='#/jogo/${m.id}'">
      <div class="match-meta"><span class="match-stage">${escapeHtml(m.stage)}</span>${statusTag}</div>
      <div class="match-teams">
        <div class="match-team"><span class="flag">${m.flagA}</span><span class="name">${escapeHtml(m.teamA)}</span></div>
        <div class="match-mid">${mid}</div>
        <div class="match-team"><span class="flag">${m.flagB}</span><span class="name">${escapeHtml(m.teamB)}</span></div>
      </div>
      <div class="match-foot">
        <span>${m.status === "open" ? "As apostas fecham ao apito inicial" : m.status === "live" ? "📖 Livro aberto — vê as apostas de todos" : "Mercados liquidados"}</span>
        <span class="pot-tag">Pote 🪙 ${m.pot}</span>
      </div>
    </button>`;
}

async function renderJogos() {
  shell(loadingScreen());
  const [matches, futures] = await Promise.all([API.getMatches(), API.getFutures()]);

  const open = matches.filter((m) => m.status === "open");
  const live = matches.filter((m) => m.status === "live");
  const done = matches.filter((m) => m.status === "done");

  shell(`
    <h1 class="page-title">Jogos</h1>
    <p class="page-sub">Mundial 2026</p>

    ${live.length ? `<div class="section-label">A decorrer</div>${live.map(matchCard).join("")}` : ""}
    ${open.length ? `<div class="section-label">Próximos jogos</div>${open.map(matchCard).join("")}` : ""}
    ${!matches.length ? `<div class="empty"><span class="ico">⚽</span>Ainda não há jogos. O admin que trate disso.</div>` : ""}

    ${futures.length ? `
      <div class="section-label">👑 Longo prazo (fechadas ao 1.º apito do Mundial)</div>
      ${futures.map((f) => `
        <div class="card">
          <div class="market-title-row">
            <span class="market-title">${escapeHtml(f.name)}</span>
            <span class="market-pot">Pote 🪙 ${f.pot}</span>
          </div>
          <div class="bet-match">${f.myPick ? `A tua aposta: <strong>${escapeHtml(f.myPick)}</strong> ${f.locked ? "🔒" : ""}` : (f.locked ? "🔒 Fechado — não apostaste" : "Ainda podes apostar")}</div>
        </div>`).join("")}` : ""}

    ${done.length ? `<div class="section-label">Terminados</div>${done.map(matchCard).join("")}` : ""}
  `);
}

/* ---------- Ecrã: Detalhe do jogo + mercados ---------- */

const RISK = {
  low: { name: "Risco baixo", sub: "O pão nosso de cada dia", cls: "risk-low-bg" },
  mid: { name: "Risco médio", sub: "A roleta", cls: "risk-mid-bg" },
  high: { name: "Risco alto", sub: "O jackpot", cls: "risk-high-bg" },
};

async function renderJogoDetalhe(matchId) {
  shell(loadingScreen());
  const detail = await API.getMatchDetail(matchId);
  state.detail = detail;
  const m = detail.match;

  let body;
  if (detail.open) {
    const groups = ["low", "mid", "high"].map((risk) => {
      const list = detail.markets.filter((mk) => mk.risk === risk);
      if (!list.length) return "";
      return `
        <div class="market-group">
          <div class="risk-header">
            <span class="risk-dot ${RISK[risk].cls}"></span>
            <span class="risk-name">${RISK[risk].name}</span>
            <span class="risk-sub">· ${RISK[risk].sub}</span>
          </div>
          ${list.map((mk) => `
            <div class="card market">
              <div class="market-title-row">
                <span class="market-title">${escapeHtml(mk.name)}</span>
                <span class="market-pot">Pote 🪙 ${mk.pot}</span>
              </div>
              <div class="options ${mk.options.length === 2 ? "cols-2" : ""}">
                ${mk.options.map((o) => `
                  <button class="option-btn" data-opt="${o.id}" onclick="openSlip('${mk.id}','${o.id}', this)">
                    <span class="opt-label">${escapeHtml(o.label)}</span>
                    <span class="opt-pool">🪙 ${o.pool} no pote</span>
                  </button>`).join("")}
              </div>
            </div>`).join("")}
        </div>`;
    }).join("");

    body = `
      <div class="callout"><span class="ico">🤫</span>
        <span>As apostas são <strong>secretas</strong> até ao apito inicial. Depois o livro abre e toda a malta vê onde puseste as fichas.</span>
      </div>
      ${detail.markets.length ? groups : `<div class="empty"><span class="ico">🃏</span>Sem mercados para este jogo.</div>`}`;
  } else {
    body = `
      <div class="callout warn"><span class="ico">📖</span>
        <span><strong>Livro aberto!</strong> O jogo começou — apostas reveladas. Que comece a picardia.</span>
      </div>
      <div class="card">
        ${detail.reveal.length ? detail.reveal.map((r) => `
          <div class="reveal-row">
            <span class="lb-avatar" style="width:32px;height:32px;font-size:1rem">${r.avatar}</span>
            <span class="reveal-who">${escapeHtml(r.who)}</span>
            <span class="reveal-pick">${escapeHtml(r.pick)}</span>
            <span class="reveal-stake">🪙 ${r.stake}</span>
          </div>`).join("") : `<div class="empty"><span class="ico">🦗</span>Ninguém apostou neste jogo.</div>`}
      </div>`;
  }

  shell(`
    <button class="back-btn" onclick="location.hash='#/jogos'">← Jogos</button>
    ${matchCard(m)}
    ${body}
  `);
}

/* ---------- Boletim (bet slip) ---------- */

function openSlip(marketId, optionId, btn) {
  const detail = state.detail;
  if (!detail) return;
  const mk = detail.markets.find((x) => String(x.id) === String(marketId));
  const opt = mk?.options.find((o) => String(o.id) === String(optionId));
  if (!mk || !opt) return;

  document.querySelectorAll(".option-btn.selected").forEach((b) => b.classList.remove("selected"));
  if (btn) btn.classList.add("selected");

  state.slip = {
    marketId, optionId,
    matchLabel: `${detail.match.flagA} ${detail.match.teamA} vs ${detail.match.teamB} ${detail.match.flagB}`,
    marketName: mk.name,
    optionLabel: opt.label,
    potTotal: mk.pot,
    optionPool: opt.pool,
    stake: 25,
  };
  drawSlip();
}

function projection(s) {
  // pool betting: quota do pote total pela fatia da opção (SPECS §6)
  const newPool = s.optionPool + s.stake;
  const newTotal = s.potTotal + s.stake;
  if (newPool <= 0) return s.stake;
  return Math.round(newTotal * (s.stake / newPool));
}

function drawSlip() {
  const s = state.slip;
  if (!s) return;
  const el = $("#slip");
  const maxChips = state.profile?.chips ?? 0;
  el.innerHTML = `
    <div class="slip-inner">
      <div class="slip-row">
        <div>
          <div class="slip-market">${escapeHtml(s.matchLabel)} · ${escapeHtml(s.marketName)}</div>
          <div class="slip-pick">${escapeHtml(s.optionLabel)}</div>
        </div>
        <button class="slip-close" onclick="closeSlip()">✕</button>
      </div>
      <div class="stake-row">
        ${[10, 25, 50, 100].map((v) => `
          <button class="stake-chip ${s.stake === v ? "selected" : ""}" ${v > maxChips ? "disabled" : ""} onclick="setStake(${v})">🪙 ${v}</button>`).join("")}
      </div>
      <div class="slip-projection">
        <span>Se acertares (pote atual)</span>
        <strong>≈ 🪙 ${projection(s)}</strong>
      </div>
      <button class="btn-primary" ${s.stake > maxChips ? "disabled" : ""} onclick="confirmBet()">Confirmar aposta 🤫</button>
    </div>`;
  el.classList.add("visible");
}

function setStake(v) { if (state.slip) { state.slip.stake = v; drawSlip(); } }

function closeSlip() {
  const el = $("#slip");
  if (el) el.classList.remove("visible");
  document.querySelectorAll(".option-btn.selected").forEach((b) => b.classList.remove("selected"));
  state.slip = null;
}

async function confirmBet() {
  const s = state.slip;
  if (!s) return;
  const btn = document.querySelector(".slip-inner .btn-primary");
  if (btn) { btn.disabled = true; btn.textContent = "A registar…"; }
  try {
    await API.placeBet(s.marketId, s.optionId, s.stake);
    const matchId = state.detail.match.id;
    closeSlip();
    toast(`Aposta registada: ${s.optionLabel} · 🪙 ${s.stake} 🤐`);
    state.profile = await API.getMyProfile();
    await renderJogoDetalhe(matchId);
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = "Confirmar aposta 🤫"; }
    toast(`❌ ${e.message}`);
  }
}

function toast(msg) {
  const t = $("#toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2800);
}

/* ---------- Ecrã: As minhas apostas ---------- */

async function renderApostas() {
  shell(loadingScreen());
  const { pending, settled } = await API.getMyBets();

  const row = (b) => `
    <div class="bet-row">
      <div class="bet-info">
        <div class="bet-match">${escapeHtml(b.match)}</div>
        <div class="bet-pick">${escapeHtml(b.pick)}</div>
        ${b.secret ? `<span class="bet-secret">🤫 Secreta até ao apito inicial</span>` : ""}
      </div>
      <div class="bet-stake">
        🪙 ${b.stake}
        ${b.status === "won" ? `<span class="bet-result won">Ganhou +🪙 ${b.payout}</span>` :
          b.status === "lost" ? `<span class="bet-result lost">Perdeu</span>` :
          `<span class="bet-result pending">Em jogo</span>`}
      </div>
    </div>`;

  shell(`
    <h1 class="page-title">As minhas apostas</h1>
    <p class="page-sub">Fichas em jogo: 🪙 ${pending.reduce((a, b) => a + b.stake, 0)}</p>
    <div class="section-label">Em jogo</div>
    ${pending.length ? pending.map(row).join("") : `<div class="empty"><span class="ico">🎟️</span>Nada em jogo. Cobarde?</div>`}
    <div class="section-label">Histórico</div>
    ${settled.length ? settled.map(row).join("") : `<div class="empty"><span class="ico">📜</span>Ainda sem histórico.</div>`}
  `);
}

/* ---------- Ecrã: Classificação ---------- */

async function renderClassificacao() {
  shell(loadingScreen());
  const players = await API.getLeaderboard();

  shell(`
    <h1 class="page-title">Classificação</h1>
    <p class="page-sub">Quem manda na tabela e quem está na penúria</p>
    ${players.length ? players.map((p, i) => `
      <div class="lb-row ${i === 0 ? "king" : ""} ${p.isMe ? "me" : ""}">
        <span class="lb-rank">${i === 0 ? "👑" : i + 1}</span>
        <span class="lb-avatar">${p.avatar}</span>
        <div class="lb-info">
          <div class="lb-name">${escapeHtml(p.name)}${p.isMe ? " (tu)" : ""}</div>
          <div class="lb-badges">${p.badges.length ? p.badges.map(escapeHtml).join(" · ") : "—"}</div>
        </div>
        <div class="lb-chips">
          <span class="amount">🪙 ${p.chips.toLocaleString("pt-PT")}</span>
          <span class="delta ${p.delta >= 0 ? "delta-up" : "delta-down"}">${p.delta >= 0 ? "▲" : "▼"} ${Math.abs(p.delta)} recente</span>
        </div>
      </div>`).join("") : `<div class="empty"><span class="ico">🏆</span>Ainda sem jogadores na mesa.</div>`}
  `);
}

/* ---------- Ecrã: Perfil ---------- */

async function renderPerfil() {
  shell(loadingScreen());
  const me = state.profile;
  const stats = await API.getProfileStats();
  const canBailout = me.chips < 5; // limiar mínimo; o servidor valida a sério

  shell(`
    <div class="profile-head">
      <div class="profile-avatar">${me.avatar}</div>
      <div>
        <div class="profile-name">${escapeHtml(me.name)}</div>
        <div class="profile-email">${escapeHtml(me.email)}</div>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat-tile"><div class="val">🪙 ${me.chips.toLocaleString("pt-PT")}</div><div class="lbl">Fichas</div></div>
      <div class="stat-tile"><div class="val">${stats.won}/${stats.total}</div><div class="lbl">Acertos</div></div>
      <div class="stat-tile"><div class="val">${stats.winRate}</div><div class="lbl">Taxa</div></div>
    </div>

    <div class="section-label">Mural de títulos</div>
    <div class="card">
      ${me.badges && me.badges.length
        ? me.badges.map((b) => `<span class="badge ${b.includes("FMI") ? "shame" : b.includes("Rei") ? "gold" : ""}">${escapeHtml(b)}</span>`).join("")
        : `<span style="font-size:0.85rem;color:var(--text-faint)">Ainda sem títulos. Joga mais.</span>`}
    </div>

    <div class="section-label">Como funciona</div>
    <div class="card">
      <ol class="rules">
        <li><span class="n">1</span><span class="t">Cada jogo tem mercados (ex.: <strong>Resultado 1X2</strong>). Escolhes uma opção e apostas fichas <strong>antes do apito inicial</strong>.</span></li>
        <li><span class="n">2</span><span class="t">As apostas de todos vão para um <strong>pote</strong>. São secretas até ao jogo começar — depois o livro abre.</span></li>
        <li><span class="n">3</span><span class="t">No fim, quem acertou <strong>divide o pote</strong> na proporção do que apostou. Ninguém acerta → devolve-se tudo.</span></li>
        <li><span class="n">4</span><span class="t">Sem fichas? Pede um <strong>bailout</strong> aqui em baixo (com direito ao badge da vergonha 💸).</span></li>
      </ol>
    </div>

    <div class="section-label">Zona de emergência</div>
    <div class="card">
      <p style="font-size:0.85rem;color:var(--text-dim);margin-bottom:12px">
        Sem fichas? Pede um resgate ao Administrador. Atenção: ficas com o badge
        <strong>💸 Financiado pelo FMI</strong> até ao fim do Mundial. Sem vergonha não há jogo.
      </p>
      <button class="btn-danger-outline" ${canBailout ? "" : `disabled style="opacity:.5"`} onclick="doBailout()">
        ${canBailout ? "Pedir Bailout 🆘" : "Bailout (só quando estiveres teso)"}
      </button>
    </div>

    ${me.isAdmin ? `
      <div class="section-label">Administração</div>
      <button class="btn-secondary" style="margin-bottom:10px" onclick="location.hash='#/admin'">🎛️ Painel de Admin</button>` : ""}

    <button class="btn-secondary" style="border-color:transparent;color:var(--text-faint)" onclick="doLogout()">Terminar sessão</button>
  `);
}

async function doBailout() {
  try {
    await API.requestBailout("Perdi tudo… manda lá fichas 🙏");
    toast("Pedido de bailout enviado ao Admin 💸");
  } catch (e) { toast(`❌ ${e.message}`); }
}

/* ---------- Ecrã: Admin ---------- */

async function renderAdmin() {
  if (!state.profile?.isAdmin) { location.hash = "#/perfil"; return; }
  shell(loadingScreen());
  const [pending, bailouts, toSettle] = await Promise.all([
    API.getPendingPlayers(), API.getBailouts(), API.getMatchesToSettle(),
  ]);

  shell(`
    <button class="back-btn" onclick="location.hash='#/perfil'">← Perfil</button>
    <h1 class="page-title">🎛️ Painel de Admin</h1>
    <p class="page-sub">Gerir o Bet4Fun sem sujar as mãos</p>

    <div class="section-label">Jogadores por aprovar</div>
    ${pending.length ? pending.map((p) => `
      <div class="card admin-item">
        <span class="lb-avatar">${p.avatar}</span>
        <div class="desc"><div class="t">${escapeHtml(p.who)}</div><div class="s">Quer entrar no grupo</div></div>
        <button class="btn-small" onclick="approvePlayer('${escapeAttr(p.id)}')">Aprovar</button>
      </div>`).join("") : `<div class="empty" style="padding:20px"><span class="ico">✅</span>Ninguém à espera.</div>`}

    <div class="section-label">Pedidos de bailout</div>
    ${bailouts.length ? bailouts.map((b) => `
      <div class="card admin-item">
        <span class="lb-avatar">${b.avatar}</span>
        <div class="desc"><div class="t">${escapeHtml(b.who)}</div><div class="s">"${escapeHtml(b.note)}"</div></div>
        <button class="btn-small" onclick="approveBailout('${escapeAttr(b.id)}','${escapeAttr(b.who)}')">Aprovar</button>
      </div>`).join("") : `<div class="empty" style="padding:20px"><span class="ico">💸</span>Sem pedidos de resgate.</div>`}

    <div class="section-label">Liquidar mercados</div>
    ${toSettle.length ? toSettle.map((s) => `
      <div class="card admin-item">
        <div class="desc"><div class="t">${escapeHtml(s.match)}</div><div class="s">${escapeHtml(s.detail)}</div></div>
        <button class="btn-small outline" onclick="location.hash='#/settle/${s.id}'">Liquidar</button>
      </div>`).join("") : `<div class="empty" style="padding:20px"><span class="ico">🧾</span>Nada por liquidar.</div>`}

    <div class="section-label">Gestão</div>
    <div class="card admin-item">
      <div class="desc"><div class="t">Criar jogo / mercados</div><div class="s">Gera automaticamente o pacote de mercados por nível de risco</div></div>
      <button class="btn-small outline" onclick="location.hash='#/criar'">Criar</button>
    </div>
  `);
}

async function approvePlayer(id) {
  try { await API.approvePlayer(id); toast("Jogador aprovado — fichas entregues 🪙"); await renderAdmin(); }
  catch (e) { toast(`❌ ${e.message}`); }
}

async function approveBailout(id, who) {
  try { await API.approveBailout(id); toast(`Bailout aprovado. ${who} ficou marcado 💸`); await renderAdmin(); }
  catch (e) { toast(`❌ ${e.message}`); }
}

/* ---------- Ecrã: Liquidação de um jogo (admin) ---------- */

async function renderSettle(matchId) {
  if (!state.profile?.isAdmin) { location.hash = "#/perfil"; return; }
  shell(loadingScreen());
  const { match, markets } = await API.getSettleForm(matchId);

  const scoreKnown = match.scoreA != null && match.scoreB != null;
  const marketCard = (mk) => `
    <div class="card">
      <div class="market-title-row">
        <span class="market-title">${escapeHtml(mk.name)}</span>
        <span class="market-pot" style="color:var(--text-faint)">${settleStatusLabel(mk.status)}</span>
      </div>
      ${mk.status === "settled" || mk.status === "void" ? "" : `
        <div class="options ${mk.options.length === 2 ? "cols-2" : ""}">
          ${mk.options.map((o) => `
            <button class="option-btn ${mk.winningOptionId === o.id ? "selected" : ""}" onclick="pickWinner('${matchId}','${mk.id}','${o.id}')">
              <span class="opt-label">${escapeHtml(o.label)}</span>
            </button>`).join("")}
        </div>
        <button class="btn-small outline" style="margin-top:10px" onclick="voidMarket('${matchId}','${mk.id}')">Anular (reembolso)</button>`}
    </div>`;

  shell(`
    <button class="back-btn" onclick="location.hash='#/admin'">← Admin</button>
    <h1 class="page-title">Liquidar jogo</h1>
    <p class="page-sub">${match.flagA} ${escapeHtml(match.teamA)} vs ${escapeHtml(match.teamB)} ${match.flagB}</p>

    <div class="card">
      <div class="section-label" style="margin-top:0">Resultado (90 min)</div>
      <div style="display:flex;align-items:center;gap:10px;justify-content:center">
        <input id="scoreA" type="number" min="0" inputmode="numeric" value="${match.scoreA ?? ""}" style="width:64px;text-align:center;font-size:1.3rem;font-weight:800;padding:10px;background:var(--bg-elev);border:1px solid var(--border);border-radius:10px;color:var(--text)">
        <span style="font-weight:800">–</span>
        <input id="scoreB" type="number" min="0" inputmode="numeric" value="${match.scoreB ?? ""}" style="width:64px;text-align:center;font-size:1.3rem;font-weight:800;padding:10px;background:var(--bg-elev);border:1px solid var(--border);border-radius:10px;color:var(--text)">
      </div>
      <button class="btn-primary" style="margin-top:12px" onclick="saveScore('${matchId}')">Guardar resultado</button>
    </div>

    <div class="callout"><span class="ico">🏁</span>
      <span>${scoreKnown ? "Toca na opção <strong>vencedora</strong> de cada mercado para liquidar (paga o pote proporcionalmente ao stake)." : "Introduz e guarda o resultado primeiro. Depois liquida cada mercado."}</span>
    </div>

    ${markets.length ? markets.map(marketCard).join("") : `<div class="empty"><span class="ico">🃏</span>Sem mercados.</div>`}
  `);
}

function settleStatusLabel(s) {
  return s === "settled" ? "✅ Liquidado" : s === "void" ? "🚫 Anulado" : "Por liquidar";
}

async function saveScore(matchId) {
  const a = $("#scoreA").value, b = $("#scoreB").value;
  if (a === "" || b === "") { toast("Preenche o resultado."); return; }
  try { await API.setMatchScore(matchId, a, b); toast("Resultado guardado 🏁"); await renderSettle(matchId); }
  catch (e) { toast(`❌ ${e.message}`); }
}

async function pickWinner(matchId, marketId, optionId) {
  try { await API.settleMarket(marketId, optionId); toast("Mercado liquidado — potes pagos 🪙"); await renderSettle(matchId); }
  catch (e) { toast(`❌ ${e.message}`); }
}

async function voidMarket(matchId, marketId) {
  try { await API.voidMarket(marketId); toast("Mercado anulado — apostas reembolsadas ↩️"); await renderSettle(matchId); }
  catch (e) { toast(`❌ ${e.message}`); }
}

/* ---------- Ecrã: Criar jogo (admin) ---------- */

async function renderCriarJogo() {
  if (!state.profile?.isAdmin) { location.hash = "#/perfil"; return; }
  const inp = (id, ph, val = "") =>
    `<input id="${id}" placeholder="${ph}" value="${val}" style="width:100%;padding:12px;background:var(--bg-elev);border:1px solid var(--border);border-radius:10px;color:var(--text);margin-bottom:10px">`;
  shell(`
    <button class="back-btn" onclick="location.hash='#/admin'">← Admin</button>
    <h1 class="page-title">Criar jogo</h1>
    <p class="page-sub">Abre só os mercados essenciais: 1X2, Mais/Menos 2.5 e Resultado exato</p>
    <div class="card">
      ${inp("nStage", "Fase (ex: Fase de grupos)", "Fase de grupos")}
      <div style="display:flex;gap:10px">
        ${inp("nFlagA", "🇵🇹")}${inp("nTeamA", "Equipa A")}
      </div>
      <div style="display:flex;gap:10px">
        ${inp("nFlagB", "🇲🇽")}${inp("nTeamB", "Equipa B")}
      </div>
      ${inp("nKickoff", "Kickoff (2026-06-11T20:00)")}
      <label style="display:flex;align-items:center;gap:8px;font-size:0.9rem;color:var(--text-dim);margin-bottom:14px">
        <input id="nKnockout" type="checkbox"> Jogo a eliminar (adiciona mercado "Decisão por penáltis")
      </label>
      <button class="btn-primary" onclick="submitCreateMatch()">Criar jogo + mercados</button>
    </div>
  `);
}

async function submitCreateMatch() {
  const g = (id) => $(id).value.trim();
  const payload = {
    stage: g("#nStage"), teamA: g("#nTeamA"), flagA: g("#nFlagA"),
    teamB: g("#nTeamB"), flagB: g("#nFlagB"),
    kickoffAt: g("#nKickoff"), knockout: $("#nKnockout").checked,
  };
  if (!payload.teamA || !payload.teamB || !payload.kickoffAt) { toast("Preenche equipas e kickoff."); return; }
  try {
    const d = new Date(payload.kickoffAt); // aceita 'YYYY-MM-DDTHH:MM' local
    if (!isNaN(d)) payload.kickoffAt = d.toISOString();
    await API.createMatch(payload);
    toast("Jogo criado 🎉");
    location.hash = "#/admin";
  } catch (e) { toast(`❌ ${e.message}`); }
}

/* ---------- Utilitários ---------- */

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(str) { return escapeHtml(str).replace(/'/g, "\\'"); }

/* ---------- Ecrã: falta configurar o Supabase ---------- */

function renderSetup() {
  $("#app").innerHTML = `
    <div class="login">
      <div class="big-logo">🔌</div>
      <h1>Falta ligar o Supabase</h1>
      <p class="tagline">Preenche o <code style="font-family:ui-monospace,Menlo,monospace">SUPABASE_URL</code> e a <code style="font-family:ui-monospace,Menlo,monospace">SUPABASE_ANON_KEY</code> em <strong>js/config.js</strong> com os dados do teu projeto (Project Settings → API). Ver <strong>db/README.md</strong>.</p>
    </div>`;
}

/* ---------- Arranque + PWA ---------- */

async function boot() {
  if (!IS_CONFIGURED) { renderSetup(); return; }
  try {
    state.session = await API.getSession();
    if (state.session) {
      await API.ensureProfile();               // inscreve no 1.º acesso
      state.profile = await API.getMyProfile();
    }
  } catch (e) { renderError(e); return; }

  API.onAuthChange(async (session) => {
    state.session = session;
    state.profile = session
      ? await API.ensureProfile().then(() => API.getMyProfile()).catch(() => null)
      : null;
    await navigate();
  });

  await navigate();
}

boot();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

/* ---------- Expor handlers usados por onclick inline ---------- */
Object.assign(window, {
  doLogin, doLogout, refreshPending,
  openSlip, closeSlip, setStake, confirmBet,
  doBailout,
  approvePlayer, approveBailout,
  saveScore, pickWinner, voidMarket,
  submitCreateMatch,
});
