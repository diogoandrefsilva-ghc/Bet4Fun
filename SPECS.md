# 📋 SPECS — Bet4Fun (Mundial 2026)

Especificação técnica. A app (`index.html` + `css/` + `js/`) fala com o Supabase real via
`js/api.js` (não há modo demo). Esta spec descreve o modelo de dados, RLS e RPCs por trás
dos ecrãs. Não reinventar UI.

> Conceito completo do jogo: ver `CONCEITO.md`.

---

## 1. Arquitetura

| Camada | Escolha | Notas |
|---|---|---|
| Frontend | HTML/CSS/JS vanilla (sem framework) | PWA instalável; estrutura atual do repo mantém-se |
| Backend | Supabase (Postgres + Auth + RLS) | Toda a lógica sensível em SQL/RPC, nunca no cliente |
| Auth | Supabase Auth com Google OAuth | Login exclusivo por Gmail; sem password |
| Hosting | Qualquer estático (GitHub Pages / Netlify / Vercel) | HTTPS obrigatório (PWA + OAuth) |
| SDK | `@supabase/supabase-js` v2 via CDN (esm) | Sem build step |

**Princípio de segurança nº 1:** o cliente nunca escreve saldos, nunca liquida mercados e nunca lê
apostas alheias antes do apito inicial. Tudo isso é imposto por **RLS + funções RPC `SECURITY DEFINER`**.
Assumir sempre que um jogador vai abrir a consola do browser para fazer batota (conhecemos a malta).

---

## 2. Modelo de dados (Postgres / Supabase)

```sql
-- Perfis (1:1 com auth.users, criado por trigger no signup)
profiles (
  id uuid PK REFERENCES auth.users,
  display_name text NOT NULL,
  avatar_emoji text DEFAULT '⚽',
  is_admin boolean DEFAULT false,
  is_approved boolean DEFAULT false,   -- admin aprova entrada no grupo
  created_at timestamptz DEFAULT now()
)

-- Saldo NUNCA é uma coluna editável: é a soma do ledger (ver view abaixo)
transactions (
  id bigint PK,
  profile_id uuid REFERENCES profiles,
  amount int NOT NULL,                 -- positivo = crédito, negativo = débito
  kind text CHECK (kind IN ('initial','bet','payout','refund','bailout','admin_adjust')),
  ref_bet_id bigint NULL,
  created_at timestamptz DEFAULT now()
)

matches (
  id bigint PK,
  stage text NOT NULL,                 -- 'Fase de grupos', 'Oitavos', ...
  team_a text NOT NULL, flag_a text,
  team_b text NOT NULL, flag_b text,
  kickoff_at timestamptz NOT NULL,     -- fecho das apostas = kickoff_at
  score_a int NULL, score_b int NULL,  -- resultado ao fim do jogo (prolong. incl., sem penáltis)
  status text CHECK (status IN ('scheduled','live','finished','settled')) DEFAULT 'scheduled'
)

markets (
  id bigint PK,
  match_id bigint NULL REFERENCES matches,  -- NULL = mercado "future" (longo prazo)
  name text NOT NULL,                       -- '1X2', 'Over/Under 2.5', 'Resultado exato', ...
  risk text CHECK (risk IN ('low','mid','high','future')),
  closes_at timestamptz NOT NULL,           -- = kickoff do jogo; futures = kickoff do 1º jogo do Mundial
  status text CHECK (status IN ('open','closed','settled','void')) DEFAULT 'open',
  winning_option_id bigint NULL
)

market_options (
  id bigint PK,
  market_id bigint REFERENCES markets,
  label text NOT NULL,                 -- 'Portugal', 'Empate', '2-1', 'Sim', ...
  sort int DEFAULT 0
)

bets (
  id bigint PK,
  profile_id uuid REFERENCES profiles,
  market_id bigint REFERENCES markets,
  option_id bigint REFERENCES market_options,
  stake int NOT NULL CHECK (stake > 0),
  created_at timestamptz DEFAULT now(),
  UNIQUE (profile_id, market_id)       -- 1 aposta por jogador por mercado
)

bailout_requests (
  id bigint PK,
  profile_id uuid REFERENCES profiles,
  note text,
  status text CHECK (status IN ('pending','approved','rejected')) DEFAULT 'pending',
  created_at timestamptz DEFAULT now()
)

badges (
  id bigint PK,
  profile_id uuid REFERENCES profiles,
  code text NOT NULL,                  -- 'fmi', 'conservador', 'lunatico', 'anti_patria', 'rei', 'sniper'
  awarded_at timestamptz DEFAULT now(),
  UNIQUE (profile_id, code)
)

settings (
  key text PK,                         -- 'initial_chips'=1000, 'bailout_chips'=200, 'min_stake'=5,
  value jsonb                          --   'min_match_stake'=100 (mínimo obrigatório por jogo; o resto expira)
)

-- Fichas expiradas por jogo (aposta mínima obrigatória não cumprida)
chip_expiries (
  id bigint PK,
  match_id bigint REFERENCES matches,
  profile_id uuid REFERENCES profiles,
  amount int NOT NULL CHECK (amount > 0),   -- fichas que expiraram (débito no ledger, kind='expiry')
  created_at timestamptz DEFAULT now(),
  UNIQUE (match_id, profile_id)
)
```

**Views:**

```sql
-- Saldo por jogador
CREATE VIEW balances AS
  SELECT profile_id, COALESCE(SUM(amount),0) AS chips
  FROM transactions GROUP BY profile_id;

-- Leaderboard (saldo + delta da última jornada + badges agregados)
-- delta = soma de transactions dos últimos X dias (ou desde a última jornada)

-- Pool por opção de mercado (para mostrar "🪙 X no pote" SEM revelar quem apostou)
CREATE VIEW market_pools AS
  SELECT market_id, option_id, SUM(stake) AS pool, COUNT(*) AS n_bets
  FROM bets GROUP BY market_id, option_id;
```

> ⚠️ Decisão de design: o **pote agregado por opção é público antes do kickoff** (cria dinâmica de
> "está toda a malta no Portugal"), mas as **apostas individuais são secretas**. Se o grupo preferir
> segredo total, esconder também os agregados até ao kickoff — flag em `settings('show_pools_before_kickoff')`.

---

## 3. Autenticação e onboarding

1. `supabase.auth.signInWithOAuth({ provider: 'google' })` — único método de login.
2. A app chama a RPC `ensure_profile()` no 1.º acesso, que cria a linha em `profiles` (nome/avatar do
   Google) com `is_approved=false`. **Nota:** o `auth.users` é partilhado por várias apps do projeto —
   por isso a inscrição é feita à chegada ao Bet4Fun (RPC), e **não** por trigger global de signup.
3. Utilizador não aprovado vê um ecrã "à espera que o admin te deixe entrar".
4. Admin aprova no painel → RPC `approve_player(profile_id)`: seta `is_approved=true` e insere
   transação `initial` com as fichas de `settings('initial_chips')`.
5. O primeiro utilizador registado (ou email hardcoded em seed) fica `is_admin=true`.

---

## 4. Regras de negócio (implementar como RPC em SQL)

### 4.1 `place_bet(market_id, option_id, stake)`
Validações **server-side** (falha com erro claro se violar):
- Mercado `status='open'` **e** `now() < closes_at` (dupla verificação);
- `stake >= settings('min_stake')` e `stake <= saldo atual` (via view `balances`);
- Opção pertence ao mercado; jogador aprovado;
- Upsert: se já existe aposta no mercado, a nova **substitui** a antiga (reembolsa e re-debita) — permitido até ao fecho.
- Efeito: insere/atualiza `bets` + transação `kind='bet'` com `-stake`. Tudo numa transação SQL.

### 4.2 Fecho automático
- Não confiar em cron: o fecho é **lógico** (`now() >= closes_at` ⇒ mercado tratado como fechado em
  todas as policies e RPCs, independentemente do `status`).

### 4.3 `settle_market(market_id, winning_option_id)` — só admin
Algoritmo do **pool betting**:
```
pote_total   = SUM(stake) de todas as apostas do mercado
pote_vencedor= SUM(stake) das apostas na opção vencedora

se pote_vencedor > 0:
  para cada aposta vencedora:
    payout = floor(pote_total * (stake / pote_vencedor))
    inserir transação kind='payout' com +payout
  (restos de arredondamento: atribuir ao maior apostador vencedor, determinístico)

se pote_vencedor = 0 (ninguém acertou):
  reembolsar todas as apostas (kind='refund')       ← comportamento por defeito
  OU acumular no "Jackpot de consolação" no fim     ← flag settings('rollover_unclaimed'), fase 2

marcar market.status='settled', winning_option_id
```
- Idempotente: liquidar um mercado já `settled` não faz nada.
- `void_market(market_id)`: jogo cancelado/adiado → reembolso total.
- Ao liquidar chama `expire_match_shortfalls(match_id)` (ver 4.6) — as fichas em falta expiram.

### 4.5.b `expire_match_shortfalls(match_id)` — aposta mínima obrigatória por jogo
Para ninguém "adormecer" no topo da tabela sem arriscar, cada jogador é obrigado a apostar
no mínimo `settings('min_match_stake')` (por defeito **100**) em cada jogo. O que não apostar
**expira** — sai do saldo e não volta.
```
para cada jogador aprovado (que já cá estava ao apito):
  em_falta = max(0, min_match_stake - total_apostado_no_jogo)
  a_expirar = min(em_falta, saldo_gastável)     ← nunca deixa o saldo negativo
  se a_expirar > 0:
    inserir chip_expiries(match_id, profile_id, a_expirar)   (1 por par, idempotente)
    inserir transação kind='expiry' com -a_expirar
```
- Corre **quando o jogo liquida** (chamada pelo `settle_market`; nessa altura o apito já soou e
  o total apostado no jogo está fechado). Idempotente via `UNIQUE (match_id, profile_id)`.
- As fichas expiradas aparecem no **detalhe do jogo** (`#/jogo/:id`) à vista de todos — é para picar.
  Antes de o jogo liquidar, o detalhe mostra a expiração **projetada** (quem apostou < mínimo).

### 4.4 `request_bailout(note)` / `approve_bailout(request_id)` — aprovação só admin
- Só pode pedir se saldo < `min_stake` e não tem pedido `pending`;
- Aprovação insere transação `kind='bailout'` (+`settings('bailout_chips')`) **e badge permanente `fmi`** ("💸 Financiado pelo FMI");
- O badge nunca é removido durante o torneio. É esse o ponto.

### 4.5 Badges automáticos (job/RPC `refresh_badges()` corrida após cada settlement)
| Code | Título | Regra |
|---|---|---|
| `rei` | 👑 Rei da Tabela | 1º do leaderboard (badge dinâmico, só um de cada vez) |
| `conservador` | 🧊 O Conservador | ≥ 10 apostas e ≥ 80% em mercados `low` |
| `lunatico` | 🌪️ O Lunático | ≥ 5 apostas e ≥ 60% em `resultado exato` |
| `anti_patria` | 🇵🇹 O Anti-Pátria | ≥ 3 apostas contra Portugal em jogos de Portugal |
| `sniper` | 🎯 Sniper | Acertou ≥ 1 resultado exato |
| `fmi` | 💸 Financiado pelo FMI | Pediu bailout (permanente, ver 4.4) |

---

## 5. Segurança — Row Level Security (o coração da app)

```sql
-- profiles: SELECT para todos os aprovados; UPDATE só do próprio (nome/avatar); is_admin/is_approved só via admin
-- transactions: SELECT das próprias; INSERT bloqueado (só RPCs SECURITY DEFINER)
-- matches, markets, market_options, settings: SELECT público (autenticado); escrita só admin
-- bailout_requests: INSERT/SELECT próprias; admin vê todas

-- bets: A POLICY MAIS IMPORTANTE — o segredo até ao apito
CREATE POLICY bets_select ON bets FOR SELECT USING (
  profile_id = auth.uid()                          -- a minha, sempre
  OR EXISTS (SELECT 1 FROM markets m
             WHERE m.id = bets.market_id
             AND now() >= m.closes_at)             -- as dos outros, só após o fecho
);
-- INSERT/UPDATE/DELETE em bets: bloqueado ao cliente; apenas via place_bet()
```

Checklist de batota a testar (o "primo QA"):
- [ ] Apostar depois do kickoff via chamada direta à API → rejeitado
- [ ] Ler apostas de outro jogador antes do kickoff via REST → 0 linhas
- [ ] Inserir transação a crédito próprio → rejeitado
- [ ] Apostar mais fichas do que o saldo → rejeitado
- [ ] Não-admin chamar `settle_market` / `approve_bailout` → rejeitado

---

## 6. Ecrãs (já desenhados no protótipo — mapa de dados)

| Ecrã (rota) | Função no protótipo | Dados reais |
|---|---|---|
| Login | `renderLogin()` | `signInWithOAuth('google')`; estado de sessão via `onAuthStateChange` |
| Jogos `#/jogos` | `renderJogos()` | `matches` + `market_pools` agregado por jogo; secção futures = `markets WHERE match_id IS NULL` |
| Detalhe `#/jogo/:id` | `renderJogoDetalhe()` | mercados+opções+pools; se `now()>=closes_at` mostra **livro aberto** (`bets` reveladas com nome/avatar). Nos mercados liquidados, cada apostador mostra **quanto ganhou** (pool betting, calculado no cliente). Secção **Fichas expiradas** = `chip_expiries` (reais) ou projeção do que falta ao mínimo por jogo |
| Boletim (slip) | `openSlip()/confirmBet()` | RPC `place_bet`; mostrar projeção `≈ pote_total * stake / (pool_opção + stake)` |
| Apostas `#/apostas` | `renderApostas()` | `bets` próprias join mercados/jogos; estado won/lost via `winning_option_id` |
| Classificação `#/classificacao` | `renderClassificacao()` | view leaderboard; realtime opcional (Supabase Realtime em `transactions`) |
| Perfil `#/perfil` | `renderPerfil()` | perfil + saldo + badges + stats; botão bailout (visível só se saldo < min_stake) |
| Admin `#/admin` | `renderAdmin()` | bailouts pendentes; jogos por liquidar (form: resultado + vencedor por mercado); criar jogo/mercados; aprovar jogadores |

**Ecrã admin de liquidação (não está no protótipo, desenhar simples):** lista de mercados do jogo,
cada um com as opções como botões — admin toca na vencedora, confirma, RPC `settle_market`. Introduzir
o resultado (`score_a/score_b`) primeiro e **pré-selecionar** vencedores óbvios (1X2, over/under,
resultado exato, ambas marcam) automaticamente; admin só confirma.

---

## 7. Criação de conteúdo (admin)

- Form "Criar jogo": equipas, bandeiras (emoji), fase, kickoff. Ao criar, **gerar automaticamente os
  mercados por defeito** via função SQL `create_match_with_markets(...)`. O conjunto é **global e
  configurável no painel de admin** (ecrã `#/mercados` → RPC `set_default_markets`), guardado em
  `settings('default_markets')` como array de nomes do catálogo `bet4fun.market_catalog(...)`
  (1X2, Mais/Menos 2.5, Ambas marcam, 1.ª a marcar, Cartão vermelho, Resultado exato, Decisão por
  penáltis — este último só abre nos jogos a eliminar). O valor inicial replica o conjunto enxuto
  original: **1X2**, **Mais/Menos 2.5**, **Resultado exato** (+ **penáltis** nos jogos a eliminar).
- RPC `apply_default_markets()` (admin): aplica a config aos jogos existentes que ainda não
  começaram, abrindo os mercados em falta. Nunca remove mercados já abertos (isso devolve apostas
  e faz-se jogo a jogo no "Editar jogo"). Devolve o nº de mercados abertos.
- Mercado "Resultado exato": opções fixas geradas (0-0 … 3-3 + "Outro") para o pool funcionar.
- Futures criados uma vez no seed (Campeão, Bota de Ouro, Equipa Sensação) com `closes_at` = kickoff do 1º jogo.

---

## 8. PWA

- `manifest.webmanifest` e `sw.js` já existem no repo.
- SW: cache-first **apenas para o shell**; dados do Supabase sempre network (nunca cachear respostas da API).
- Atualizações: bump do nome de cache `bet4fun-vN` a cada release.
- Ícones: `icons/icon.svg` existe; gerar `icon-192.png` e `icon-512.png` a partir dele (falta fazer).

---

## 9. Plano de implementação (por fases, com critérios de aceitação)

### M1 — Setup + Auth (½ dia)
- Projeto Supabase; Google OAuth configurado (Google Cloud Console + redirect URLs); schema §2 aplicado por migration; RLS ativo em todas as tabelas.
- ✅ Login com Google funciona no telemóvel; utilizador novo fica "à espera de aprovação"; admin aprova e o jogador recebe 1000 fichas.

### M2 — Jogos e apostas (1–2 dias)
- Ecrãs Jogos/Detalhe/Boletim ligados a dados reais; RPC `place_bet` com todas as validações; pools agregados visíveis.
- ✅ Apostar debita fichas; reapostar substitui; após kickoff é impossível apostar e o livro abre; checklist de batota (§5) passa.

### M3 — Liquidação (1 dia)
- Ecrã admin de resultados; `settle_market` + `void_market`; ecrã "As minhas apostas" com won/lost.
- ✅ Liquidar um jogo paga os potes corretamente (testar com o exemplo: pote 100, vencedores apostaram 40 ⇒ quem pôs 25 recebe 62).

### M4 — Leaderboard + Perfil + Bailout (1 dia)
- Leaderboard com deltas; perfil com stats; fluxo bailout completo com badge `fmi`.
- ✅ Tiago vai à falência, pede resgate, recebe 200 fichas e o badge da vergonha aparece no leaderboard.

### M5 — Picardia + polish (1 dia)
- Badges automáticos (§4.5); futures no UI; Supabase Realtime no leaderboard e nos pools; PNG icons; teste de instalação PWA (Android/iOS).
- ✅ App instalada no ecrã inicial, leaderboard atualiza sozinho quando o admin liquida um jogo.

### Fora de âmbito (v2, não fazer agora)
Chat interno (usa-se o WhatsApp), odds reais, notificações push, import automático de resultados de API de futebol, rollover de potes sem vencedor.

---

## 10. Decisões já tomadas (não reabrir)

1. **Pool betting** puro, sem odds — o prémio divide o pote proporcionalmente ao stake.
2. **Fichas = inteiros**, arredondamento por `floor`, resto para o maior apostador vencedor.
3. **Ninguém acerta ⇒ reembolso** (rollover fica para v2).
4. **1 aposta por mercado por jogador**, substituível até ao fecho.
5. **Resultado/golos contam o fim do jogo** — prolongamento incluído nos jogos a eliminar; exclui grandes penalidades (essas só contam para "Decisão por penáltis").
6. **Segredo individual até ao kickoff**, pools agregados públicos.
7. Badge do bailout é **permanente** durante o torneio.
8. Vanilla JS, sem framework, sem build step.
