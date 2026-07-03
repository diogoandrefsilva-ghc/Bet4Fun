/* ============================================================
   Bet4Fun — Integração com a API pública do ESPN (fifa.world)
   ------------------------------------------------------------
   Baseado na lógica da FutebolSelecoes: lê o scoreboard público
   do ESPN (sem API key), converte cada evento para o formato
   interno e casa os jogos pelo PAR DE EQUIPAS (não pelo id).

   Corre no browser do utilizador (não num servidor) — por isso
   não é afetado por políticas de rede do lado do servidor. O
   endpoint do ESPN devolve CORS aberto, logo o fetch funciona.

   ⚠️ São endpoints "descobertos", sem SLA nem docs. Tudo é
   defensivo: qualquer falha devolve lista vazia, nunca rebenta.
   ============================================================ */

const SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";

/* Sigla ESPN → nome interno (inglês). Do anexo do FutebolSelecoes. */
const ESPN_ABBR = {
  MEX: "Mexico", RSA: "South Africa", KOR: "South Korea", CZE: "Czechia",
  SUI: "Switzerland", CAN: "Canada", BIH: "Bosnia & Herzegovina", QAT: "Qatar",
  BRA: "Brazil", MAR: "Morocco", SCO: "Scotland", HAI: "Haiti",
  USA: "USA", AUS: "Australia", PAR: "Paraguay", TUR: "Turkey",
  GER: "Germany", CIV: "Ivory Coast", ECU: "Ecuador", CUW: "Curacao",
  NED: "Netherlands", JPN: "Japan", SWE: "Sweden", TUN: "Tunisia",
  BEL: "Belgium", EGY: "Egypt", IRN: "Iran", NZL: "New Zealand",
  ESP: "Spain", CPV: "Cape Verde", URU: "Uruguay", KSA: "Saudi Arabia",
  FRA: "France", NOR: "Norway", SEN: "Senegal", IRQ: "Iraq",
  ARG: "Argentina", AUT: "Austria", ALG: "Algeria", JOR: "Jordan",
  COL: "Colombia", POR: "Portugal", COD: "DR Congo", UZB: "Uzbekistan",
  ENG: "England", GHA: "Ghana", CRO: "Croatia", PAN: "Panama",
};

/* Nome interno (inglês) → { pt, flag }. Do quadro do Mundial 2026. */
const TEAMS = {
  "Mexico": { pt: "México", flag: "🇲🇽" },
  "South Africa": { pt: "África do Sul", flag: "🇿🇦" },
  "South Korea": { pt: "Coreia do Sul", flag: "🇰🇷" },
  "Czechia": { pt: "Chéquia", flag: "🇨🇿" },
  "Switzerland": { pt: "Suíça", flag: "🇨🇭" },
  "Canada": { pt: "Canadá", flag: "🇨🇦" },
  "Bosnia & Herzegovina": { pt: "Bósnia e Herz.", flag: "🇧🇦" },
  "Qatar": { pt: "Catar", flag: "🇶🇦" },
  "Brazil": { pt: "Brasil", flag: "🇧🇷" },
  "Morocco": { pt: "Marrocos", flag: "🇲🇦" },
  "Scotland": { pt: "Escócia", flag: "🏴󠁧󠁢󠁳󠁣󠁴󠁿" },
  "Haiti": { pt: "Haiti", flag: "🇭🇹" },
  "USA": { pt: "Estados Unidos", flag: "🇺🇸" },
  "Australia": { pt: "Austrália", flag: "🇦🇺" },
  "Paraguay": { pt: "Paraguai", flag: "🇵🇾" },
  "Turkey": { pt: "Turquia", flag: "🇹🇷" },
  "Germany": { pt: "Alemanha", flag: "🇩🇪" },
  "Ivory Coast": { pt: "Costa do Marfim", flag: "🇨🇮" },
  "Ecuador": { pt: "Equador", flag: "🇪🇨" },
  "Curacao": { pt: "Curaçao", flag: "🇨🇼" },
  "Netherlands": { pt: "Países Baixos", flag: "🇳🇱" },
  "Japan": { pt: "Japão", flag: "🇯🇵" },
  "Sweden": { pt: "Suécia", flag: "🇸🇪" },
  "Tunisia": { pt: "Tunísia", flag: "🇹🇳" },
  "Belgium": { pt: "Bélgica", flag: "🇧🇪" },
  "Egypt": { pt: "Egito", flag: "🇪🇬" },
  "Iran": { pt: "Irão", flag: "🇮🇷" },
  "New Zealand": { pt: "Nova Zelândia", flag: "🇳🇿" },
  "Spain": { pt: "Espanha", flag: "🇪🇸" },
  "Cape Verde": { pt: "Cabo Verde", flag: "🇨🇻" },
  "Uruguay": { pt: "Uruguai", flag: "🇺🇾" },
  "Saudi Arabia": { pt: "Arábia Saudita", flag: "🇸🇦" },
  "France": { pt: "França", flag: "🇫🇷" },
  "Norway": { pt: "Noruega", flag: "🇳🇴" },
  "Senegal": { pt: "Senegal", flag: "🇸🇳" },
  "Iraq": { pt: "Iraque", flag: "🇮🇶" },
  "Argentina": { pt: "Argentina", flag: "🇦🇷" },
  "Austria": { pt: "Áustria", flag: "🇦🇹" },
  "Algeria": { pt: "Argélia", flag: "🇩🇿" },
  "Jordan": { pt: "Jordânia", flag: "🇯🇴" },
  "Colombia": { pt: "Colômbia", flag: "🇨🇴" },
  "Portugal": { pt: "Portugal", flag: "🇵🇹" },
  "DR Congo": { pt: "RD Congo", flag: "🇨🇩" },
  "Uzbekistan": { pt: "Usbequistão", flag: "🇺🇿" },
  "England": { pt: "Inglaterra", flag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿" },
  "Ghana": { pt: "Gana", flag: "🇬🇭" },
  "Croatia": { pt: "Croácia", flag: "🇭🇷" },
  "Panama": { pt: "Panamá", flag: "🇵🇦" },
};

export function teamPt(en) { return TEAMS[en]?.pt || en; }
export function teamFlag(en) { return TEAMS[en]?.flag || ""; }
export function pairKey(a, b) { return [a, b].map((s) => (s || "").toLowerCase()).sort().join("|"); }

const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[^a-z]/g, "");
const NAME_TO_TEAM = {};
Object.values(ESPN_ABBR).forEach((n) => { NAME_TO_TEAM[norm(n)] = n; });
const ALIASES = {
  unitedstates: "USA", czechrepublic: "Czechia", korearepublic: "South Korea",
  iriran: "Iran", cotedivoire: "Ivory Coast", caboverde: "Cape Verde",
  bosniaandherzegovina: "Bosnia & Herzegovina",
  democraticrepublicofcongo: "DR Congo", congodr: "DR Congo", turkiye: "Turkey",
};

function espnTeamToInternal(team) {
  if (!team) return null;
  if (team.abbreviation && ESPN_ABBR[team.abbreviation]) return ESPN_ABBR[team.abbreviation];
  for (const k of [team.displayName, team.shortDisplayName, team.name, team.location]) {
    const n = NAME_TO_TEAM[norm(k)] || ALIASES[norm(k)];
    if (n) return n;
  }
  return null;
}

function ymd(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/* Texto da ronda (EN) → etiqueta de fase (PT). */
export function stageToPt(text) {
  const t = (text || "").toLowerCase();
  if (t.includes("group")) return "Fase de grupos";
  if (t.includes("third")) return "3.º e 4.º lugar";
  if (t.includes("round of 32") || t.includes("32")) return "16 avos de final";
  if (t.includes("round of 16") || t.includes("16")) return "Oitavos de final";
  if (t.includes("quarter")) return "Quartos de final";
  if (t.includes("semi")) return "Meias-finais";
  if (t.includes("final")) return "Final";
  return "Eliminatória";
}

/* Um evento do scoreboard → objeto normalizado (ou null se inutilizável). */
function parseEvent(ev) {
  const comp = (ev.competitions && ev.competitions[0]) || {};
  const st = comp.status || ev.status || {};
  const state = (st.type && st.type.state) || "pre"; // pre | in | post
  const detail = `${st.type?.detail || ""} ${st.type?.shortDetail || ""} ${st.type?.description || ""}`;
  const cs = comp.competitors || [];
  if (cs.length < 2) return null;

  const enA = espnTeamToInternal(cs[0].team);
  const enB = espnTeamToInternal(cs[1].team);
  if (!enA || !enB) return null;

  const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
  const scoreA = num(cs[0].score), scoreB = num(cs[1].score);
  const penA = num(cs[0].shootoutScore), penB = num(cs[1].shootoutScore);
  const wentToPens = penA != null || penB != null;
  // Foi além dos 90 min? (penáltis, ou marca de prolongamento no estado)
  const beyond90 = wentToPens || /aet|a\.e\.t|extra|\b1(0[5-9]|1\d|20)/i.test(detail);

  const stageText = comp.notes?.[0]?.headline || ev.name || ev.shortName || ev.season?.slug || "";
  const stagePt = stageToPt(stageText);

  return {
    espnId: ev.id, state, beyond90, wentToPens,
    teamAEn: enA, teamBEn: enB, scoreA, scoreB,
    kickoffISO: ev.date, stagePt, knockout: stagePt !== "Fase de grupos",
  };
}

async function fetchJson(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7000);
    const r = await fetch(url, { cache: "no-store", signal: ctrl.signal });
    clearTimeout(t);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/* Vai ao ESPN buscar os eventos de uma janela de dias (ontem → +forwardDays)
   + os dias dos nossos jogos. Junta tudo, dedup por id mantendo o estado mais
   avançado.

   `forwardDays` controla quantos dias PARA A FRENTE se procura. Por defeito só
   1 (ontem/hoje/amanhã) — chega para resultados ao vivo/liquidação e mantém o
   fetch leve. O ecrã de importação passa uma janela larga para trazer também
   os jogos ainda distantes (quartos, meias, final). */
export async function fetchEspnEvents(extraDatesMs = [], forwardDays = 1) {
  const set = new Set();
  for (let off = -1; off <= forwardDays; off++) set.add(ymd(Date.now() + off * 86400000));
  for (const ms of extraDatesMs) if (Number.isFinite(ms)) set.add(ymd(ms));

  const urls = [SCOREBOARD, ...[...set].map((d) => `${SCOREBOARD}?dates=${d}`)];
  const jsons = await Promise.all(urls.map(fetchJson));

  const rank = { pre: 0, in: 1, post: 2 };
  const byId = new Map();
  for (const j of jsons) {
    for (const ev of (j?.events || [])) {
      const g = parseEvent(ev);
      if (!g) continue;
      const prev = byId.get(g.espnId);
      if (!prev || rank[g.state] >= rank[prev.state]) byId.set(g.espnId, g);
    }
  }
  return [...byId.values()];
}

/* Dado um jogo do ESPN + os mercados do nosso jogo (com opções), calcula o
   que se pode liquidar automaticamente.

   REGRA (2026-07): as apostas de resultado/golos contam o marcador ao FIM
   DO JOGO — prolongamento incluído — e EXCLUEM a marcação de grandes
   penalidades. Ou seja, usa-se `game.scoreA/scoreB` do ESPN (que já é o
   resultado final ao fim dos 120', sem o shootout). "Decisão por penáltis"
   liquida pelo shootoutScore (game.wentToPens). */
export function computeSettlement(game, markets, teamAPt, teamBPt) {
  const ptScore = {};
  ptScore[teamPt(game.teamAEn)] = game.scoreA;
  ptScore[teamPt(game.teamBEn)] = game.scoreB;
  const sA = ptScore[teamAPt], sB = ptScore[teamBPt];
  const known = Number.isFinite(sA) && Number.isFinite(sB);

  const toSettle = [], skipped = [];
  const findOpt = (mk, label) => mk.options.find((o) => o.label === label);

  for (const mk of markets) {
    const name = mk.name || "";

    if (name.startsWith("Decisão por penáltis")) {
      const opt = findOpt(mk, game.wentToPens ? "Sim" : "Não");
      if (opt) toSettle.push({ marketId: mk.id, optionId: opt.id, marketName: name, label: opt.label });
      continue;
    }

    if (!known) { skipped.push({ name, reason: "sem resultado" }); continue; }

    // Resultado ao fim do jogo (120' quando há prolongamento; exclui penáltis)
    let label = null;
    if (name.startsWith("Resultado (1X2)")) label = sA > sB ? teamAPt : sB > sA ? teamBPt : "Empate";
    else if (name.startsWith("Mais/Menos")) label = (sA + sB) > 2 ? "Mais 2.5" : "Menos 2.5";
    else if (name.startsWith("Resultado exato")) { const s = `${sA}-${sB}`; label = findOpt(mk, s) ? s : "Outro"; }
    else if (name.startsWith("Ambas marcam")) label = (sA > 0 && sB > 0) ? "Sim" : "Não";

    if (label) {
      const opt = findOpt(mk, label);
      if (opt) toSettle.push({ marketId: mk.id, optionId: opt.id, marketName: name, label });
      else skipped.push({ name, reason: "opção não encontrada" });
    } else {
      // mercados que o ESPN não resolve (1.ª equipa a marcar, cartões, ...)
      skipped.push({ name, reason: "liquida à mão" });
    }
  }

  return { toSettle, skipped, score: known ? { a: sA, b: sB } : null };
}

/* Marcadores "a ganhar" face ao resultado ATUAL (ao vivo). Ao contrário da
   liquidação, é provisório e não respeita a regra dos 90' — serve só para
   assinalar, em cada mercado, qual a opção que iria pagar se o jogo acabasse
   agora. Devolve { leaders: { [marketId]: optionId }, score: {a,b}|null }.
   `markets` são os mercados no formato do detalhe (id + options[{id,label}]). */
export function computeLiveMarkers(game, markets, teamAPt, teamBPt) {
  const ptScore = {};
  ptScore[teamPt(game.teamAEn)] = game.scoreA;
  ptScore[teamPt(game.teamBEn)] = game.scoreB;
  const sA = ptScore[teamAPt], sB = ptScore[teamBPt];
  const leaders = {};
  if (!Number.isFinite(sA) || !Number.isFinite(sB)) return { leaders, score: null };

  const findOpt = (mk, label) => (mk.options || []).find((o) => o.label === label);
  for (const mk of markets) {
    const name = mk.name || "";
    let label = null;
    if (name.startsWith("Resultado (1X2)")) label = sA > sB ? teamAPt : sB > sA ? teamBPt : "Empate";
    else if (name.startsWith("Mais/Menos")) label = (sA + sB) > 2 ? "Mais 2.5" : "Menos 2.5";
    else if (name.startsWith("Resultado exato")) { const s = `${sA}-${sB}`; label = findOpt(mk, s) ? s : "Outro"; }
    else if (name.startsWith("Ambas marcam")) label = (sA > 0 && sB > 0) ? "Sim" : "Não";
    else if (name.startsWith("Decisão por penáltis")) label = game.wentToPens ? "Sim" : "Não";
    if (label) {
      const opt = findOpt(mk, label);
      if (opt) leaders[String(mk.id)] = String(opt.id);
    }
  }
  return { leaders, score: { a: sA, b: sB } };
}
