/* ============================================================
   O Casino da Malta — protótipo navegável (sem backend)
   Router por hash + renderização de vistas com dados de data.js.
   No handoff: cada função render*() corresponde a um ecrã do
   SPECS.md; a lógica de dados passa para o Supabase.
   ============================================================ */

const $ = (sel) => document.querySelector(sel);

const state = {
  loggedIn: false,
  slip: null, // { matchLabel, marketName, optionLabel, stake }
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
};

function navigate() {
  if (!state.loggedIn) { renderLogin(); return; }
  const [route, param] = location.hash.replace(/^#\/?/, "").split("/");
  const view = routes[route] || renderJogos;
  closeSlip();
  view(param);
  updateTabs(route || "jogos");
  window.scrollTo(0, 0);
}

window.addEventListener("hashchange", navigate);

function updateTabs(route) {
  const map = { jogos: "jogos", jogo: "jogos", apostas: "apostas", classificacao: "classificacao", perfil: "perfil", admin: "perfil" };
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === (map[route] || "jogos"));
  });
}

/* ---------- Login ---------- */

function renderLogin() {
  $("#app").innerHTML = `
    <div class="login">
      <div class="big-logo">🎲</div>
      <h1>O Casino da Malta</h1>
      <p class="tagline">Mundial 2026 · Prognósticos, picardia e fichas a rolar entre amigos.</p>
      <button class="btn-google" onclick="doLogin()">
        <span class="g">G</span> Entrar com o Google
      </button>
      <p class="fine">Só para a malta convidada. Fichas virtuais, zero dinheiro real — a única coisa em jogo é o teu prestígio.</p>
    </div>`;
}

function doLogin() {
  state.loggedIn = true;
  location.hash = "#/jogos";
  navigate();
}

function doLogout() {
  state.loggedIn = false;
  location.hash = "";
  navigate();
}

/* ---------- Shell (header + tabbar) ---------- */

function shell(content) {
  $("#app").innerHTML = `
    <div class="app">
      <header class="header">
        <div class="brand"><span class="logo">🎲</span> O Casino da Malta</div>
        <div class="chip-balance">🪙 ${MOCK.me.chips.toLocaleString("pt-PT")}</div>
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

  const mid = m.status === "open"
    ? `<span class="vs">VS</span><span class="time">${m.kickoff}</span>`
    : `<span class="score">${m.scoreA} – ${m.scoreB}</span><span class="time">${m.kickoff}</span>`;

  return `
    <button class="card tappable match-card" onclick="location.hash='#/jogo/${m.id}'">
      <div class="match-meta"><span class="match-stage">${m.stage}</span>${statusTag}</div>
      <div class="match-teams">
        <div class="match-team"><span class="flag">${m.flagA}</span><span class="name">${m.teamA}</span></div>
        <div class="match-mid">${mid}</div>
        <div class="match-team"><span class="flag">${m.flagB}</span><span class="name">${m.teamB}</span></div>
      </div>
      <div class="match-foot">
        <span>${m.status === "open" ? "As apostas fecham ao apito inicial" : m.status === "live" ? "📖 Livro aberto — vê as apostas de todos" : "Mercados liquidados"}</span>
        <span class="pot-tag">Pote 🪙 ${m.pot}</span>
      </div>
    </button>`;
}

function renderJogos() {
  const open = MOCK.matches.filter((m) => m.status === "open");
  const live = MOCK.matches.filter((m) => m.status === "live");
  const done = MOCK.matches.filter((m) => m.status === "done");

  shell(`
    <h1 class="page-title">Jogos</h1>
    <p class="page-sub">Oitavos de final · Mundial 2026</p>

    ${live.length ? `<div class="section-label">A decorrer</div>${live.map(matchCard).join("")}` : ""}
    ${open.length ? `<div class="section-label">Próximos jogos</div>${open.map(matchCard).join("")}` : ""}

    <div class="section-label">👑 Longo prazo (fechadas ao 1.º apito do Mundial)</div>
    ${MOCK.futures.map((f) => `
      <div class="card">
        <div class="market-title-row">
          <span class="market-title">${f.name}</span>
          <span class="market-pot">Pote 🪙 ${f.pot}</span>
        </div>
        <div class="bet-match">A tua aposta: <strong>${f.myPick}</strong> 🔒</div>
      </div>`).join("")}

    ${done.length ? `<div class="section-label">Terminados</div>${done.map(matchCard).join("")}` : ""}
  `);
}

/* ---------- Ecrã: Detalhe do jogo + mercados ---------- */

const RISK = {
  low: { name: "Risco baixo", sub: "O pão nosso de cada dia", cls: "risk-low-bg" },
  mid: { name: "Risco médio", sub: "A roleta", cls: "risk-mid-bg" },
  high: { name: "Risco alto", sub: "O jackpot", cls: "risk-high-bg" },
};

function renderJogoDetalhe(matchId) {
  const m = MOCK.matches.find((x) => x.id === matchId) || MOCK.matches[0];
  const label = `${m.flagA} ${m.teamA} vs ${m.teamB} ${m.flagB}`;

  let body;
  if (m.status === "open") {
    const markets = MOCK.markets[m.id] || MOCK.markets.m1;
    const groups = ["low", "mid", "high"].map((risk) => {
      const list = markets.filter((mk) => mk.risk === risk);
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
                <span class="market-title">${mk.name}</span>
                <span class="market-pot">Pote 🪙 ${mk.pot}</span>
              </div>
              <div class="options ${mk.options.length === 2 ? "cols-2" : ""}">
                ${mk.options.map((o) => `
                  <button class="option-btn" data-opt="${o.id}"
                    onclick="openSlip('${label.replace(/'/g, "\\'")}','${mk.name.replace(/'/g, "\\'")}','${o.label.replace(/'/g, "\\'")}', this)">
                    <span class="opt-label">${o.label}</span>
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
      ${groups}`;
  } else {
    const reveal = MOCK.reveal[m.id] || [];
    body = `
      <div class="callout warn"><span class="ico">📖</span>
        <span><strong>Livro aberto!</strong> O jogo começou — apostas reveladas. Que comece a picardia.</span>
      </div>
      <div class="card">
        ${reveal.length ? reveal.map((r) => `
          <div class="reveal-row">
            <span class="lb-avatar" style="width:32px;height:32px;font-size:1rem">${r.avatar}</span>
            <span class="reveal-who">${r.who}</span>
            <span class="reveal-pick">${r.pick}</span>
            <span class="reveal-stake">🪙 ${r.stake}</span>
          </div>`).join("") : `<div class="empty"><span class="ico">🦗</span>Ninguém apostou neste jogo.</div>`}
      </div>`;
  }

  shell(`
    <button class="back-btn" onclick="location.hash='#/jogos'">← Jogos</button>
    ${matchCard({ ...m })}
    ${body}
  `);
}

/* ---------- Boletim (bet slip) ---------- */

function openSlip(matchLabel, marketName, optionLabel, btn) {
  document.querySelectorAll(".option-btn.selected").forEach((b) => b.classList.remove("selected"));
  btn.classList.add("selected");
  state.slip = { matchLabel, marketName, optionLabel, stake: 25 };
  drawSlip();
}

function drawSlip() {
  const s = state.slip;
  if (!s) return;
  const el = $("#slip");
  el.innerHTML = `
    <div class="slip-inner">
      <div class="slip-row">
        <div>
          <div class="slip-market">${s.matchLabel} · ${s.marketName}</div>
          <div class="slip-pick">${s.optionLabel}</div>
        </div>
        <button class="slip-close" onclick="closeSlip()">✕</button>
      </div>
      <div class="stake-row">
        ${[10, 25, 50, 100].map((v) => `
          <button class="stake-chip ${s.stake === v ? "selected" : ""}" onclick="setStake(${v})">🪙 ${v}</button>`).join("")}
      </div>
      <div class="slip-projection">
        <span>Se acertares (pote atual)</span>
        <strong>≈ 🪙 ${Math.round(s.stake * 2.4)}</strong>
      </div>
      <button class="btn-primary" onclick="confirmBet()">Confirmar aposta 🤫</button>
    </div>`;
  el.classList.add("visible");
}

function setStake(v) { state.slip.stake = v; drawSlip(); }

function closeSlip() {
  const el = $("#slip");
  if (el) el.classList.remove("visible");
  document.querySelectorAll(".option-btn.selected").forEach((b) => b.classList.remove("selected"));
  state.slip = null;
}

function confirmBet() {
  const s = state.slip;
  closeSlip();
  toast(`Aposta registada: ${s.optionLabel} · 🪙 ${s.stake} 🤐`);
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2600);
}

/* ---------- Ecrã: As minhas apostas ---------- */

function renderApostas() {
  const pending = MOCK.myBets.filter((b) => b.status === "pending");
  const settled = MOCK.myBets.filter((b) => b.status !== "pending");

  const row = (b) => `
    <div class="bet-row">
      <div class="bet-info">
        <div class="bet-match">${b.match}</div>
        <div class="bet-pick">${b.pick}</div>
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
    ${settled.map(row).join("")}
  `);
}

/* ---------- Ecrã: Classificação ---------- */

function renderClassificacao() {
  shell(`
    <h1 class="page-title">Classificação</h1>
    <p class="page-sub">Quem manda no casino e quem está na penúria</p>
    ${MOCK.players.map((p, i) => `
      <div class="lb-row ${i === 0 ? "king" : ""} ${p.id === MOCK.me.id ? "me" : ""}">
        <span class="lb-rank">${i === 0 ? "👑" : i + 1}</span>
        <span class="lb-avatar">${p.avatar}</span>
        <div class="lb-info">
          <div class="lb-name">${p.name}${p.id === MOCK.me.id ? " (tu)" : ""}</div>
          <div class="lb-badges">${p.badges.join(" · ") || "—"}</div>
        </div>
        <div class="lb-chips">
          <span class="amount">🪙 ${p.chips.toLocaleString("pt-PT")}</span>
          <span class="delta ${p.delta >= 0 ? "delta-up" : "delta-down"}">${p.delta >= 0 ? "▲" : "▼"} ${Math.abs(p.delta)} esta jornada</span>
        </div>
      </div>`).join("")}
  `);
}

/* ---------- Ecrã: Perfil ---------- */

function renderPerfil() {
  const me = MOCK.me;
  shell(`
    <div class="profile-head">
      <div class="profile-avatar">${me.avatar}</div>
      <div>
        <div class="profile-name">${me.name}</div>
        <div class="profile-email">${me.email}</div>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat-tile"><div class="val">🪙 ${me.chips.toLocaleString("pt-PT")}</div><div class="lbl">Fichas</div></div>
      <div class="stat-tile"><div class="val">${MOCK.stats.won}/${MOCK.stats.total}</div><div class="lbl">Acertos</div></div>
      <div class="stat-tile"><div class="val">${MOCK.stats.winRate}</div><div class="lbl">Taxa</div></div>
    </div>

    <div class="section-label">Mural de títulos</div>
    <div class="card">
      <span class="badge gold">🎩 Rei do Casino</span>
      <span class="badge">🎯 Sniper — acertou um resultado exato</span>
      <span class="badge">🔥 3 vitórias seguidas</span>
    </div>

    <div class="section-label">Zona de emergência</div>
    <div class="card">
      <p style="font-size:0.85rem;color:var(--text-dim);margin-bottom:12px">
        Sem fichas? Pede um resgate ao Administrador. Atenção: ficas com o badge
        <strong>💸 Financiado pelo FMI</strong> até ao fim do Mundial. Sem vergonha não há jogo.
      </p>
      <button class="btn-danger-outline" onclick="toast('Pedido de bailout enviado ao Admin 💸')">Pedir Bailout 🆘</button>
    </div>

    ${me.isAdmin ? `
      <div class="section-label">Administração</div>
      <button class="btn-secondary" style="margin-bottom:10px" onclick="location.hash='#/admin'">🎛️ Painel de Admin</button>` : ""}

    <button class="btn-secondary" style="border-color:transparent;color:var(--text-faint)" onclick="doLogout()">Terminar sessão</button>
  `);
}

/* ---------- Ecrã: Admin ---------- */

function renderAdmin() {
  const a = MOCK.admin;
  shell(`
    <button class="back-btn" onclick="location.hash='#/perfil'">← Perfil</button>
    <h1 class="page-title">🎛️ Painel de Admin</h1>
    <p class="page-sub">Gerir o casino sem sujar as mãos</p>

    <div class="section-label">Pedidos de bailout</div>
    ${a.bailouts.map((b) => `
      <div class="card admin-item">
        <span class="lb-avatar">${b.avatar}</span>
        <div class="desc"><div class="t">${b.who}</div><div class="s">"${b.note}"</div></div>
        <button class="btn-small" onclick="toast('Bailout aprovado. ${b.who} ficou marcado 💸')">Aprovar</button>
      </div>`).join("")}

    <div class="section-label">Liquidar mercados</div>
    ${a.toSettle.map((s) => `
      <div class="card admin-item">
        <div class="desc"><div class="t">${s.match}</div><div class="s">${s.detail}</div></div>
        <button class="btn-small outline" onclick="toast('Ecrã de liquidação (no produto final)')">Liquidar</button>
      </div>`).join("")}

    <div class="section-label">Gestão</div>
    <div class="card admin-item">
      <div class="desc"><div class="t">Criar jogo / mercados</div><div class="s">Adicionar próximos jogos e mercados por nível de risco</div></div>
      <button class="btn-small outline" onclick="toast('Formulário de criação (no produto final)')">Criar</button>
    </div>
    <div class="card admin-item">
      <div class="desc"><div class="t">Jogadores &amp; fichas iniciais</div><div class="s">Convidar malta, definir orçamento inicial (atual: 🪙 1000)</div></div>
      <button class="btn-small outline" onclick="toast('Gestão de jogadores (no produto final)')">Gerir</button>
    </div>
  `);
}

/* ---------- Arranque + PWA ---------- */

navigate();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
