-- =====================================================================
-- Bet4Fun — Migração 2026-07-03
-- Fichas apostadas ficam CATIVAS na classificação (não descontadas)
-- ---------------------------------------------------------------------
-- Antes: assim que apostavas, o stake saía do teu saldo e afundavas na
-- tabela. Agora: as fichas em mercados por liquidar (open/closed) contam
-- na tabela como valor cativo — só "desaparecem" quando o evento liquida
-- (aí pagas se perdeste, ou recebes o pote se ganhaste).
--
-- Só altera a VIEW `leaderboard` (acrescenta a coluna `locked` e soma o
-- cativo ao `chips`). O saldo gastável (view `balances`, usado no header e
-- no place_bet) MANTÉM-SE debitado — não podes reapostar o que está cativo.
--
-- Correr no SQL editor do Supabase. Idempotente (CREATE OR REPLACE).
-- =====================================================================

CREATE OR REPLACE VIEW bet4fun.leaderboard AS
  SELECT p.id, p.display_name, p.avatar_emoji,
         (COALESCE(bal.chips, 0) + COALESCE(lk.locked, 0)) AS chips,
         COALESCE(d.delta, 0)                              AS delta,
         COALESCE(bg.codes, '{}'::text[])                  AS badge_codes,
         -- coluna nova fica NO FIM: CREATE OR REPLACE VIEW não deixa
         -- inserir/renomear colunas existentes, só acrescentar no fim.
         COALESCE(lk.locked, 0)                            AS locked
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
