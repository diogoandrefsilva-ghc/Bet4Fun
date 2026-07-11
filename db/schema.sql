-- =====================================================================
-- Bet4Fun — Schema DDL (bet4fun)
-- Projeto Supabase: diogoandrefsilva-personalapps-database
-- Fonte de verdade. Correr numa BD limpa, por esta ordem:
--   schema.sql -> functions.sql -> policies.sql
--
-- NOTA sobre IDs: ao contrário do FestasBV, aqui as colunas `id` usam
-- GENERATED ALWAYS AS IDENTITY. Motivo: TODA a escrita passa por RPCs
-- SECURITY DEFINER no servidor (place_bet, settle_market, ...) e há
-- inserções concorrentes (vários a apostar ao mesmo tempo) — a sequence
-- do Postgres garante IDs únicos sem race conditions. O cliente nunca
-- atribui IDs.
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS bet4fun;

-- ---------------------------------------------------------------------
-- Perfis (1:1 com auth.users, criado por trigger no signup)
-- ---------------------------------------------------------------------
CREATE TABLE bet4fun.profiles (
  id           uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  display_name text NOT NULL,
  avatar_emoji text NOT NULL DEFAULT '⚽',
  is_admin     boolean NOT NULL DEFAULT false,
  is_approved  boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profiles_pkey PRIMARY KEY (id)
);

-- ---------------------------------------------------------------------
-- Configuração global (key-value)
--   initial_chips · bailout_chips · min_stake · min_match_stake ·
--   house_stake · show_pools_before_kickoff · admin_email
-- ---------------------------------------------------------------------
CREATE TABLE bet4fun.settings (
  key   text NOT NULL,
  value jsonb NOT NULL,
  CONSTRAINT settings_pkey PRIMARY KEY (key)
);

INSERT INTO bet4fun.settings (key, value) VALUES
  ('initial_chips',             '1000'::jsonb),
  ('bailout_chips',             '200'::jsonb),
  ('min_stake',                 '5'::jsonb),
  ('min_match_stake',           '100'::jsonb),   -- aposta mínima obrigatória por jogo (o resto expira; 0 desliga)
  ('house_stake',               '50'::jsonb),    -- "aposta da casa": fichas fixas que a casa mete em cada mercado, não presas a nenhuma opção, e que engordam sempre o pote de quem acertar (settle_market); 0 desliga
  ('default_markets',           '["Resultado (1X2)","Mais/Menos 2.5 golos","Resultado exato","Decisão por penáltis"]'::jsonb),  -- mercados abertos em cada jogo novo (nomes do catálogo; penáltis só nos jogos a eliminar)
  ('show_pools_before_kickoff', 'true'::jsonb),
  ('admin_email',               '"diogo.andre.f.silva@gmail.com"'::jsonb)   -- <<< TROCA se preciso
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------
-- Ledger de fichas. O saldo NUNCA é uma coluna editável: é a soma
-- do ledger (ver view bet4fun.balances). Escrita só via RPCs.
-- ---------------------------------------------------------------------
CREATE TABLE bet4fun.transactions (
  id         bigint GENERATED ALWAYS AS IDENTITY,
  profile_id uuid NOT NULL REFERENCES bet4fun.profiles ON DELETE CASCADE,
  amount     int NOT NULL,
  kind       text NOT NULL,
  ref_bet_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transactions_pkey PRIMARY KEY (id),
  CONSTRAINT transactions_kind_check CHECK (kind IN ('initial','bet','payout','refund','bailout','admin_adjust','expiry'))
);
CREATE INDEX idx_tx_profile ON bet4fun.transactions (profile_id);

-- ---------------------------------------------------------------------
-- Jogos
-- ---------------------------------------------------------------------
CREATE TABLE bet4fun.matches (
  id         bigint GENERATED ALWAYS AS IDENTITY,
  stage      text NOT NULL,
  team_a     text NOT NULL,
  flag_a     text,
  team_b     text NOT NULL,
  flag_b     text,
  kickoff_at timestamptz NOT NULL,          -- fecho das apostas = kickoff_at
  score_a    int,
  score_b    int,                           -- fim do jogo (prolong. incl., sem penáltis)
  status     text NOT NULL DEFAULT 'scheduled',
  CONSTRAINT matches_pkey PRIMARY KEY (id),
  CONSTRAINT matches_status_check CHECK (status IN ('scheduled','live','finished','settled'))
);

-- ---------------------------------------------------------------------
-- Mercados (match_id NULL = future / longo prazo)
-- ---------------------------------------------------------------------
CREATE TABLE bet4fun.markets (
  id                bigint GENERATED ALWAYS AS IDENTITY,
  match_id          bigint REFERENCES bet4fun.matches ON DELETE CASCADE,
  name              text NOT NULL,
  risk              text NOT NULL,
  closes_at         timestamptz NOT NULL,
  status            text NOT NULL DEFAULT 'open',
  winning_option_id bigint,
  CONSTRAINT markets_pkey PRIMARY KEY (id),
  CONSTRAINT markets_risk_check CHECK (risk IN ('low','mid','high','future')),
  CONSTRAINT markets_status_check CHECK (status IN ('open','closed','settled','void'))
);
CREATE INDEX idx_markets_match ON bet4fun.markets (match_id);

CREATE TABLE bet4fun.market_options (
  id        bigint GENERATED ALWAYS AS IDENTITY,
  market_id bigint NOT NULL REFERENCES bet4fun.markets ON DELETE CASCADE,
  label     text NOT NULL,
  sort      int NOT NULL DEFAULT 0,
  CONSTRAINT market_options_pkey PRIMARY KEY (id)
);
CREATE INDEX idx_opts_market ON bet4fun.market_options (market_id);

-- ---------------------------------------------------------------------
-- Apostas (1 por jogador por mercado, substituível até ao fecho)
-- ---------------------------------------------------------------------
CREATE TABLE bet4fun.bets (
  id         bigint GENERATED ALWAYS AS IDENTITY,
  profile_id uuid NOT NULL REFERENCES bet4fun.profiles ON DELETE CASCADE,
  market_id  bigint NOT NULL REFERENCES bet4fun.markets ON DELETE CASCADE,
  option_id  bigint NOT NULL REFERENCES bet4fun.market_options ON DELETE CASCADE,
  stake      int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bets_pkey PRIMARY KEY (id),
  CONSTRAINT bets_stake_check CHECK (stake > 0),
  CONSTRAINT bets_one_per_market UNIQUE (profile_id, market_id)
);
CREATE INDEX idx_bets_market ON bet4fun.bets (market_id);

-- ---------------------------------------------------------------------
-- Fichas expiradas por jogo. Cada jogador é obrigado a apostar no mínimo
-- settings('min_match_stake') fichas em cada jogo; o que faltar EXPIRA
-- quando o jogo é liquidado (débito no ledger + linha aqui). 1 por par.
-- ---------------------------------------------------------------------
CREATE TABLE bet4fun.chip_expiries (
  id         bigint GENERATED ALWAYS AS IDENTITY,
  match_id   bigint NOT NULL REFERENCES bet4fun.matches ON DELETE CASCADE,
  profile_id uuid   NOT NULL REFERENCES bet4fun.profiles ON DELETE CASCADE,
  amount     int    NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chip_expiries_pkey PRIMARY KEY (id),
  CONSTRAINT chip_expiries_amount_check CHECK (amount > 0),
  CONSTRAINT chip_expiries_unique UNIQUE (match_id, profile_id)
);
CREATE INDEX idx_expiries_match ON bet4fun.chip_expiries (match_id);

-- ---------------------------------------------------------------------
-- Pedidos de resgate (bailout)
-- ---------------------------------------------------------------------
CREATE TABLE bet4fun.bailout_requests (
  id         bigint GENERATED ALWAYS AS IDENTITY,
  profile_id uuid NOT NULL REFERENCES bet4fun.profiles ON DELETE CASCADE,
  note       text,
  status     text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bailout_requests_pkey PRIMARY KEY (id),
  CONSTRAINT bailout_status_check CHECK (status IN ('pending','approved','rejected'))
);

-- ---------------------------------------------------------------------
-- Badges / títulos (fmi, conservador, lunatico, anti_patria, rei, sniper)
-- ---------------------------------------------------------------------
CREATE TABLE bet4fun.badges (
  id         bigint GENERATED ALWAYS AS IDENTITY,
  profile_id uuid NOT NULL REFERENCES bet4fun.profiles ON DELETE CASCADE,
  code       text NOT NULL,
  awarded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT badges_pkey PRIMARY KEY (id),
  CONSTRAINT badges_unique UNIQUE (profile_id, code)
);

-- ---------------------------------------------------------------------
-- Row Level Security ativa em todas as tabelas (policies em policies.sql)
-- ---------------------------------------------------------------------
ALTER TABLE bet4fun.profiles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE bet4fun.settings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE bet4fun.transactions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE bet4fun.matches          ENABLE ROW LEVEL SECURITY;
ALTER TABLE bet4fun.markets          ENABLE ROW LEVEL SECURITY;
ALTER TABLE bet4fun.market_options   ENABLE ROW LEVEL SECURITY;
ALTER TABLE bet4fun.bets             ENABLE ROW LEVEL SECURITY;
ALTER TABLE bet4fun.chip_expiries    ENABLE ROW LEVEL SECURITY;
ALTER TABLE bet4fun.bailout_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE bet4fun.badges           ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- Views (agregados públicos). Correm como owner → contornam a RLS das
-- tabelas base, por isso os potes agregados e os saldos são visíveis a
-- todos SEM revelar apostas individuais (essas ficam gatadas na tabela bets).
-- ---------------------------------------------------------------------

-- Saldo por jogador (soma do ledger)
CREATE OR REPLACE VIEW bet4fun.balances AS
  SELECT p.id AS profile_id, COALESCE(SUM(t.amount), 0)::int AS chips
  FROM bet4fun.profiles p
  LEFT JOIN bet4fun.transactions t ON t.profile_id = p.id
  GROUP BY p.id;

-- Pote por opção de mercado (para mostrar "🪙 X no pote" sem revelar quem apostou)
CREATE OR REPLACE VIEW bet4fun.market_pools AS
  SELECT market_id, option_id, SUM(stake)::int AS pool, COUNT(*)::int AS n_bets
  FROM bet4fun.bets
  GROUP BY market_id, option_id;

-- Pote total por mercado
CREATE OR REPLACE VIEW bet4fun.market_totals AS
  SELECT market_id, SUM(stake)::int AS pot, COUNT(*)::int AS n_bets
  FROM bet4fun.bets
  GROUP BY market_id;

-- Pote total por jogo
CREATE OR REPLACE VIEW bet4fun.match_pots AS
  SELECT m.match_id, COALESCE(SUM(b.stake), 0)::int AS pot
  FROM bet4fun.markets m
  LEFT JOIN bet4fun.bets b ON b.market_id = m.id
  WHERE m.match_id IS NOT NULL
  GROUP BY m.match_id;

-- Leaderboard: valor total (saldo + fichas cativas) + delta + badges
--   As fichas apostadas em mercados por liquidar (open/closed) NÃO são
--   descontadas na tabela — ficam CATIVAS e voltam a contar como valor do
--   jogador até o evento liquidar. O saldo gastável (view balances) já foi
--   debitado no place_bet; aqui somamos de volta o que está cativo.
--   O delta recente ignora o vai-e-vem do cativo (bet/refund) — só conta
--   ganhos realizados (payout/bailout/admin_adjust) para não "afundar" a
--   tabela quando alguém aposta.
--   O `locked` é PRIVADO: só o próprio vê o seu cativo (o que cada um tem
--   em jogo é estratégia); para os outros devolve 0.
--   O `expired` é o total de fichas perdidas por não apostar o mínimo por
--   jogo — PÚBLICO (as expirações já aparecem no detalhe de cada jogo; é
--   para picar).
CREATE OR REPLACE VIEW bet4fun.leaderboard AS
  SELECT p.id, p.display_name, p.avatar_emoji,
         (COALESCE(bal.chips, 0) + COALESCE(lk.locked, 0)) AS chips,
         COALESCE(d.delta, 0)                              AS delta,
         COALESCE(bg.codes, '{}'::text[])                  AS badge_codes,
         CASE WHEN p.id = auth.uid()
              THEN COALESCE(lk.locked, 0) ELSE 0 END       AS locked,
         COALESCE(ex.expired, 0)                           AS expired
  FROM bet4fun.profiles p
  LEFT JOIN bet4fun.balances bal ON bal.profile_id = p.id
  LEFT JOIN (
    SELECT b.profile_id, SUM(b.stake)::int AS locked
    FROM bet4fun.bets b
    JOIN bet4fun.markets m ON m.id = b.market_id
    WHERE m.status IN ('open', 'closed')
    GROUP BY b.profile_id
  ) lk ON lk.profile_id = p.id
  LEFT JOIN (
    SELECT profile_id, SUM(amount)::int AS delta
    FROM bet4fun.transactions
    WHERE created_at >= now() - interval '24 hours'
      AND kind IN ('payout', 'bailout', 'admin_adjust')
    GROUP BY profile_id
  ) d ON d.profile_id = p.id
  LEFT JOIN (
    SELECT profile_id, array_agg(code ORDER BY code) AS codes
    FROM bet4fun.badges
    GROUP BY profile_id
  ) bg ON bg.profile_id = p.id
  LEFT JOIN (
    SELECT profile_id, SUM(amount)::int AS expired
    FROM bet4fun.chip_expiries
    GROUP BY profile_id
  ) ex ON ex.profile_id = p.id
  WHERE p.is_approved;
