-- =====================================================================
-- Migração: "aposta da casa" (bet4fun)
-- Aplicar numa BD já existente, depois de schema.sql + functions.sql.
-- Idempotente.
--
-- Duas regras (ver comentário completo em functions.sql/settle_market):
--   1. Mercados normais: settings('house_stake') fichas (por defeito 50)
--      só entram quando pot_vencedor = pot_total (só apostou 1 pessoa, ou
--      toda a gente apostou no mesmo palpite, e saiu certo) — sem isto
--      seria um "reembolso" disfarçado. Quando há mistura real de
--      vencedores e perdedores, a casa não entra (já há lucro do pote).
--   2. "Resultado exato": settings('house_stake_exact') fichas (por
--      defeito 200) entram SEMPRE que há vencedor, multiplicadas pelo
--      nº de apostas feitas no mercado — o Jackpot cresce com a malta.
-- Se ninguém acertar continua a ser reembolso total — a casa não paga.
-- =====================================================================

INSERT INTO bet4fun.settings (key, value) VALUES
  ('house_stake', '50'::jsonb)
ON CONFLICT (key) DO NOTHING;

INSERT INTO bet4fun.settings (key, value) VALUES
  ('house_stake_exact', '200'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION bet4fun.settle_market(p_market_id bigint, p_winning_option_id bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = bet4fun AS $$
DECLARE
  v_market markets;
  v_pot_total int;
  v_pot_winner int;
  v_pot_paid int;
  v_house int;
  v_n_bets int;
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

  SELECT COALESCE(SUM(stake), 0), COUNT(*) INTO v_pot_total, v_n_bets FROM bets WHERE market_id = p_market_id;
  SELECT COALESCE(SUM(stake), 0) INTO v_pot_winner FROM bets WHERE market_id = p_market_id AND option_id = p_winning_option_id;

  IF v_pot_total = 0 THEN
    UPDATE markets SET status = 'settled', winning_option_id = p_winning_option_id WHERE id = p_market_id;
    IF v_market.match_id IS NOT NULL THEN PERFORM bet4fun.expire_match_shortfalls(v_market.match_id); END IF;
    RETURN;
  END IF;

  IF v_pot_winner = 0 THEN
    -- ninguém acertou: reembolso total (rollover fica para v2; a casa não paga aqui)
    INSERT INTO transactions(profile_id, amount, kind, ref_bet_id)
      SELECT profile_id, stake, 'refund', id FROM bets WHERE market_id = p_market_id;
  ELSE
    IF v_market.name ILIKE 'Resultado exato%' THEN
      v_house := bet4fun.app_setting_int('house_stake_exact', 200) * v_n_bets;
    ELSIF v_pot_winner = v_pot_total THEN
      v_house := bet4fun.app_setting_int('house_stake', 50);
    ELSE
      v_house := 0;
    END IF;
    v_pot_paid := v_pot_total + GREATEST(v_house, 0);   -- pote real + bónus da casa
    -- cada vencedor recebe floor(pot_paid * stake / pot_winner)
    FOR r IN SELECT id, profile_id, stake FROM bets
             WHERE market_id = p_market_id AND option_id = p_winning_option_id LOOP
      INSERT INTO transactions(profile_id, amount, kind, ref_bet_id)
        VALUES (r.profile_id, floor(v_pot_paid::numeric * r.stake / v_pot_winner), 'payout', r.id);
    END LOOP;
    -- resto de arredondamento → maior apostador vencedor (determinístico)
    SELECT COALESCE(SUM(floor(v_pot_paid::numeric * stake / v_pot_winner)), 0)
      INTO v_paid FROM bets WHERE market_id = p_market_id AND option_id = p_winning_option_id;
    v_remainder := v_pot_paid - v_paid;
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
