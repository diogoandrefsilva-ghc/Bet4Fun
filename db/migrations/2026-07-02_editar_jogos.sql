-- =====================================================================
-- Bet4Fun — Migração: editar jogos + gerir mercados no admin (2026-07-02)
-- Correr uma vez no SQL Editor do Supabase (BD já existente).
-- Numa BD limpa não é preciso: functions.sql já inclui estas funções.
-- =====================================================================

-- Atualizar um jogo (fase / kickoff). Os mercados abertos que fechavam ao
-- kickoff antigo passam a fechar ao novo.
CREATE OR REPLACE FUNCTION bet4fun.update_match(
  p_match_id bigint, p_stage text, p_kickoff_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = bet4fun AS $$
DECLARE v_old timestamptz;
BEGIN
  IF NOT bet4fun.is_admin() THEN RAISE EXCEPTION 'Apenas admin'; END IF;
  SELECT kickoff_at INTO v_old FROM matches WHERE id = p_match_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Jogo inexistente'; END IF;
  UPDATE matches
    SET stage      = COALESCE(NULLIF(btrim(p_stage), ''), stage),
        kickoff_at = COALESCE(p_kickoff_at, kickoff_at)
    WHERE id = p_match_id;
  IF p_kickoff_at IS NOT NULL AND p_kickoff_at <> v_old THEN
    UPDATE markets SET closes_at = p_kickoff_at
      WHERE match_id = p_match_id AND status = 'open' AND closes_at = v_old;
  END IF;
END; $$;

-- Adicionar um mercado a um jogo (fecha ao kickoff, como os restantes)
CREATE OR REPLACE FUNCTION bet4fun.add_market(
  p_match_id bigint, p_name text, p_risk text, p_options text[])
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = bet4fun AS $$
DECLARE v_kickoff timestamptz; v_mk bigint; i int;
BEGIN
  IF NOT bet4fun.is_admin() THEN RAISE EXCEPTION 'Apenas admin'; END IF;
  SELECT kickoff_at INTO v_kickoff FROM matches WHERE id = p_match_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Jogo inexistente'; END IF;
  IF p_name IS NULL OR btrim(p_name) = '' THEN RAISE EXCEPTION 'Nome do mercado em falta'; END IF;
  IF p_risk NOT IN ('low','mid','high') THEN RAISE EXCEPTION 'Risco inválido'; END IF;
  IF p_options IS NULL OR array_length(p_options, 1) < 2 THEN
    RAISE EXCEPTION 'O mercado precisa de pelo menos 2 opções';
  END IF;
  IF EXISTS (SELECT 1 FROM markets WHERE match_id = p_match_id AND name = btrim(p_name)) THEN
    RAISE EXCEPTION 'Esse mercado já existe neste jogo';
  END IF;
  INSERT INTO markets(match_id, name, risk, closes_at)
    VALUES (p_match_id, btrim(p_name), p_risk, v_kickoff) RETURNING id INTO v_mk;
  FOR i IN 1 .. array_length(p_options, 1) LOOP
    INSERT INTO market_options(market_id, label, sort) VALUES (v_mk, p_options[i], i - 1);
  END LOOP;
  RETURN v_mk;
END; $$;

-- Remover um mercado: devolve as apostas e apaga (opções/apostas em cascade).
-- Mercados já liquidados não podem ser removidos (os potes já foram pagos).
CREATE OR REPLACE FUNCTION bet4fun.remove_market(p_market_id bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = bet4fun AS $$
DECLARE v_market markets;
BEGIN
  IF NOT bet4fun.is_admin() THEN RAISE EXCEPTION 'Apenas admin'; END IF;
  SELECT * INTO v_market FROM markets WHERE id = p_market_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Mercado inexistente'; END IF;
  IF v_market.status = 'settled' THEN
    RAISE EXCEPTION 'Mercado já liquidado — não pode ser removido';
  END IF;
  INSERT INTO transactions(profile_id, amount, kind, ref_bet_id)
    SELECT profile_id, stake, 'refund', id FROM bets WHERE market_id = p_market_id;
  DELETE FROM markets WHERE id = p_market_id;
END; $$;

GRANT EXECUTE ON FUNCTION bet4fun.update_match(bigint, text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION bet4fun.add_market(bigint, text, text, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION bet4fun.remove_market(bigint) TO authenticated;
