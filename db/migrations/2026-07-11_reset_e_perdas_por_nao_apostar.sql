-- =====================================================================
-- Bet4Fun — Migração 2026-07-11
-- Reset da época (admin) + perdas por não apostar na classificação
-- ---------------------------------------------------------------------
-- 1) Nova RPC `reset_season()` (só admin): zera classificações e saldos —
--    apaga apostas, fichas expiradas, bailouts, badges e TODO o ledger, e
--    volta a creditar as fichas iniciais (settings('initial_chips'), por
--    defeito 1000) a cada jogador aprovado. Jogos e mercados ficam como
--    estão. IRREVERSÍVEL — o botão no painel de admin pede confirmação
--    dupla (escrever "RESET").
--
-- 2) A view `leaderboard` ganha a coluna `expired`: total de fichas que
--    cada jogador perdeu por não apostar o mínimo por jogo. É público
--    (as expirações já aparecem no detalhe de cada jogo — é para picar)
--    e alimenta a linha "perdeu 🪙 X por não apostar" na classificação.
--
-- Correr no SQL editor do Supabase. Idempotente (CREATE OR REPLACE).
-- =====================================================================

-- 1) Reset da época (admin). Devolve o nº de jogadores creditados.
CREATE OR REPLACE FUNCTION bet4fun.reset_season()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = bet4fun AS $$
DECLARE v_n int;
BEGIN
  IF NOT bet4fun.is_admin() THEN RAISE EXCEPTION 'Apenas admin'; END IF;
  DELETE FROM bets;
  DELETE FROM chip_expiries;
  DELETE FROM bailout_requests;
  DELETE FROM badges;
  DELETE FROM transactions;
  INSERT INTO transactions(profile_id, amount, kind)
    SELECT id, bet4fun.app_setting_int('initial_chips', 1000), 'initial'
    FROM profiles WHERE is_approved;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END; $$;

GRANT EXECUTE ON FUNCTION bet4fun.reset_season() TO authenticated;

-- 2) Leaderboard com o total de fichas expiradas por jogador.
--    Coluna nova fica NO FIM: CREATE OR REPLACE VIEW não deixa
--    inserir/renomear colunas existentes, só acrescentar no fim.
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
