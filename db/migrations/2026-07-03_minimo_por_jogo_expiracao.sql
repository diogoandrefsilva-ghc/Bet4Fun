-- =====================================================================
-- Bet4Fun — Migração 2026-07-03 (b)
-- Aposta MÍNIMA obrigatória por jogo + expiração das fichas em falta
-- ---------------------------------------------------------------------
-- Regra nova: para ninguém "adormecer" no topo da tabela sem arriscar,
-- cada jogador é OBRIGADO a apostar no mínimo `min_match_stake` fichas
-- (por defeito 100) em cada jogo. O que não apostar (100, ou o que
-- faltar para lá chegar) EXPIRA: sai do saldo e não volta.
--
-- Quando expira? Assim que o jogo é liquidado (o admin liquida o 1.º
-- mercado). Nessa altura já ninguém pode apostar (o apito já soou), por
-- isso o total apostado no jogo está fechado. É idempotente: liquidar
-- os restantes mercados do mesmo jogo não volta a cobrar.
--
-- As fichas expiradas ficam registadas em `chip_expiries` (visível no
-- detalhe do jogo, à vista de todos — é para picar) e no ledger como
-- transação `kind='expiry'`.
--
-- Correr no SQL editor do Supabase. Idempotente.
-- =====================================================================

-- 1) Setting: mínimo por jogo (fichas). 0 desliga a regra.
INSERT INTO bet4fun.settings (key, value) VALUES
  ('min_match_stake', '100'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 2) Novo tipo de transação no ledger: 'expiry' (débito de fichas expiradas)
ALTER TABLE bet4fun.transactions DROP CONSTRAINT IF EXISTS transactions_kind_check;
ALTER TABLE bet4fun.transactions ADD CONSTRAINT transactions_kind_check
  CHECK (kind IN ('initial','bet','payout','refund','bailout','admin_adjust','expiry'));

-- 3) Registo das fichas expiradas por jogo/jogador (1 por par)
CREATE TABLE IF NOT EXISTS bet4fun.chip_expiries (
  id         bigint GENERATED ALWAYS AS IDENTITY,
  match_id   bigint NOT NULL REFERENCES bet4fun.matches ON DELETE CASCADE,
  profile_id uuid   NOT NULL REFERENCES bet4fun.profiles ON DELETE CASCADE,
  amount     int    NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chip_expiries_pkey PRIMARY KEY (id),
  CONSTRAINT chip_expiries_unique UNIQUE (match_id, profile_id)
);
CREATE INDEX IF NOT EXISTS idx_expiries_match ON bet4fun.chip_expiries (match_id);

ALTER TABLE bet4fun.chip_expiries ENABLE ROW LEVEL SECURITY;

-- Visível: a minha sempre; admin tudo; as dos outros só depois do apito
-- (como as apostas). Na prática só existem depois da liquidação, mas a
-- política acompanha o "segredo até ao apito" por coerência.
DROP POLICY IF EXISTS expiries_select ON bet4fun.chip_expiries;
CREATE POLICY expiries_select ON bet4fun.chip_expiries
  FOR SELECT TO authenticated
  USING (
    profile_id = auth.uid()
    OR bet4fun.is_admin()
    OR EXISTS (SELECT 1 FROM bet4fun.matches mt
               WHERE mt.id = chip_expiries.match_id AND now() >= mt.kickoff_at)
  );

GRANT SELECT ON bet4fun.chip_expiries TO authenticated;

-- 4) RPC: expira as fichas em falta de um jogo (admin / interno)
--    Chamada automaticamente pelo settle_market. Idempotente.
CREATE OR REPLACE FUNCTION bet4fun.expire_match_shortfalls(p_match_id bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = bet4fun AS $$
DECLARE
  v_min     int := bet4fun.app_setting_int('min_match_stake', 100);
  v_kickoff timestamptz;
  r         record;
  v_expire  int;
  v_new     bigint;
BEGIN
  IF NOT bet4fun.is_admin() THEN RAISE EXCEPTION 'Apenas admin'; END IF;
  IF v_min <= 0 THEN RETURN; END IF;              -- regra desligada

  SELECT kickoff_at INTO v_kickoff FROM matches WHERE id = p_match_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Jogo inexistente'; END IF;
  IF now() < v_kickoff THEN RETURN; END IF;       -- ainda dá para apostar

  FOR r IN
    SELECT p.id                                        AS profile_id,
           GREATEST(0, v_min - COALESCE(st.staked, 0)) AS shortfall,
           GREATEST(0, COALESCE(bal.chips, 0))         AS spendable
    FROM profiles p
    LEFT JOIN (
      SELECT b.profile_id, SUM(b.stake)::int AS staked
      FROM bets b JOIN markets m ON m.id = b.market_id
      WHERE m.match_id = p_match_id
      GROUP BY b.profile_id
    ) st ON st.profile_id = p.id
    LEFT JOIN balances bal ON bal.profile_id = p.id
    WHERE p.is_approved
      AND p.created_at <= v_kickoff                 -- só quem já cá estava ao apito
      AND NOT EXISTS (SELECT 1 FROM chip_expiries e
                      WHERE e.match_id = p_match_id AND e.profile_id = p.id)
  LOOP
    v_new := NULL;                                  -- não arrastar o id da iteração anterior
    CONTINUE WHEN r.shortfall <= 0;                 -- cumpriu o mínimo
    v_expire := LEAST(r.shortfall, r.spendable);    -- nunca deixa o saldo negativo
    CONTINUE WHEN v_expire <= 0;                    -- teso, nada a tirar
    INSERT INTO chip_expiries(match_id, profile_id, amount)
      VALUES (p_match_id, r.profile_id, v_expire)
      ON CONFLICT (match_id, profile_id) DO NOTHING
      RETURNING id INTO v_new;
    IF v_new IS NOT NULL THEN
      INSERT INTO transactions(profile_id, amount, kind)
        VALUES (r.profile_id, -v_expire, 'expiry');
    END IF;
  END LOOP;
END; $$;

-- 5) Liquidar mercado passa a expirar as faltas do jogo (idempotente)
CREATE OR REPLACE FUNCTION bet4fun.settle_market(p_market_id bigint, p_winning_option_id bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = bet4fun AS $$
DECLARE
  v_market markets;
  v_pot_total int;
  v_pot_winner int;
  r record;
  v_paid int;
  v_remainder int;
  v_top_bet bigint;
BEGIN
  IF NOT bet4fun.is_admin() THEN RAISE EXCEPTION 'Apenas admin'; END IF;
  SELECT * INTO v_market FROM markets WHERE id = p_market_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Mercado inexistente'; END IF;
  IF v_market.status IN ('settled','void') THEN RETURN; END IF;   -- idempotente
  IF NOT EXISTS (SELECT 1 FROM market_options WHERE id = p_winning_option_id AND market_id = p_market_id) THEN
    RAISE EXCEPTION 'Opção vencedora inválida';
  END IF;

  SELECT COALESCE(SUM(stake), 0) INTO v_pot_total  FROM bets WHERE market_id = p_market_id;
  SELECT COALESCE(SUM(stake), 0) INTO v_pot_winner FROM bets WHERE market_id = p_market_id AND option_id = p_winning_option_id;

  IF v_pot_total = 0 THEN
    UPDATE markets SET status = 'settled', winning_option_id = p_winning_option_id WHERE id = p_market_id;
    IF v_market.match_id IS NOT NULL THEN PERFORM bet4fun.expire_match_shortfalls(v_market.match_id); END IF;
    RETURN;
  END IF;

  IF v_pot_winner = 0 THEN
    -- ninguém acertou: reembolso total (rollover fica para v2)
    INSERT INTO transactions(profile_id, amount, kind, ref_bet_id)
      SELECT profile_id, stake, 'refund', id FROM bets WHERE market_id = p_market_id;
  ELSE
    -- cada vencedor recebe floor(pot_total * stake / pot_winner)
    FOR r IN SELECT id, profile_id, stake FROM bets
             WHERE market_id = p_market_id AND option_id = p_winning_option_id LOOP
      INSERT INTO transactions(profile_id, amount, kind, ref_bet_id)
        VALUES (r.profile_id, floor(v_pot_total::numeric * r.stake / v_pot_winner), 'payout', r.id);
    END LOOP;
    -- resto de arredondamento → maior apostador vencedor (determinístico)
    SELECT COALESCE(SUM(floor(v_pot_total::numeric * stake / v_pot_winner)), 0)
      INTO v_paid FROM bets WHERE market_id = p_market_id AND option_id = p_winning_option_id;
    v_remainder := v_pot_total - v_paid;
    IF v_remainder > 0 THEN
      SELECT id INTO v_top_bet FROM bets
        WHERE market_id = p_market_id AND option_id = p_winning_option_id
        ORDER BY stake DESC, id ASC LIMIT 1;
      UPDATE transactions SET amount = amount + v_remainder
        WHERE ref_bet_id = v_top_bet AND kind = 'payout';
    END IF;
  END IF;

  UPDATE markets SET status = 'settled', winning_option_id = p_winning_option_id WHERE id = p_market_id;
  IF v_market.match_id IS NOT NULL THEN PERFORM bet4fun.expire_match_shortfalls(v_market.match_id); END IF;
  PERFORM bet4fun.refresh_badges();
END; $$;
