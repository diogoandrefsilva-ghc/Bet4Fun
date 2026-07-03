-- =====================================================================
-- Bet4Fun — Migração 2026-07-03 (2)
-- Fichas cativas passam a ser PRIVADAS na classificação
-- ---------------------------------------------------------------------
-- O quanto cada um tem apostado em jogos por liquidar é estratégia:
-- ninguém (nem o admin) deve conseguir ver o cativo dos outros. A view
-- `leaderboard` passa a devolver `locked` apenas para o próprio
-- (auth.uid()); para os restantes vem 0. O total `chips` continua a somar
-- o cativo de toda a gente — o valor na tabela não muda, só deixa de se
-- conseguir decompor.
--
-- Correr no SQL editor do Supabase. Idempotente (CREATE OR REPLACE).
-- =====================================================================

CREATE OR REPLACE VIEW bet4fun.leaderboard AS
  SELECT p.id, p.display_name, p.avatar_emoji,
         (COALESCE(bal.chips, 0) + COALESCE(lk.locked, 0)) AS chips,
         COALESCE(d.delta, 0)                              AS delta,
         COALESCE(bg.codes, '{}'::text[])                  AS badge_codes,
         -- cativo só visível ao próprio; para os outros devolve 0
         CASE WHEN p.id = auth.uid()
              THEN COALESCE(lk.locked, 0) ELSE 0 END       AS locked
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
  WHERE p.is_approved;
