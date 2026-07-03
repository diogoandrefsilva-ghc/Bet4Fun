/* ============================================================
   Bet4Fun — app (router + ecrãs)
   ------------------------------------------------------------
   Ligado ao Supabase via js/api.js. Cada render*() busca dados
   reais. As funções chamadas por onclick inline são expostas em
   window no fim do ficheiro (este módulo é ESM).
   ============================================================ */

import { API } from "./api.js";
import { IS_CONFIGURED } from "./config.js";
import { fetchEspnEvents, computeSettlement, computeLiveMarkers, teamPt, teamFlag, pairKey } from "./espn.js";

const $ = (sel) => document.querySelector(sel);

const state = {
  session: null,
  profile: null,
  slip: null,     // { marketId, optionId, matchLabel, marketName, optionLabel, potTotal, stake }
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
  settle: renderEditarJogo,   // alias: liquidação vive agora no ecrã de edição
  criar: renderCriarJogo,
  editar: renderEditarJogo,
  mercados: renderMercadosDefeito,
  espn: renderEspn,
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
  $(".main")?.scrollTo(0, 0);
  window.scrollTo(0, 0);
}

window.addEventListener("hashchange", navigate);

function updateTabs(route) {
  const map = {
    jogos: "jogos", jogo: "jogos", apostas: "apostas",
    classificacao: "classificacao", perfil: "perfil",
    admin: "perfil", settle: "perfil", criar: "perfil", editar: "perfil", mercados: "perfil", espn: "perfil",
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
          <button class="tab" data-tab="perfil" onclick="location.hash='#/perfil'"><span class="icon">👤</span>Perfil</button>
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
        <div class="match-mid" id="mid-${m.id}">${mid}</div>
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

  if (live.length) patchListLiveScores(live);
}

/* ---------- Resultado ao vivo (ESPN) ---------- */

// cache curto para não martelar o ESPN entre lista e detalhe
let _espnCache = { at: 0, games: null };
async function espnGames() {
  if (_espnCache.games && Date.now() - _espnCache.at < 60000) return _espnCache.games;
  const games = await fetchEspnEvents([]);
  _espnCache = { at: Date.now(), games };
  return games;
}

function findEspnGame(games, teamA, teamB) {
  const key = pairKey(teamA, teamB);
  return (games || []).find((g) => pairKey(teamPt(g.teamAEn), teamPt(g.teamBEn)) === key) || null;
}

// score do ESPN orientado às nossas equipas (PT)
function espnScoreFor(g, teamA, teamB) {
  if (g.scoreA == null || g.scoreB == null) return null;
  const pt = {};
  pt[teamPt(g.teamAEn)] = g.scoreA;
  pt[teamPt(g.teamBEn)] = g.scoreB;
  const a = pt[teamA], b = pt[teamB];
  return (a == null || b == null) ? null : { a, b };
}

async function patchListLiveScores(liveMatches) {
  let games;
  try { games = await espnGames(); } catch { return; }
  liveMatches.forEach((m) => {
    const g = findEspnGame(games, m.teamA, m.teamB);
    const sc = g && espnScoreFor(g, m.teamA, m.teamB);
    if (!sc) return;
    const mid = document.getElementById(`mid-${m.id}`);
    if (mid) mid.innerHTML = `<span class="score">${sc.a} – ${sc.b}</span><span class="time">Ao vivo</span>`;
  });
}

/* ---------- Ecrã: Detalhe do jogo + mercados ---------- */

const RISK = {
  low: { name: "Risco baixo", sub: "O pão nosso de cada dia", cls: "risk-low-bg" },
  mid: { name: "Risco médio", sub: "A roleta", cls: "risk-mid-bg" },
  high: { name: "Risco alto", sub: "O jackpot", cls: "risk-high-bg" },
};

/* Nota explicativa por mercado sobre a regra de liquidação.
   `knockout` = jogo a eliminar (pode ir a prolongamento/penáltis). */
function marketNote(name, knockout) {
  const n = name || "";
  if (n.startsWith("Decisão por penáltis")) return "Conta se o jogo se decidir nas grandes penalidades.";
  if (n.startsWith("Resultado (1X2)") || n.startsWith("Mais/Menos") ||
      n.startsWith("Resultado exato") || n.startsWith("Ambas marcam") ||
      n.startsWith("1.ª equipa a marcar")) {
    return knockout
      ? "Conta o resultado ao fim dos 120' (prolongamento incl., exclui penáltis)."
      : "Conta o resultado ao fim do jogo (90').";
  }
  return null;
}

async function renderJogoDetalhe(matchId, opts = {}) {
  if (!opts.keepUnlock) state.detailUnlocked = new Set();
  shell(loadingScreen());
  const detail = await API.getMatchDetail(matchId);
  state.detail = detail;
  const m = detail.match;
  // open = apostas abertas · live = livro aberto (a decorrer) · done = terminado
  const phase = detail.open ? "open" : (m.status === "done" ? "done" : "live");
  // jogo a eliminar → há mercado "Decisão por penáltis" (conta prolongamento)
  const knockout = detail.markets.some((mk) => mk.name.startsWith("Decisão por penáltis"));

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
        ${list.map((mk) => marketCardHtml(mk, phase, knockout)).join("")}
      </div>`;
  }).join("");

  const banner =
    phase === "open" ? `
      <div class="callout"><span class="ico">🤫</span>
        <span>As apostas são <strong>secretas</strong> até ao apito inicial — só se vê o <strong>total do pote</strong> de cada mercado. Depois o livro abre e toda a malta vê onde puseste as fichas.</span>
      </div>` :
    phase === "live" ? `
      <div id="live-banner"></div>
      <div class="callout warn"><span class="ico">📖</span>
        <span><strong>Livro aberto!</strong> O jogo começou. Toca em cada opção para ver <strong>quem lá pôs fichas</strong>.</span>
      </div>` : `
      <div class="callout"><span class="ico">🏁</span>
        <span><strong>Jogo terminado.</strong> Toca numa opção para ver quem apostou. A marca <strong>✓ certa</strong> assinala a opção vencedora.</span>
      </div>`;

  shell(`
    <button class="back-btn" onclick="location.hash='#/jogos'">← Jogos</button>
    ${matchCard(m)}
    ${banner}
    ${detail.markets.length ? groups : `<div class="empty"><span class="ico">🃏</span>Sem mercados para este jogo.</div>`}
    ${phase !== "open" ? expiriesSection(detail) : ""}
  `);

  if (phase === "live") patchLive(m);
}

/* Secção "Fichas expiradas": a aposta mínima obrigatória por jogo (o resto
   expira). Depois do apito mostra quem ficou abaixo do mínimo — projetado
   enquanto o jogo não liquida, real (já debitado) depois de liquidar. */
function expiriesSection(detail) {
  const min = detail.minMatchStake || 0;
  if (!min) return "";
  const list = detail.expiries || [];
  const body = list.length
    ? list.map((e) => `
        <div class="reveal-line">
          <span class="lb-avatar sm">${e.avatar}</span>
          <span class="rl-who">${escapeHtml(e.who)}</span>
          <span class="rl-stake">apostou 🪙 ${e.staked}</span>
          <span class="rl-result lost">${e.expired ? "expirou" : "vai expirar"} 🪙 ${e.amount}</span>
        </div>`).join("")
    : `<div class="reveal-empty">Toda a gente cumpriu o mínimo de 🪙 ${min} 🎯</div>`;
  return `
    <div class="market-group">
      <div class="risk-header">
        <span class="risk-dot" style="background:var(--loss)"></span>
        <span class="risk-name">Fichas expiradas</span>
        <span class="risk-sub">· mínimo 🪙 ${min} por jogo</span>
      </div>
      <div class="card">
        <div class="market-note" style="margin-top:0">ℹ️ Quem não apostar pelo menos 🪙 ${min} neste jogo perde o que faltar — para ninguém adormecer no topo da tabela.</div>
        ${body}
      </div>
    </div>`;
}

/* Um cartão de mercado. Comportamento depende da fase:
   - open  : botões para apostar (ou bloqueado se já apostei)
   - live  : opções em modo revelação (tap → quem apostou) + marca "a ganhar"
   - done  : idem, com a opção vencedora marcada */
function marketCardHtml(mk, phase, knockout) {
  const note = marketNote(mk.name, knockout);
  const noteHtml = note ? `<div class="market-note">ℹ️ ${escapeHtml(note)}</div>` : "";
  if (phase === "open") {
    const locked = mk.mine && !state.detailUnlocked.has(String(mk.id));
    return `
      <div class="card market ${locked ? "is-locked" : ""}">
        <div class="market-title-row">
          <span class="market-title">${escapeHtml(mk.name)}</span>
          <span class="market-pot">Pote 🪙 ${mk.pot}</span>
        </div>
        ${noteHtml}
        <div class="options ${mk.options.length === 2 ? "cols-2" : ""}">
          ${mk.options.map((o) => {
            // Antes do apito só se mostra o pote total do mercado — as pools
            // por opção (tendências da malta) só se revelam com o livro aberto.
            const isMine = mk.mine && String(mk.mine.optionId) === String(o.id);
            if (locked) {
              return `
                <div class="option-btn ${isMine ? "opt-mine" : "is-dim"}">
                  ${isMine ? `<span class="opt-tags"><span class="opt-tag tag-mine">a tua</span></span>` : ""}
                  <span class="opt-label">${escapeHtml(o.label)}</span>
                </div>`;
            }
            return `
              <button class="option-btn ${isMine ? "selected" : ""}" data-opt="${o.id}" onclick="openSlip('${mk.id}','${o.id}', this)">
                <span class="opt-label">${escapeHtml(o.label)}</span>
              </button>`;
          }).join("")}
        </div>
        ${locked ? `
          <div class="market-locked-foot">
            <span>🎯 Apostaste <strong>🪙 ${mk.mine.stake}</strong> · palpite trancado</span>
            <button class="link-btn" onclick="trocarPalpite('${mk.id}')">Trocar</button>
          </div>` : ""}
      </div>`;
  }

  // fases live / done → modo revelação
  return `
    <div class="card market">
      <div class="market-title-row">
        <span class="market-title">${escapeHtml(mk.name)}</span>
        <span class="market-pot">Pote 🪙 ${mk.pot}</span>
      </div>
      ${noteHtml}
      <div class="options ${mk.options.length === 2 ? "cols-2" : ""}">
        ${mk.options.map((o) => {
          const isMine = mk.mine && String(mk.mine.optionId) === String(o.id);
          const isWinner = phase === "done" && String(mk.winnerOptionId ?? "") === String(o.id);
          const n = ((state.detail.book || {})[`${mk.id}:${o.id}`] || []).length;
          const cls = [isMine && "opt-mine", isWinner && "opt-winner"].filter(Boolean).join(" ");
          return `
            <button class="option-btn reveal-opt ${cls}" data-mk="${mk.id}" data-opt="${o.id}"
              onclick="toggleReveal('${mk.id}','${o.id}', this)">
              <span class="opt-tags">
                ${isWinner ? `<span class="opt-tag tag-win">✓ certa</span>` : ""}
                ${isMine ? `<span class="opt-tag tag-mine">a tua</span>` : ""}
              </span>
              <span class="opt-label">${escapeHtml(o.label)}</span>
              <span class="opt-pool">🪙 ${o.pool} · ${n} 👤</span>
            </button>`;
        }).join("")}
      </div>
      <div class="reveal-panel" id="reveal-${mk.id}"></div>
    </div>`;
}

/* Revela quem apostou numa opção (livro aberto). Toggle: 2.º toque fecha. */
function toggleReveal(marketId, optionId, btn) {
  const panel = document.getElementById(`reveal-${marketId}`);
  if (!panel) return;
  const card = panel.closest(".card");
  const list = ((state.detail.book || {})[`${marketId}:${optionId}`]) || [];
  const isOpenSame = panel.classList.contains("open") && panel.dataset.opt === String(optionId);

  card.querySelectorAll(".reveal-opt.active").forEach((b) => b.classList.remove("active"));
  if (isOpenSame) {
    panel.classList.remove("open");
    panel.dataset.opt = "";
    panel.innerHTML = "";
    return;
  }
  if (btn) btn.classList.add("active");
  panel.dataset.opt = String(optionId);
  panel.innerHTML = list.length
    ? list.map((r) => `
        <div class="reveal-line">
          <span class="lb-avatar sm">${r.avatar}</span>
          <span class="rl-who">${escapeHtml(r.who)}</span>
          <span class="rl-stake">🪙 ${r.stake}</span>
          ${revealResult(r.result)}
        </div>`).join("")
    : `<div class="reveal-empty">Ninguém apostou nesta opção 🦗</div>`;
  panel.classList.add("open");
}

/* Etiqueta do resultado de um apostador num mercado já liquidado. */
function revealResult(res) {
  if (!res) return "";
  if (res.kind === "won") return `<span class="rl-result won">ganhou +🪙 ${res.amount}</span>`;
  if (res.kind === "refund") return `<span class="rl-result">↩️ reembolso</span>`;
  if (res.kind === "lost") return `<span class="rl-result lost">perdeu</span>`;
  return "";
}

/* Desbloqueia um mercado já apostado para trocar o palpite (antes do apito). */
function trocarPalpite(marketId) {
  state.detailUnlocked.add(String(marketId));
  renderJogoDetalhe(state.detail.match.id, { keepUnlock: true });
}

/* Vai ao ESPN buscar o resultado ao vivo deste jogo e marca, em cada mercado,
   a opção que iria pagar face ao resultado atual. Progressivo: corre depois
   do render e injeta no DOM (nunca bloqueia o ecrã). */
async function patchLive(m) {
  let live = null;
  try {
    const games = await espnGames();
    const g = findEspnGame(games, m.teamA, m.teamB);
    if (g) live = computeLiveMarkers(g, state.detail.markets, m.teamA, m.teamB);
  } catch { /* ESPN em baixo/bloqueado — segue sem resultado ao vivo */ }
  if (!live) return;

  if (live.score) {
    const mid = document.getElementById(`mid-${m.id}`);
    if (mid) mid.innerHTML = `<span class="score">${live.score.a} – ${live.score.b}</span><span class="time">Ao vivo</span>`;
    const banner = document.getElementById("live-banner");
    if (banner) {
      banner.innerHTML = `
        <div class="callout live"><span class="ico">🔴</span>
          <span>Resultado <strong>ao vivo</strong> (ESPN): <strong>${escapeHtml(m.teamA)} ${live.score.a}–${live.score.b} ${escapeHtml(m.teamB)}</strong>. A marca <strong>a ganhar</strong> mostra a opção vencedora face ao resultado atual.</span>
        </div>`;
    }
  }

  Object.entries(live.leaders || {}).forEach(([mkId, optId]) => {
    const btn = document.querySelector(`.reveal-opt[data-mk="${mkId}"][data-opt="${optId}"]`);
    if (!btn || btn.querySelector(".tag-leader")) return;
    btn.classList.add("opt-leader");
    const tags = btn.querySelector(".opt-tags");
    if (tags) tags.insertAdjacentHTML("afterbegin", `<span class="opt-tag tag-leader">a ganhar</span>`);
  });
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
    stake: 25,
  };
  drawSlip();
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
        <span>Pote deste mercado (com a tua aposta)</span>
        <strong>🪙 ${(s.potTotal + s.stake).toLocaleString("pt-PT")}</strong>
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

  const row = (b) => {
    const status =
      b.status === "won" ? `<span class="bet-status won">Ganhou +🪙 ${b.payout}</span>` :
      b.status === "lost" ? `<span class="bet-status lost">Perdeu</span>` :
      b.secret ? `<span class="bet-status secret">🤫 Secreta até ao apito</span>` :
      `<span class="bet-status pending">Em jogo</span>`;
    return `
    <div class="card bet-card">
      <div class="bet-match">${escapeHtml(b.match)}</div>
      <div class="bet-pick-row">
        <span class="bet-option">${escapeHtml(b.option || b.pick)}</span>
        ${b.market ? `<span class="bet-market">${escapeHtml(b.market)}</span>` : ""}
      </div>
      <div class="bet-foot">
        <span class="bet-stake">Aposta 🪙 ${b.stake}</span>
        ${status}
      </div>
    </div>`;
  };

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
    <p class="page-sub">Toca num jogador para veres o histórico e os detalhes</p>
    ${players.length ? players.map((p, i) => `
      <div class="lb-row ${i === 0 ? "king" : ""} ${p.isMe ? "me" : ""}" onclick="togglePlayerHistory('${p.id}', this)">
        <span class="lb-rank">${i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : i + 1}</span>
        <span class="lb-avatar">${p.avatar}</span>
        <div class="lb-info">
          <div class="lb-name">${escapeHtml(p.name)}${p.isMe ? " (tu)" : ""}</div>
          ${p.badges.length ? `<div class="lb-badges">${p.badges.map(escapeHtml).join(" · ")}</div>` : ""}
        </div>
        <div class="lb-chips">
          <span class="amount">🪙 ${p.chips.toLocaleString("pt-PT")}</span>
        </div>
      </div>
      <div class="lb-history" id="lbh-${p.id}" data-locked="${p.locked || 0}" data-delta="${p.delta || 0}"></div>`).join("") : `<div class="empty"><span class="ico">🏆</span>Ainda sem jogadores na mesa.</div>`}
  `);
}

/* Toca num jogador na classificação → mostra/esconde o histórico de apostas
   certas e erradas. Carrega à primeira abertura (e guarda em cache). */
async function togglePlayerHistory(pid, rowEl) {
  const panel = document.getElementById(`lbh-${pid}`);
  if (!panel) return;
  const wasOpen = panel.classList.contains("open");

  document.querySelectorAll(".lb-history.open").forEach((p) => p.classList.remove("open"));
  document.querySelectorAll(".lb-row.expanded").forEach((r) => r.classList.remove("expanded"));
  if (wasOpen) return;   // era este que estava aberto → fica fechado

  rowEl.classList.add("expanded");
  panel.classList.add("open");
  if (panel.dataset.loaded) return;

  panel.innerHTML = `<div class="reveal-empty">A carregar histórico…</div>`;
  try {
    const h = await API.getPlayerHistory(pid);
    panel.innerHTML = historyPanelHtml(h, Number(panel.dataset.locked || 0), Number(panel.dataset.delta || 0));
    panel.dataset.loaded = "1";
  } catch (e) {
    panel.innerHTML = `<div class="reveal-empty">❌ ${escapeHtml(e.message)}</div>`;
  }
}

function historyPanelHtml(h, locked = 0, delta = 0) {
  // Detalhes que saíram da linha da tabela (para ela respirar): fichas
  // cativas em apostas por liquidar e a variação recente.
  const meta = [];
  if (locked > 0) meta.push(`<span>🔒 🪙 ${locked.toLocaleString("pt-PT")} cativas em apostas por liquidar</span>`);
  if (delta) meta.push(`<span class="${delta >= 0 ? "up" : "down"}">${delta >= 0 ? "▲" : "▼"} 🪙 ${Math.abs(delta).toLocaleString("pt-PT")} recente</span>`);
  const metaHtml = meta.length ? `<div class="lbh-meta">${meta.join("")}</div>` : "";
  if (!h.items.length) return `${metaHtml}<div class="reveal-empty">Ainda sem apostas resolvidas 📜</div>`;
  const head = `${metaHtml}<div class="lbh-summary">✅ ${h.won} ${h.won === 1 ? "certa" : "certas"} · ❌ ${h.lost} ${h.lost === 1 ? "errada" : "erradas"}</div>`;
  const rows = h.items.map((it) => `
    <div class="reveal-line">
      <div class="lbh-info">
        <div class="lbh-match">${escapeHtml(it.match)}</div>
        <div class="lbh-pick">${escapeHtml(it.pick)}</div>
      </div>
      <span class="rl-stake">🪙 ${it.stake}</span>
      <span class="rl-result ${it.status === "won" ? "won" : it.status === "lost" ? "lost" : ""}">${
        it.status === "won" ? `ganhou +🪙 ${it.payout}` : it.status === "lost" ? "perdeu" : "↩️ reembolso"
      }</span>
    </div>`).join("");
  return head + rows;
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
  const [pending, bailouts, toSettle, matches] = await Promise.all([
    API.getPendingPlayers(), API.getBailouts(), API.getMatchesToSettle(), API.getMatches(),
  ]);
  // Uma só lista de jogos para gerir: os que ainda não estão fechados +
  // os que têm mercados por liquidar. Sinaliza-se quais precisam de resultado.
  const toSettleIds = new Set(toSettle.map((s) => String(s.id)));
  const games = matches.filter((m) => m.status !== "done" || toSettleIds.has(String(m.id)));

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

    <div class="section-label">Jogos — toca para gerir</div>
    ${games.length ? games.map((m) => {
      const needsSettle = toSettleIds.has(String(m.id));
      const sub = needsSettle
        ? `⚠️ resultado por liquidar${m.status === "live" ? " · a decorrer" : ""}`
        : `${m.kickoff}${m.status === "live" ? " · a decorrer" : ""}`;
      return `
      <button class="card admin-item tappable" onclick="location.hash='#/editar/${m.id}'">
        <div class="desc">
          <div class="t">${m.flagA} ${escapeHtml(m.teamA)} vs ${escapeHtml(m.teamB)} ${m.flagB}</div>
          <div class="s" ${needsSettle ? 'style="color:var(--risk-high);font-weight:700"' : ""}>${escapeHtml(sub)}</div>
        </div>
        <span class="chev">›</span>
      </button>`;
    }).join("") : `<div class="empty" style="padding:20px"><span class="ico">📅</span>Sem jogos para gerir.</div>`}

    <div class="section-label">Gestão</div>
    <div class="card admin-item">
      <div class="desc"><div class="t">⚡ Importar do ESPN</div><div class="s">Traz os jogos previstos e liquida resultados automaticamente</div></div>
      <button class="btn-small" onclick="location.hash='#/espn'">Abrir</button>
    </div>
    <div class="card admin-item">
      <div class="desc"><div class="t">Criar jogo à mão</div><div class="s">Cria um jogo com os mercados por defeito</div></div>
      <button class="btn-small outline" onclick="location.hash='#/criar'">Criar</button>
    </div>
    <div class="card admin-item">
      <div class="desc"><div class="t">🃏 Mercados por defeito</div><div class="s">Escolhe os mercados que abrem em cada jogo novo</div></div>
      <button class="btn-small outline" onclick="location.hash='#/mercados'">Configurar</button>
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

function settleStatusLabel(s) {
  return s === "settled" ? "✅ Liquidado" : s === "void" ? "🚫 Anulado" : "Por liquidar";
}

/* Guarda o estado aberto/fechado da caixa "Liquidação manual" para que os
   re-renders (guardar resultado, liquidar mercado) não a fechem. */
function settleBoxToggled(el) { state.settleOpen = el.open; }

async function saveScore(matchId) {
  const a = $("#scoreA").value, b = $("#scoreB").value;
  if (a === "" || b === "") { toast("Preenche o resultado."); return; }
  try { await API.setMatchScore(matchId, a, b); toast("Resultado guardado 🏁"); await renderEditarJogo(matchId); }
  catch (e) { toast(`❌ ${e.message}`); }
}

async function pickWinner(matchId, marketId, optionId) {
  try { await API.settleMarket(marketId, optionId); toast("Mercado liquidado — potes pagos 🪙"); await renderEditarJogo(matchId); }
  catch (e) { toast(`❌ ${e.message}`); }
}

async function voidMarket(matchId, marketId) {
  try { await API.voidMarket(marketId); toast("Mercado anulado — apostas reembolsadas ↩️"); await renderEditarJogo(matchId); }
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
    <p class="page-sub">Abre automaticamente os mercados por defeito (configuráveis no admin)</p>
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

/* ---------- Ecrã: Editar jogo + mercados (admin) ---------- */

// Catálogo de mercados que o admin pode abrir num jogo. As opções são
// geradas com os nomes das equipas quando fizer sentido.
const MARKET_CATALOG = [
  { name: "Resultado (1X2)", risk: "low", options: (a, b) => [a, "Empate", b] },
  { name: "Mais/Menos 2.5 golos", risk: "low", options: () => ["Mais 2.5", "Menos 2.5"] },
  { name: "Ambas marcam", risk: "low", options: () => ["Sim", "Não"] },
  { name: "1.ª equipa a marcar", risk: "mid", options: (a, b) => [a, b, "Sem golos"] },
  { name: "Cartão vermelho no jogo", risk: "mid", options: () => ["Sim", "Não"] },
  { name: "Resultado exato", risk: "high", options: () => [
    "0-0","1-0","0-1","1-1","2-0","0-2","2-1","1-2",
    "2-2","3-0","0-3","3-1","1-3","3-2","2-3","3-3","Outro"] },
  { name: "Decisão por penáltis", risk: "high", options: () => ["Sim", "Não"], knockoutOnly: true },
];

function toLocalInput(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function renderEditarJogo(matchId) {
  if (!state.profile?.isAdmin) { location.hash = "#/perfil"; return; }
  shell(loadingScreen());
  const { match, markets } = await API.getEditForm(matchId);

  // A caixa "Liquidação manual" lembra-se de estar aberta entre re-renders
  // (guardar resultado / liquidar um mercado voltam a desenhar o ecrã).
  if (state.settleFor !== String(matchId)) { state.settleFor = String(matchId); state.settleOpen = false; }

  const have = new Set(markets.map((mk) => mk.name));
  const missing = MARKET_CATALOG.filter((c) => !have.has(c.name));
  const scoreKnown = match.scoreA != null && match.scoreB != null;
  const started = match.status !== "open";
  const unsettled = markets.filter((mk) => mk.status !== "settled" && mk.status !== "void");

  // Cartão de mercado: só gestão (estado + remover). Liquidar vive em baixo,
  // na caixa recolhida "Liquidação manual" — em regra é o automatismo (ESPN)
  // que fecha os mercados; isto é o recurso.
  const marketCard = (mk) => {
    const done = mk.status === "settled";
    const voided = mk.status === "void";
    const winner = done ? (mk.options.find((o) => o.id === mk.winningOptionId)?.label || "?") : null;
    return `
      <div class="card market">
        <div class="market-title-row">
          <span class="market-title">
            <span class="risk-dot ${RISK[mk.risk]?.cls || "risk-mid-bg"}" style="display:inline-block;vertical-align:middle;margin-right:6px"></span>
            ${escapeHtml(mk.name)}
          </span>
          <span class="market-pot">Pote 🪙 ${mk.pot}</span>
        </div>
        <div class="market-note" style="margin:0">
          ${settleStatusLabel(mk.status)}${winner ? ` · vencedora: <strong>${escapeHtml(winner)}</strong>` : ""} · ${mk.nOptions} opções
        </div>
        ${done || voided ? "" : `
          <div class="market-locked-foot" style="justify-content:flex-end">
            <button class="btn-small outline" style="border-color:rgba(240,86,74,0.4);color:var(--risk-high)"
              onclick="adminRemoveMarket('${escapeAttr(match.id)}','${escapeAttr(mk.id)}',${mk.pot},'${escapeAttr(mk.name)}')">Remover</button>
          </div>`}
      </div>`;
  };

  // Cartão de liquidação (dentro da caixa de recurso): tocar na vencedora
  // liquida; "Anular" reembolsa toda a gente.
  const settleCard = (mk) => `
    <div class="card market">
      <div class="market-title-row">
        <span class="market-title">${escapeHtml(mk.name)}</span>
        <span class="market-pot">Pote 🪙 ${mk.pot}</span>
      </div>
      <div class="options ${mk.options.length === 2 ? "cols-2" : ""}">
        ${mk.options.map((o) => `
          <button class="option-btn" onclick="pickWinner('${escapeAttr(match.id)}','${escapeAttr(mk.id)}','${escapeAttr(o.id)}')">
            <span class="opt-label">${escapeHtml(o.label)}</span>
          </button>`).join("")}
      </div>
      <div class="market-locked-foot" style="justify-content:flex-start">
        <button class="btn-small outline" onclick="voidMarket('${escapeAttr(match.id)}','${escapeAttr(mk.id)}')">Anular (reembolso)</button>
      </div>
    </div>`;

  shell(`
    <button class="back-btn" onclick="location.hash='#/admin'">← Admin</button>
    <h1 class="page-title">Gerir jogo</h1>
    <p class="page-sub">${match.flagA} ${escapeHtml(match.teamA)} vs ${escapeHtml(match.teamB)} ${match.flagB}</p>

    ${started ? `
      <div class="callout warn"><span class="ico">⚠️</span>
        <span>Este jogo já começou. Remover ou anular mercados agora devolve as fichas apostadas.</span></div>` : ""}

    <div class="section-label">Dados do jogo</div>
    <div class="card">
      <label class="field-label" for="eStage">Fase</label>
      <input id="eStage" class="field" value="${escapeHtml(match.stage)}" placeholder="Fase de grupos">
      <label class="field-label" for="eKickoff">Data e hora do jogo (apostas fecham nesta hora)</label>
      <input id="eKickoff" class="field" type="datetime-local" value="${toLocalInput(match.kickoffAt)}">
      <button class="btn-primary" onclick="saveMatchEdit('${escapeAttr(match.id)}')">Guardar alterações</button>
    </div>

    <div class="section-label">Mercados deste jogo</div>
    ${markets.length ? markets.map(marketCard).join("") : `<div class="empty" style="padding:20px"><span class="ico">🃏</span>Sem mercados. Adiciona em baixo.</div>`}

    <div class="section-label">Adicionar mercado</div>
    ${missing.length ? missing.map((c, i) => `
      <div class="card admin-item">
        <span class="risk-dot ${RISK[c.risk].cls}" style="flex-shrink:0"></span>
        <div class="desc">
          <div class="t">${escapeHtml(c.name)}</div>
          <div class="s">${RISK[c.risk].name} · ${c.options(match.teamA, match.teamB).length} opções</div>
        </div>
        <button class="btn-small" onclick="adminAddMarket('${escapeAttr(match.id)}',${MARKET_CATALOG.indexOf(c)})">+ Abrir</button>
      </div>`).join("") : `<div class="empty" style="padding:20px"><span class="ico">✅</span>Já tens todos os mercados do catálogo.</div>`}

    <details class="settle-box" ${state.settleOpen ? "open" : ""} ontoggle="settleBoxToggled(this)">
      <summary>🧰 Liquidação manual${unsettled.length ? ` <span class="sb-badge">${unsettled.length} por liquidar</span>` : ""}</summary>
      <div class="market-note" style="margin:10px 2px">
        Em regra os resultados são liquidados <strong>automaticamente</strong> (ESPN).
        Usa isto só se o automatismo falhar ou para mercados que ele não decide.
      </div>
      <div class="card">
        <label class="field-label">Resultado ao fim do jogo (prolongamento incl., sem penáltis)</label>
        <div style="display:flex;align-items:center;gap:10px;justify-content:center;margin-bottom:4px">
          <input id="scoreA" type="number" min="0" inputmode="numeric" value="${match.scoreA ?? ""}" style="width:64px;text-align:center;font-size:1.3rem;font-weight:800;padding:10px;background:var(--bg-elev);border:1px solid var(--border);border-radius:10px;color:var(--text)">
          <span style="font-weight:800">–</span>
          <input id="scoreB" type="number" min="0" inputmode="numeric" value="${match.scoreB ?? ""}" style="width:64px;text-align:center;font-size:1.3rem;font-weight:800;padding:10px;background:var(--bg-elev);border:1px solid var(--border);border-radius:10px;color:var(--text)">
        </div>
        <button class="btn-primary" onclick="saveScore('${escapeAttr(match.id)}')">Guardar resultado</button>
        <div class="market-note" style="margin:10px 0 0">🏁 ${scoreKnown ? "Toca na opção <strong>vencedora</strong> de cada mercado para o liquidar (paga o pote proporcionalmente ao stake)." : "Guarda o resultado primeiro; depois liquida cada mercado tocando na opção vencedora."}</div>
      </div>
      ${unsettled.length ? unsettled.map(settleCard).join("") : `<div class="empty" style="padding:16px"><span class="ico">✅</span>Nada por liquidar neste jogo.</div>`}
    </details>

    <div class="section-label">Zona perigosa</div>
    <div class="card">
      <p style="font-size:0.82rem;color:var(--text-dim);margin-bottom:12px">
        Apagar o jogo remove-o de vez, com todos os mercados. As fichas apostadas
        em mercados por liquidar são devolvidas aos jogadores.
      </p>
      <button class="btn-danger-outline" onclick="adminRemoveMatch('${escapeAttr(match.id)}','${escapeAttr(`${match.teamA} vs ${match.teamB}`)}')">Apagar jogo 🗑️</button>
    </div>
  `);
}

async function adminRemoveMatch(matchId, label) {
  if (!confirm(`Apagar "${label}"? Isto remove o jogo e todos os mercados. As apostas por liquidar são devolvidas.`)) return;
  try {
    await API.removeMatch(matchId);
    toast("Jogo apagado 🗑️");
    location.hash = "#/admin";
  } catch (e) { toast(`❌ ${e.message}`); }
}

async function saveMatchEdit(matchId) {
  const stage = $("#eStage").value.trim();
  const kick = $("#eKickoff").value;
  if (!kick) { toast("Preenche a data e hora."); return; }
  const d = new Date(kick);
  if (isNaN(d)) { toast("Data inválida."); return; }
  try {
    await API.updateMatch(matchId, stage, d.toISOString());
    toast("Jogo atualizado 📅");
    await renderEditarJogo(matchId);
  } catch (e) { toast(`❌ ${e.message}`); }
}

async function adminAddMarket(matchId, catalogIdx) {
  const c = MARKET_CATALOG[catalogIdx];
  if (!c) return;
  try {
    const { match } = await API.getEditForm(matchId);
    await API.addMarket(matchId, c.name, c.risk, c.options(match.teamA, match.teamB));
    toast(`Mercado aberto: ${c.name} 🎯`);
    await renderEditarJogo(matchId);
  } catch (e) { toast(`❌ ${e.message}`); }
}

async function adminRemoveMarket(matchId, marketId, pot, name) {
  const warn = pot > 0
    ? `Remover "${name}"? Tem 🪙 ${pot} apostados — as fichas são devolvidas aos jogadores.`
    : `Remover "${name}"?`;
  if (!confirm(warn)) return;
  try {
    await API.removeMarket(marketId);
    toast(`Mercado removido${pot > 0 ? " — fichas devolvidas ↩️" : ""}`);
    await renderEditarJogo(matchId);
  } catch (e) { toast(`❌ ${e.message}`); }
}

/* ---------- Ecrã: Mercados por defeito (admin) ---------- */

// Config do conjunto de mercados que abre automaticamente em cada jogo novo
// (criado à mão ou importado do ESPN). O catálogo real vive no SQL
// (bet4fun.market_catalog); o MARKET_CATALOG daqui serve só para desenhar.
async function renderMercadosDefeito() {
  if (!state.profile?.isAdmin) { location.hash = "#/perfil"; return; }
  shell(loadingScreen());
  const chosen = new Set(await API.getDefaultMarkets());

  shell(`
    <button class="back-btn" onclick="location.hash='#/admin'">← Admin</button>
    <h1 class="page-title">🃏 Mercados por defeito</h1>
    <p class="page-sub">Estes mercados abrem automaticamente em cada jogo novo — criado à mão ou importado do ESPN</p>

    <div class="card">
      ${MARKET_CATALOG.map((c) => `
        <label class="admin-item" style="cursor:pointer;padding:8px 0">
          <input type="checkbox" class="dm-check" style="width:18px;height:18px;accent-color:var(--pitch);flex-shrink:0" data-name="${escapeHtml(c.name)}" ${chosen.has(c.name) ? "checked" : ""}>
          <span class="risk-dot ${RISK[c.risk].cls}" style="flex-shrink:0"></span>
          <div class="desc">
            <div class="t">${escapeHtml(c.name)}</div>
            <div class="s">${RISK[c.risk].name} · ${c.options("Equipa A", "Equipa B").length} opções${c.knockoutOnly ? " · só nos jogos a eliminar" : ""}</div>
          </div>
        </label>`).join("")}
      <button class="btn-primary" style="margin-top:12px" onclick="saveDefaultMarkets()">Guardar configuração</button>
    </div>

    <div class="section-label">Jogos existentes</div>
    <div class="card">
      <p style="font-size:0.85rem;color:var(--text-dim);margin-bottom:12px">
        Abre os mercados em falta nos jogos que ainda não começaram. Não remove
        nenhum mercado já aberto — isso faz-se jogo a jogo em "Editar", porque
        devolve as fichas apostadas.
      </p>
      <button class="btn-secondary" onclick="applyDefaultMarkets()">Aplicar aos jogos existentes</button>
    </div>
  `);
}

async function saveDefaultMarkets() {
  const names = [...document.querySelectorAll(".dm-check:checked")].map((c) => c.dataset.name);
  if (!names.length) { toast("Escolhe pelo menos um mercado."); return; }
  try { await API.setDefaultMarkets(names); toast("Mercados por defeito guardados 🃏"); }
  catch (e) { toast(`❌ ${e.message}`); }
}

async function applyDefaultMarkets() {
  try {
    const n = await API.applyDefaultMarkets();
    toast(n > 0 ? `Abertos ${n} mercado(s) nos jogos existentes 🎯` : "Nada para abrir — os jogos já têm estes mercados ✅");
  } catch (e) { toast(`❌ ${e.message}`); }
}

/* ---------- Ecrã: Importar/Liquidar via ESPN (admin) ---------- */

async function renderEspn() {
  if (!state.profile?.isAdmin) { location.hash = "#/perfil"; return; }
  shell(loadingScreen("A falar com o ESPN…"));

  const [ours, toSettle] = await Promise.all([API.getMatches(), API.getMatchesToSettle()]);
  const datesMs = ours.map((m) => new Date(m.kickoffAt).getTime());
  // ids dos jogos que ainda têm mercados por liquidar (para não mostrar como
  // "por liquidar" os que já foram fechados à mão ou pelo automatismo)
  const pendingIds = new Set(toSettle.map((s) => String(s.id)));

  let games = [];
  let failed = false;
  // janela larga para a frente → traz também quartos/meias/final ainda distantes
  try { games = await fetchEspnEvents(datesMs, 21); }
  catch { failed = true; }
  if (!failed && !games.length) failed = true; // nada veio → provável bloqueio/erro

  // casar por par de equipas (em PT, como guardamos na BD)
  const ourByPair = {};
  ours.forEach((m) => { ourByPair[pairKey(m.teamA, m.teamB)] = m; });

  state.espn = { games, ours, ourByPair };

  const upcoming = games.filter((g) => g.state !== "post" && !ourByPair[pairKey(teamPt(g.teamAEn), teamPt(g.teamBEn))]);
  const finished = games
    .filter((g) => g.state === "post" && ourByPair[pairKey(teamPt(g.teamAEn), teamPt(g.teamBEn))])
    .map((g) => ({ g, m: ourByPair[pairKey(teamPt(g.teamAEn), teamPt(g.teamBEn))] }))
    // só os que ainda têm mercados por liquidar — os já fechados desaparecem
    .filter(({ m }) => pendingIds.has(String(m.id)));

  const gameLabel = (g) =>
    `${teamFlag(g.teamAEn)} ${escapeHtml(teamPt(g.teamAEn))} vs ${escapeHtml(teamPt(g.teamBEn))} ${teamFlag(g.teamBEn)}`;

  shell(`
    <button class="back-btn" onclick="location.hash='#/admin'">← Admin</button>
    <h1 class="page-title">⚡ ESPN</h1>
    <p class="page-sub">Jogos e resultados ao vivo, direto do ESPN</p>

    ${failed ? `<div class="callout warn"><span class="ico">📡</span>
      <span>Não consegui ler o ESPN agora (pode estar em baixo, sem jogos nas datas, ou bloqueado pela rede). Tenta de novo, ou usa o "Criar jogo à mão".</span></div>` : ""}

    <div class="section-label">Importar jogos previstos</div>
    ${upcoming.length ? `
      <div class="callout"><span class="ico">📥</span>
        <span>${upcoming.length} jogo(s) do ESPN ainda não estão cá. Cria-os com os mercados por defeito (configuráveis no admin).</span></div>
      <button class="btn-primary" style="margin-bottom:12px" onclick="espnImportAll()">Importar ${upcoming.length} jogo(s)</button>
      ${upcoming.map((g) => `
        <div class="card admin-item">
          <div class="desc"><div class="t">${gameLabel(g)}</div>
            <div class="s">${escapeHtml(g.stagePt)} · ${escapeHtml(fmtEspnDate(g.kickoffISO))}</div></div>
        </div>`).join("")}`
      : `<div class="empty" style="padding:20px"><span class="ico">✅</span>Sem jogos novos para importar.</div>`}

    <div class="section-label">Liquidar resultados terminados</div>
    ${finished.length ? finished.map(({ g, m }) => {
      const s = (g.scoreA != null && g.scoreB != null) ? `${g.scoreA}–${g.scoreB}` : "?";
      const extra = g.wentToPens ? " · foi a penáltis 🥅" : g.beyond90 ? " · prolongamento" : "";
      return `
        <div class="card">
          <div class="market-title-row">
            <span class="market-title">${gameLabel(g)}</span>
            <span class="market-pot" style="color:var(--text)">${s}${extra}</span>
          </div>
          <div class="s" style="font-size:0.78rem;color:var(--text-faint);margin-bottom:10px">${escapeHtml(g.stagePt)}</div>
          <button class="btn-small" onclick="espnSettle('${escapeAttr(m.id)}')">Liquidar este jogo</button>
          <button class="btn-small outline" style="margin-left:8px" onclick="location.hash='#/editar/${escapeAttr(m.id)}'">Rever à mão</button>
        </div>`;
    }).join("") : `<div class="empty" style="padding:20px"><span class="ico">🧾</span>Nenhum jogo terminado por liquidar.</div>`}
  `);
}

function fmtEspnDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleString("pt-PT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

async function espnImportAll() {
  const { games, ourByPair } = state.espn || {};
  if (!games) return;
  const upcoming = games.filter((g) => g.state !== "post" && !ourByPair[pairKey(teamPt(g.teamAEn), teamPt(g.teamBEn))]);
  if (!upcoming.length) { toast("Nada para importar."); return; }
  let n = 0;
  for (const g of upcoming) {
    try {
      await API.createMatch({
        stage: g.stagePt,
        teamA: teamPt(g.teamAEn), flagA: teamFlag(g.teamAEn),
        teamB: teamPt(g.teamBEn), flagB: teamFlag(g.teamBEn),
        kickoffAt: g.kickoffISO, knockout: g.knockout,
      });
      n++;
    } catch (e) { toast(`❌ ${teamPt(g.teamAEn)}: ${e.message}`); }
  }
  toast(`Importados ${n} jogo(s) 🎉`);
  await renderEspn();
}

async function espnSettle(matchId) {
  const st = state.espn;
  const m = st?.ours.find((x) => String(x.id) === String(matchId));
  if (!m) return;
  const g = st.games.find((x) => x.state === "post" && pairKey(teamPt(x.teamAEn), teamPt(x.teamBEn)) === pairKey(m.teamA, m.teamB));
  if (!g) { toast("Sem resultado do ESPN para este jogo."); return; }

  try {
    const { markets } = await API.getSettleForm(matchId);
    const plan = computeSettlement(g, markets, m.teamA, m.teamB);

    if (plan.score) await API.setMatchScore(matchId, plan.score.a, plan.score.b);
    let done = 0;
    for (const s of plan.toSettle) {
      try { await API.settleMarket(s.marketId, s.optionId); done++; }
      catch (e) { toast(`❌ ${s.marketName}: ${e.message}`); }
    }
    const skippedN = plan.skipped.length;
    toast(`Liquidados ${done} mercado(s)${skippedN ? ` · ${skippedN} para rever à mão` : ""} 🪙`);
    if (skippedN) toast(`⚠️ Por liquidar: ${plan.skipped.map((s) => s.name.split(" (")[0]).join(", ")}`);
    await renderEspn();
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

/* ---------- Auto-liquidação (admin) ---------- */

/* Ao entrar como admin, tenta liquidar automaticamente, via ESPN, os jogos
   já terminados que ainda têm mercados por liquidar. Corre em background e
   é totalmente defensivo: qualquer falha é ignorada (nunca rebenta o boot).
   O servidor valida tudo (settle_market é idempotente) — nada é pago a dobrar. */
async function autoSettleFinished() {
  try {
    if (!state.profile?.isAdmin) return;

    const games = await espnGames();
    if (!games?.length) return;

    const [ours, pending] = await Promise.all([API.getMatches(), API.getMatchesToSettle()]);
    const pendingIds = new Set(pending.map((s) => String(s.id)));
    const candidates = ours.filter((m) => pendingIds.has(String(m.id)));
    if (!candidates.length) return;

    let total = 0;
    for (const m of candidates) {
      const g = games.find((x) =>
        x.state === "post" &&
        pairKey(teamPt(x.teamAEn), teamPt(x.teamBEn)) === pairKey(m.teamA, m.teamB));
      if (!g) continue;
      try {
        const { markets } = await API.getSettleForm(m.id);
        const plan = computeSettlement(g, markets, m.teamA, m.teamB);
        if (plan.score) await API.setMatchScore(m.id, plan.score.a, plan.score.b);
        for (const s of plan.toSettle) {
          try { await API.settleMarket(s.marketId, s.optionId); total++; } catch { /* já liquidado */ }
        }
      } catch { /* segue para o próximo jogo */ }
    }

    if (total > 0) {
      state.profile = await API.getMyProfile().catch(() => state.profile);
      toast(`⚡ Auto-liquidados ${total} mercado(s) terminados`);
      const route = location.hash.replace(/^#\/?/, "").split("/")[0] || "jogos";
      if (route === "jogos" || route === "classificacao") await navigate();
    }
  } catch { /* ESPN em baixo/bloqueado — sem auto-liquidação desta vez */ }
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
    // O Supabase dispara INITIAL_SESSION ao subscrever e TOKEN_REFRESHED
    // periodicamente — ambos com o mesmo utilizador que o boot() já tratou.
    // Só re-navegar quando o utilizador muda de facto (login/logout), senão
    // fazíamos um segundo render completo à chegada (o ecrã "piscava").
    const newUid = session?.user?.id || null;
    if (newUid === (state.session?.user?.id || null)) return;
    state.session = session;
    state.profile = session
      ? await API.ensureProfile().then(() => API.getMyProfile()).catch(() => null)
      : null;
    await navigate();
  });

  await navigate();
  autoSettleFinished();   // background, só admin
}

boot();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

/* ---------- Expor handlers usados por onclick inline ---------- */
Object.assign(window, {
  doLogin, doLogout, refreshPending,
  openSlip, closeSlip, setStake, confirmBet,
  toggleReveal, trocarPalpite,
  togglePlayerHistory,
  doBailout,
  approvePlayer, approveBailout,
  saveScore, pickWinner, voidMarket, settleBoxToggled,
  submitCreateMatch,
  saveMatchEdit, adminAddMarket, adminRemoveMarket, adminRemoveMatch,
  saveDefaultMarkets, applyDefaultMarkets,
  espnImportAll, espnSettle,
});
