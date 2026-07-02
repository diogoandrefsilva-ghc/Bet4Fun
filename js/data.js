/* ============================================================
   Dados fictícios (mock) — no produto final vêm do Supabase.
   Mantido separado do app.js para o handoff ser óbvio:
   substituir este ficheiro por chamadas à API.
   ============================================================ */

const MOCK = {
  me: {
    id: "u1",
    name: "Diogo",
    avatar: "🦁",
    email: "diogo.andre.f.silva@gmail.com",
    chips: 1240,
    isAdmin: true,
  },

  players: [
    { id: "u1", name: "Diogo", avatar: "🦁", chips: 1240, delta: +180, badges: ["🎩 Rei do Casino"], bankrupt: false },
    { id: "u2", name: "Rui", avatar: "🐺", chips: 1105, delta: +40, badges: ["🧊 O Conservador"], bankrupt: false },
    { id: "u3", name: "Marco", avatar: "🦈", chips: 960, delta: -120, badges: [], bankrupt: false },
    { id: "u4", name: "Pedro", avatar: "🐙", chips: 720, delta: +310, badges: ["🌪️ O Lunático"], bankrupt: false },
    { id: "u5", name: "Zé", avatar: "🦉", chips: 415, delta: -95, badges: ["🇵🇹 O Anti-Pátria"], bankrupt: false },
    { id: "u6", name: "Tiago", avatar: "🐔", chips: 120, delta: -260, badges: ["💸 Financiado pelo FMI"], bankrupt: true },
  ],

  // status: "open" (apostas abertas) | "live" (a decorrer, livro aberto) | "done" (liquidado)
  matches: [
    {
      id: "m1", stage: "Oitavos de final", teamA: "Portugal", flagA: "🇵🇹",
      teamB: "México", flagB: "🇲🇽", kickoff: "Hoje · 20:00", status: "open", pot: 480,
    },
    {
      id: "m2", stage: "Oitavos de final", teamA: "França", flagA: "🇫🇷",
      teamB: "Japão", flagB: "🇯🇵", kickoff: "Hoje · 23:00", status: "open", pot: 305,
    },
    {
      id: "m3", stage: "Oitavos de final", teamA: "Brasil", flagA: "🇧🇷",
      teamB: "Marrocos", flagB: "🇲🇦", kickoff: "Ao intervalo", status: "live",
      scoreA: 1, scoreB: 1, pot: 620,
    },
    {
      id: "m4", stage: "Oitavos de final", teamA: "Argentina", flagA: "🇦🇷",
      teamB: "Senegal", flagB: "🇸🇳", kickoff: "Ontem", status: "done",
      scoreA: 2, scoreB: 0, pot: 540,
    },
  ],

  // Mercados do jogo m1 (os outros jogos reutilizam a mesma estrutura)
  markets: {
    m1: [
      {
        id: "mk1", risk: "low", name: "Resultado (1X2)", pot: 210,
        options: [
          { id: "o1", label: "Portugal", pool: 150 },
          { id: "o2", label: "Empate", pool: 35 },
          { id: "o3", label: "México", pool: 25 },
        ],
      },
      {
        id: "mk2", risk: "low", name: "Mais/Menos 2.5 golos", pot: 90,
        options: [
          { id: "o4", label: "Mais 2.5", pool: 60 },
          { id: "o5", label: "Menos 2.5", pool: 30 },
        ],
      },
      {
        id: "mk3", risk: "mid", name: "Ambas marcam", pot: 60,
        options: [
          { id: "o6", label: "Sim", pool: 25 },
          { id: "o7", label: "Não", pool: 35 },
        ],
      },
      {
        id: "mk4", risk: "mid", name: "Primeira equipa a marcar", pot: 45,
        options: [
          { id: "o8", label: "Portugal", pool: 30 },
          { id: "o9", label: "México", pool: 10 },
          { id: "o10", label: "Nenhuma", pool: 5 },
        ],
      },
      {
        id: "mk5", risk: "high", name: "Resultado exato", pot: 55,
        options: [
          { id: "o11", label: "1-0", pool: 15 },
          { id: "o12", label: "2-0", pool: 20 },
          { id: "o13", label: "2-1", pool: 10 },
          { id: "o14", label: "Outro", pool: 10 },
        ],
      },
      {
        id: "mk6", risk: "high", name: "Cartão vermelho no jogo", pot: 20,
        options: [
          { id: "o15", label: "Sim", pool: 5 },
          { id: "o16", label: "Não", pool: 15 },
        ],
      },
    ],
  },

  futures: [
    {
      id: "f1", name: "Campeão do Mundo", pot: 900, locked: true, myPick: "Portugal 🇵🇹 · 100 fichas",
    },
    {
      id: "f2", name: "Bota de Ouro", pot: 620, locked: true, myPick: "Mbappé · 50 fichas",
    },
    {
      id: "f3", name: "Equipa Sensação", pot: 410, locked: true, myPick: "Marrocos 🇲🇦 · 30 fichas",
    },
  ],

  myBets: [
    { id: "b1", match: "🇵🇹 Portugal vs México 🇲🇽 · Hoje 20:00", pick: "1X2 · Portugal", stake: 50, status: "pending", secret: true },
    { id: "b2", match: "🇧🇷 Brasil vs Marrocos 🇲🇦 · Ao vivo", pick: "Resultado exato · 2-1", stake: 25, status: "pending", secret: false },
    { id: "b3", match: "🇦🇷 Argentina vs Senegal 🇸🇳 · Ontem", pick: "1X2 · Argentina", stake: 40, status: "won", payout: 95 },
    { id: "b4", match: "🇦🇷 Argentina vs Senegal 🇸🇳 · Ontem", pick: "Ambas marcam · Sim", stake: 30, status: "lost" },
  ],

  // Livro aberto do jogo live (m3): apostas reveladas de todos
  reveal: {
    m3: [
      { who: "Diogo", avatar: "🦁", pick: "Resultado exato · 2-1", stake: 25 },
      { who: "Rui", avatar: "🐺", pick: "1X2 · Brasil", stake: 60 },
      { who: "Marco", avatar: "🦈", pick: "1X2 · Brasil", stake: 80 },
      { who: "Pedro", avatar: "🐙", pick: "Resultado exato · 0-3", stake: 40 },
      { who: "Zé", avatar: "🦉", pick: "1X2 · Marrocos", stake: 55 },
      { who: "Tiago", avatar: "🐔", pick: "Ambas marcam · Sim", stake: 20 },
    ],
  },

  admin: {
    bailouts: [
      { id: "br1", who: "Tiago", avatar: "🐔", note: "Perdi tudo no Brasil… manda lá 200 fichas 🙏" },
    ],
    toSettle: [
      { id: "s1", match: "🇧🇷 Brasil vs Marrocos 🇲🇦", detail: "6 mercados por liquidar quando terminar" },
    ],
  },

  stats: { total: 14, won: 6, winRate: "43%" },
};
