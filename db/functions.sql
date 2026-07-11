-- =====================================================================
-- Bet4Fun — Funções, RPCs e Triggers (bet4fun)
-- Correr DEPOIS de schema.sql e ANTES de policies.sql.
--
-- Princípio (SPECS §1): o cliente nunca escreve saldos, nunca liquida
-- mercados e nunca lê apostas alheias antes do apito. Toda a escrita
-- sensível passa por estas funções SECURITY DEFINER + pela RLS.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

-- lê um setting inteiro com fallback
CREATE OR REPLACE FUNCTION bet4fun.app_setting_int(p_key text, p_default int)
RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = bet4fun AS $$
  SELECT COALESCE((SELECT (value #>> '{}')::int FROM settings WHERE key = p_key), p_default);
$$;

-- é o utilizador atual admin? (SECURITY DEFINER evita recursão de RLS)
CREATE OR REPLACE FUNCTION bet4fun.is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = bet4fun AS $$
  SELECT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin);
$$;

-- ---------------------------------------------------------------------
-- RPCs de jogo
-- ---------------------------------------------------------------------

-- Apostar (upsert; substitui a aposta anterior no mesmo mercado até ao fecho)
CREATE OR REPLACE FUNCTION bet4fun.place_bet(p_market_id bigint, p_option_id bigint, p_stake int)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = bet4fun AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_market markets;
  v_min int;
  v_bal int;
  v_old bets;
  v_bet_id bigint;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Não autenticado'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_uid AND is_approved) THEN
    RAISE EXCEPTION 'Jogador não aprovado';
  END IF;

  SELECT * INTO v_market FROM markets WHERE id = p_market_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Mercado inexistente'; END IF;
  IF v_market.status <> 'open' OR now() >= v_market.closes_at THEN
    RAISE EXCEPTION 'Mercado fechado';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM market_options WHERE id = p_option_id AND market_id = p_market_id) THEN
    RAISE EXCEPTION 'Opção inválida';
  END IF;

  v_min := bet4fun.app_setting_int('min_stake', 5);
  IF p_stake < v_min THEN RAISE EXCEPTION 'Aposta mínima: % fichas', v_min; END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_bal FROM transactions WHERE profile_id = v_uid;
  SELECT * INTO v_old FROM bets WHERE profile_id = v_uid AND market_id = p_market_id;

  -- se re-apostar, o stake antigo é devolvido antes de validar
  IF p_stake > v_bal + COALESCE(v_old.stake, 0) THEN
    RAISE EXCEPTION 'Fichas insuficientes';
  END IF;

  IF v_old.id IS NOT NULL THEN
    INSERT INTO transactions(profile_id, amount, kind, ref_bet_id)
      VALUES (v_uid, v_old.stake, 'refund', v_old.id);
    UPDATE bets SET option_id = p_option_id, stake = p_stake, created_at = now()
      WHERE id = v_old.id RETURNING id INTO v_bet_id;
  ELSE
    INSERT INTO bets(profile_id, market_id, option_id, stake)
      VALUES (v_uid, p_market_id, p_option_id, p_stake) RETURNING id INTO v_bet_id;
  END IF;

  INSERT INTO transactions(profile_id, amount, kind, ref_bet_id)
    VALUES (v_uid, -p_stake, 'bet', v_bet_id);
END; $$;

-- Introduzir resultado (admin)
CREATE OR REPLACE FUNCTION bet4fun.set_match_result(p_match_id bigint, p_score_a int, p_score_b int)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = bet4fun AS $$
BEGIN
  IF NOT bet4fun.is_admin() THEN RAISE EXCEPTION 'Apenas admin'; END IF;
  UPDATE matches SET score_a = p_score_a, score_b = p_score_b, status = 'finished'
    WHERE id = p_match_id;
END; $$;

-- Liquidar mercado — pool betting (admin)
--
-- "Aposta da casa": fichas que a casa mete no pote a dividir por quem
-- acertar — não presas a nenhuma opção, não debitadas a ninguém (a casa
-- não tem saldo nem transação própria). Duas regras:
--
--   1. Mercados normais: só entra settings('house_stake') fichas (por
--      defeito 50) quando pot_vencedor = pot_total, ou seja, só apostou
--      uma pessoa (e acertou) ou toda a gente apostou no mesmo palpite
--      (e saiu certo). Sem a casa, esses vencedores limitar-se-iam a
--      reaver o que puseram — um "reembolso" disfarçado. Quando há uma
--      mistura real de vencedores e perdedores, os vencedores já lucram
--      à custa de quem perdeu — a casa não entra.
--   2. "Resultado exato" (o Jackpot, risco alto e raro de acertar): a casa
--      entra SEMPRE que há vencedor, com settings('house_stake_exact')
--      (por defeito 200) fichas POR CADA aposta feita no mercado — quanto
--      mais gente jogar, maior o jackpot para quem acertar o resultado.
--
-- Em qualquer caso, se ninguém acertar (pot_vencedor = 0) continua a ser
-- reembolso total — não há a quem dar o bónus da casa.
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

-- Expira as fichas em falta de um jogo (aposta mínima obrigatória).
-- Cada jogador é obrigado a apostar no mínimo settings('min_match_stake')
-- em cada jogo; o que faltar sai do saldo (kind='expiry') e fica registado
-- em chip_expiries. Chamada pelo settle_market. Idempotente (1 linha por
-- par jogo/jogador; corre depois do apito, quando o total apostado já
-- está fechado). Nunca deixa o saldo negativo (limita ao saldo gastável).
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

-- Anular mercado — reembolso total (admin)
CREATE OR REPLACE FUNCTION bet4fun.void_market(p_market_id bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = bet4fun AS $$
DECLARE v_market markets;
BEGIN
  IF NOT bet4fun.is_admin() THEN RAISE EXCEPTION 'Apenas admin'; END IF;
  SELECT * INTO v_market FROM markets WHERE id = p_market_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Mercado inexistente'; END IF;
  IF v_market.status IN ('settled','void') THEN RETURN; END IF;
  INSERT INTO transactions(profile_id, amount, kind, ref_bet_id)
    SELECT profile_id, stake, 'refund', id FROM bets WHERE market_id = p_market_id;
  UPDATE markets SET status = 'void' WHERE id = p_market_id;
END; $$;

-- ---------------------------------------------------------------------
-- RPCs de bailout / jogadores
-- ---------------------------------------------------------------------

-- Pedir resgate
CREATE OR REPLACE FUNCTION bet4fun.request_bailout(p_note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = bet4fun AS $$
DECLARE v_uid uuid := auth.uid(); v_bal int; v_min int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Não autenticado'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_uid AND is_approved) THEN
    RAISE EXCEPTION 'Jogador não aprovado';
  END IF;
  v_min := bet4fun.app_setting_int('min_stake', 5);
  SELECT COALESCE(SUM(amount), 0) INTO v_bal FROM transactions WHERE profile_id = v_uid;
  IF v_bal >= v_min THEN RAISE EXCEPTION 'Ainda tens fichas para jogar'; END IF;
  IF EXISTS (SELECT 1 FROM bailout_requests WHERE profile_id = v_uid AND status = 'pending') THEN
    RAISE EXCEPTION 'Já tens um pedido pendente';
  END IF;
  INSERT INTO bailout_requests(profile_id, note) VALUES (v_uid, p_note);
END; $$;

-- Aprovar resgate (admin) — dá fichas + badge permanente 'fmi'
CREATE OR REPLACE FUNCTION bet4fun.approve_bailout(p_request_id bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = bet4fun AS $$
DECLARE v_req bailout_requests;
BEGIN
  IF NOT bet4fun.is_admin() THEN RAISE EXCEPTION 'Apenas admin'; END IF;
  SELECT * INTO v_req FROM bailout_requests WHERE id = p_request_id AND status = 'pending' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pedido inexistente ou já tratado'; END IF;
  UPDATE bailout_requests SET status = 'approved' WHERE id = p_request_id;
  INSERT INTO transactions(profile_id, amount, kind)
    VALUES (v_req.profile_id, bet4fun.app_setting_int('bailout_chips', 200), 'bailout');
  INSERT INTO badges(profile_id, code) VALUES (v_req.profile_id, 'fmi')
    ON CONFLICT (profile_id, code) DO NOTHING;
END; $$;

-- Aprovar jogador (admin) — dá fichas iniciais uma vez
CREATE OR REPLACE FUNCTION bet4fun.approve_player(p_profile_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = bet4fun AS $$
DECLARE v_rows int;
BEGIN
  IF NOT bet4fun.is_admin() THEN RAISE EXCEPTION 'Apenas admin'; END IF;
  UPDATE profiles SET is_approved = true WHERE id = p_profile_id AND is_approved = false;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows > 0 THEN
    INSERT INTO transactions(profile_id, amount, kind)
      VALUES (p_profile_id, bet4fun.app_setting_int('initial_chips', 1000), 'initial');
  END IF;
END; $$;

-- Reset da época (admin) — zera classificações e saldos. Apaga TODAS as
-- apostas, fichas expiradas, pedidos de bailout, badges e o ledger inteiro,
-- e volta a creditar as fichas iniciais (settings('initial_chips'), por
-- defeito 1000) a cada jogador aprovado. Os jogos e mercados ficam como
-- estão: os abertos voltam a aceitar apostas, os liquidados ficam como
-- histórico (sem livro). IRREVERSÍVEL. Devolve o nº de jogadores creditados.
-- Aplicar numa BD já existente: db/migrations/2026-07-11_reset_e_perdas_por_nao_apostar.sql
CREATE OR REPLACE FUNCTION bet4fun.reset_season()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = bet4fun AS $$
DECLARE v_n int;
BEGIN
  IF NOT bet4fun.is_admin() THEN RAISE EXCEPTION 'Apenas admin'; END IF;
  -- WHERE true: o projeto tem a extensão pg-safeupdate ativa, que bloqueia
  -- DELETE/UPDATE sem WHERE (mesmo dentro de SECURITY DEFINER).
  DELETE FROM bets WHERE true;
  DELETE FROM chip_expiries WHERE true;
  DELETE FROM bailout_requests WHERE true;
  DELETE FROM badges WHERE true;
  DELETE FROM transactions WHERE true;
  INSERT INTO transactions(profile_id, amount, kind)
    SELECT id, bet4fun.app_setting_int('initial_chips', 1000), 'initial'
    FROM profiles WHERE is_approved;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END; $$;

-- ---------------------------------------------------------------------
-- Criação de conteúdo (admin)
-- ---------------------------------------------------------------------

-- Catálogo de mercados por jogo (fonte de verdade para a geração automática;
-- espelhado no MARKET_CATALOG do js/app.js, que serve só para desenhar o UI).
-- Os mercados knockout_only só abrem nos jogos a eliminar.
CREATE OR REPLACE FUNCTION bet4fun.market_catalog(p_team_a text, p_team_b text)
RETURNS TABLE(pos int, name text, risk text, knockout_only boolean, options text[])
LANGUAGE sql IMMUTABLE AS $$
  VALUES
    (1, 'Resultado (1X2)',         'low',  false, ARRAY[p_team_a, 'Empate', p_team_b]),
    (2, 'Mais/Menos 2.5 golos',    'low',  false, ARRAY['Mais 2.5', 'Menos 2.5']),
    (3, 'Ambas marcam',            'low',  false, ARRAY['Sim', 'Não']),
    (4, '1.ª equipa a marcar',     'mid',  false, ARRAY[p_team_a, p_team_b, 'Sem golos']),
    (5, 'Cartão vermelho no jogo', 'mid',  false, ARRAY['Sim', 'Não']),
    (6, 'Resultado exato',         'high', false, ARRAY['0-0','1-0','0-1','1-1','2-0','0-2','2-1','1-2','2-2','3-0','0-3','3-1','1-3','3-2','2-3','3-3','Outro']),
    (7, 'Decisão por penáltis',    'high', true,  ARRAY['Sim', 'Não'])
$$;

-- Nomes dos mercados por defeito (lê settings('default_markets');
-- fallback = conjunto enxuto original)
CREATE OR REPLACE FUNCTION bet4fun.default_market_names()
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = bet4fun AS $$
  SELECT COALESCE(
    (SELECT array_agg(x.v)
     FROM settings s, jsonb_array_elements_text(s.value) AS x(v)
     WHERE s.key = 'default_markets' AND jsonb_typeof(s.value) = 'array'),
    ARRAY['Resultado (1X2)', 'Mais/Menos 2.5 golos', 'Resultado exato', 'Decisão por penáltis']
  );
$$;

-- Guardar os mercados por defeito (admin). Valida contra o catálogo e
-- guarda na ordem do catálogo (deduplica de borla).
CREATE OR REPLACE FUNCTION bet4fun.set_default_markets(p_names text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = bet4fun AS $$
DECLARE v_valid text[]; v_bad text;
BEGIN
  IF NOT bet4fun.is_admin() THEN RAISE EXCEPTION 'Apenas admin'; END IF;
  IF p_names IS NULL OR array_length(p_names, 1) IS NULL THEN
    RAISE EXCEPTION 'Escolhe pelo menos um mercado';
  END IF;

  SELECT n INTO v_bad FROM unnest(p_names) AS n
    WHERE n NOT IN (SELECT cat.name FROM bet4fun.market_catalog('A', 'B') cat)
    LIMIT 1;
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'Mercado desconhecido: %', v_bad; END IF;

  SELECT array_agg(cat.name ORDER BY cat.pos) INTO v_valid
    FROM bet4fun.market_catalog('A', 'B') cat WHERE cat.name = ANY (p_names);
  IF NOT EXISTS (SELECT 1 FROM bet4fun.market_catalog('A', 'B') cat
                 WHERE cat.name = ANY (v_valid) AND NOT cat.knockout_only) THEN
    RAISE EXCEPTION 'Escolhe pelo menos um mercado que não seja só de eliminatórias';
  END IF;

  INSERT INTO settings(key, value) VALUES ('default_markets', to_jsonb(v_valid))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
END; $$;

-- Criar jogo + mercados por defeito (config em settings('default_markets');
-- ver SPECS §7). Os knockout_only só entram nos jogos a eliminar.
CREATE OR REPLACE FUNCTION bet4fun.create_match_with_markets(
  p_stage text, p_team_a text, p_flag_a text, p_team_b text, p_flag_b text,
  p_kickoff_at timestamptz, p_knockout boolean DEFAULT false)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = bet4fun AS $$
DECLARE v_match bigint; v_names text[]; c record; v_mk bigint; i int;
BEGIN
  IF NOT bet4fun.is_admin() THEN RAISE EXCEPTION 'Apenas admin'; END IF;

  INSERT INTO matches(stage, team_a, flag_a, team_b, flag_b, kickoff_at)
    VALUES (p_stage, p_team_a, p_flag_a, p_team_b, p_flag_b, p_kickoff_at)
    RETURNING id INTO v_match;

  v_names := bet4fun.default_market_names();
  FOR c IN SELECT * FROM bet4fun.market_catalog(p_team_a, p_team_b) cat
           WHERE cat.name = ANY (v_names) ORDER BY cat.pos LOOP
    CONTINUE WHEN c.knockout_only AND NOT p_knockout;
    INSERT INTO markets(match_id, name, risk, closes_at)
      VALUES (v_match, c.name, c.risk, p_kickoff_at) RETURNING id INTO v_mk;
    FOR i IN 1 .. array_length(c.options, 1) LOOP
      INSERT INTO market_options(market_id, label, sort) VALUES (v_mk, c.options[i], i - 1);
    END LOOP;
  END LOOP;

  RETURN v_match;
END; $$;

-- Aplicar a config aos jogos existentes que ainda não começaram: abre os
-- mercados por defeito em falta. Não remove nenhum mercado já aberto
-- (remoções devolvem apostas — fazem-se jogo a jogo no "Editar jogo").
-- Devolve o nº de mercados abertos.
CREATE OR REPLACE FUNCTION bet4fun.apply_default_markets()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = bet4fun AS $$
DECLARE
  v_names text[] := bet4fun.default_market_names();
  m record; c record; v_mk bigint; i int; v_n int := 0; v_knockout boolean;
BEGIN
  IF NOT bet4fun.is_admin() THEN RAISE EXCEPTION 'Apenas admin'; END IF;
  FOR m IN SELECT * FROM matches WHERE status = 'scheduled' AND kickoff_at > now() LOOP
    v_knockout := m.stage NOT ILIKE '%grupo%';   -- 'Fase de grupos' vs eliminatórias
    FOR c IN SELECT * FROM bet4fun.market_catalog(m.team_a, m.team_b) cat
             WHERE cat.name = ANY (v_names) ORDER BY cat.pos LOOP
      CONTINUE WHEN c.knockout_only AND NOT v_knockout;
      CONTINUE WHEN EXISTS (SELECT 1 FROM markets mk WHERE mk.match_id = m.id AND mk.name = c.name);
      INSERT INTO markets(match_id, name, risk, closes_at)
        VALUES (m.id, c.name, c.risk, m.kickoff_at) RETURNING id INTO v_mk;
      FOR i IN 1 .. array_length(c.options, 1) LOOP
        INSERT INTO market_options(market_id, label, sort) VALUES (v_mk, c.options[i], i - 1);
      END LOOP;
      v_n := v_n + 1;
    END LOOP;
  END LOOP;
  RETURN v_n;
END; $$;

-- ---------------------------------------------------------------------
-- Edição de jogos e mercados (admin)
-- Aplicar numa BD já existente: db/migrations/2026-07-02_editar_jogos.sql
-- ---------------------------------------------------------------------

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

-- Apagar um jogo: devolve as apostas dos mercados não liquidados e apaga
-- o jogo (mercados/opções/apostas em cascade). Mercados já liquidados
-- mantêm os pagamentos no ledger — só desaparece o histórico do jogo.
CREATE OR REPLACE FUNCTION bet4fun.remove_match(p_match_id bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = bet4fun AS $$
BEGIN
  IF NOT bet4fun.is_admin() THEN RAISE EXCEPTION 'Apenas admin'; END IF;
  IF NOT EXISTS (SELECT 1 FROM matches WHERE id = p_match_id) THEN
    RAISE EXCEPTION 'Jogo inexistente';
  END IF;
  INSERT INTO transactions(profile_id, amount, kind, ref_bet_id)
    SELECT b.profile_id, b.stake, 'refund', b.id
    FROM bets b JOIN markets m ON m.id = b.market_id
    WHERE m.match_id = p_match_id AND m.status NOT IN ('settled','void');
  DELETE FROM matches WHERE id = p_match_id;
END; $$;

-- ---------------------------------------------------------------------
-- Badges automáticos (corre após cada liquidação)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bet4fun.refresh_badges()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = bet4fun AS $$
BEGIN
  -- 👑 Rei da Tabela: só um, o líder de fichas
  DELETE FROM badges WHERE code = 'rei';
  INSERT INTO badges(profile_id, code)
    SELECT b.profile_id, 'rei'
    FROM balances b JOIN profiles p ON p.id = b.profile_id AND p.is_approved
    ORDER BY b.chips DESC LIMIT 1
    ON CONFLICT (profile_id, code) DO NOTHING;

  -- 🎯 Sniper: acertou >=1 'Resultado exato'
  INSERT INTO badges(profile_id, code)
    SELECT DISTINCT bt.profile_id, 'sniper'
    FROM bets bt JOIN markets m ON m.id = bt.market_id
    WHERE m.status = 'settled' AND m.name ILIKE 'Resultado exato%'
      AND bt.option_id = m.winning_option_id
    ON CONFLICT (profile_id, code) DO NOTHING;

  -- 🧊 Conservador: >=10 apostas e >=80% em risco baixo
  INSERT INTO badges(profile_id, code)
    SELECT profile_id, 'conservador' FROM (
      SELECT bt.profile_id, count(*) tot, count(*) FILTER (WHERE m.risk = 'low') low
      FROM bets bt JOIN markets m ON m.id = bt.market_id GROUP BY bt.profile_id
    ) s WHERE tot >= 10 AND low::numeric / tot >= 0.8
    ON CONFLICT (profile_id, code) DO NOTHING;

  -- 🌪️ Lunático: >=5 apostas e >=60% em 'Resultado exato'
  INSERT INTO badges(profile_id, code)
    SELECT profile_id, 'lunatico' FROM (
      SELECT bt.profile_id, count(*) tot, count(*) FILTER (WHERE m.name ILIKE 'Resultado exato%') ex
      FROM bets bt JOIN markets m ON m.id = bt.market_id GROUP BY bt.profile_id
    ) s WHERE tot >= 5 AND ex::numeric / tot >= 0.6
    ON CONFLICT (profile_id, code) DO NOTHING;

  -- 🇵🇹 Anti-Pátria: >=3 apostas contra Portugal em jogos de Portugal (1X2)
  INSERT INTO badges(profile_id, code)
    SELECT profile_id, 'anti_patria' FROM (
      SELECT bt.profile_id, count(*) c
      FROM bets bt
      JOIN markets m  ON m.id = bt.market_id AND m.name ILIKE 'Resultado (1X2)%'
      JOIN matches mt ON mt.id = m.match_id AND (mt.team_a = 'Portugal' OR mt.team_b = 'Portugal')
      JOIN market_options o ON o.id = bt.option_id AND o.label NOT IN ('Portugal', 'Empate')
      GROUP BY bt.profile_id
    ) s WHERE c >= 3
    ON CONFLICT (profile_id, code) DO NOTHING;
END; $$;

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------

-- Congelar colunas privilegiadas em profiles (só admin muda is_admin/is_approved)
CREATE OR REPLACE FUNCTION bet4fun.profiles_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = bet4fun AS $$
BEGIN
  IF (new.is_admin IS DISTINCT FROM old.is_admin
      OR new.is_approved IS DISTINCT FROM old.is_approved)
     AND NOT bet4fun.is_admin() THEN
    new.is_admin := old.is_admin;
    new.is_approved := old.is_approved;
  END IF;
  RETURN new;
END; $$;

DROP TRIGGER IF EXISTS trg_profiles_guard ON bet4fun.profiles;
CREATE TRIGGER trg_profiles_guard BEFORE UPDATE ON bet4fun.profiles
  FOR EACH ROW EXECUTE FUNCTION bet4fun.profiles_guard();

-- Inscrição no Bet4Fun — chamada pela app no primeiro acesso do utilizador.
--
-- IMPORTANTE: o `auth.users` é PARTILHADO por várias apps neste projeto Supabase.
-- Por isso NÃO usamos um trigger em auth.users (isso criaria um perfil Bet4Fun
-- para quem se regista em QUALQUER app). Em vez disso, o perfil só é criado
-- quando o utilizador abre mesmo o Bet4Fun e a app chama esta RPC.
--
-- O email em settings('admin_email') entra como admin já aprovado + fichas iniciais;
-- os restantes ficam is_approved=false (à espera de aprovação do admin).
CREATE OR REPLACE FUNCTION bet4fun.ensure_profile()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = bet4fun AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_email text;
  v_admin_email text;
  v_is_admin boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Não autenticado'; END IF;
  IF EXISTS (SELECT 1 FROM profiles WHERE id = v_uid) THEN RETURN; END IF;  -- já inscrito

  SELECT email INTO v_email FROM auth.users WHERE id = v_uid;
  SELECT value #>> '{}' INTO v_admin_email FROM settings WHERE key = 'admin_email';
  v_is_admin := (v_email IS NOT NULL AND v_email = v_admin_email);

  INSERT INTO profiles(id, display_name, avatar_emoji, is_admin, is_approved)
    SELECT v_uid,
           COALESCE(u.raw_user_meta_data->>'full_name',
                    u.raw_user_meta_data->>'name',
                    split_part(u.email, '@', 1)),
           '⚽', v_is_admin, v_is_admin
    FROM auth.users u WHERE u.id = v_uid
    ON CONFLICT (id) DO NOTHING;

  IF v_is_admin THEN
    INSERT INTO transactions(profile_id, amount, kind)
      VALUES (v_uid, bet4fun.app_setting_int('initial_chips', 1000), 'initial');
  END IF;
END; $$;

GRANT EXECUTE ON FUNCTION bet4fun.ensure_profile() TO authenticated;

-- Remove o antigo trigger de signup (auto-inscrevia todos os utilizadores do
-- projeto partilhado). Já não é usado — a inscrição passa pela RPC acima.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS bet4fun.handle_new_user();
