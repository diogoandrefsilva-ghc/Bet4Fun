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
  PERFORM bet4fun.refresh_badges();
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

-- ---------------------------------------------------------------------
-- Criação de conteúdo (admin)
-- ---------------------------------------------------------------------

-- Criar jogo + conjunto ENXUTO de mercados
-- Decisão (ver SPECS §7): numa fase inicial com poucos jogadores, abrimos só
-- o essencial para não poluir. Se quiseres reabrir os mercados extra (Ambas
-- marcam, 1ª a marcar, Cartão vermelho, Prolongamento), acrescenta-os aqui.
CREATE OR REPLACE FUNCTION bet4fun.create_match_with_markets(
  p_stage text, p_team_a text, p_flag_a text, p_team_b text, p_flag_b text,
  p_kickoff_at timestamptz, p_knockout boolean DEFAULT false)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = bet4fun AS $$
DECLARE v_match bigint; v_mk bigint;
BEGIN
  IF NOT bet4fun.is_admin() THEN RAISE EXCEPTION 'Apenas admin'; END IF;

  INSERT INTO matches(stage, team_a, flag_a, team_b, flag_b, kickoff_at)
    VALUES (p_stage, p_team_a, p_flag_a, p_team_b, p_flag_b, p_kickoff_at)
    RETURNING id INTO v_match;

  -- Resultado (1X2) — risco baixo
  INSERT INTO markets(match_id, name, risk, closes_at) VALUES (v_match, 'Resultado (1X2)', 'low', p_kickoff_at) RETURNING id INTO v_mk;
  INSERT INTO market_options(market_id, label, sort) VALUES (v_mk, p_team_a, 0), (v_mk, 'Empate', 1), (v_mk, p_team_b, 2);

  -- Mais/Menos 2.5 golos — risco baixo
  INSERT INTO markets(match_id, name, risk, closes_at) VALUES (v_match, 'Mais/Menos 2.5 golos', 'low', p_kickoff_at) RETURNING id INTO v_mk;
  INSERT INTO market_options(market_id, label, sort) VALUES (v_mk, 'Mais 2.5', 0), (v_mk, 'Menos 2.5', 1);

  -- Resultado exato — risco alto (o "jackpot")
  INSERT INTO markets(match_id, name, risk, closes_at) VALUES (v_match, 'Resultado exato', 'high', p_kickoff_at) RETURNING id INTO v_mk;
  INSERT INTO market_options(market_id, label, sort) VALUES
    (v_mk,'0-0',0),(v_mk,'1-0',1),(v_mk,'0-1',2),(v_mk,'1-1',3),
    (v_mk,'2-0',4),(v_mk,'0-2',5),(v_mk,'2-1',6),(v_mk,'1-2',7),
    (v_mk,'2-2',8),(v_mk,'3-0',9),(v_mk,'0-3',10),(v_mk,'3-1',11),
    (v_mk,'1-3',12),(v_mk,'3-2',13),(v_mk,'2-3',14),(v_mk,'3-3',15),(v_mk,'Outro',16);

  -- Só nos jogos a eliminar: Decisão por penáltis — risco alto
  IF p_knockout THEN
    INSERT INTO markets(match_id, name, risk, closes_at) VALUES (v_match, 'Decisão por penáltis', 'high', p_kickoff_at) RETURNING id INTO v_mk;
    INSERT INTO market_options(market_id, label, sort) VALUES (v_mk, 'Sim', 0), (v_mk, 'Não', 1);
  END IF;

  RETURN v_match;
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

-- Criar perfil no signup. O email em settings('admin_email') entra como
-- admin já aprovado e com as fichas iniciais.
CREATE OR REPLACE FUNCTION bet4fun.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = bet4fun AS $$
DECLARE v_admin_email text; v_is_admin boolean;
BEGIN
  SELECT value #>> '{}' INTO v_admin_email FROM settings WHERE key = 'admin_email';
  v_is_admin := (new.email IS NOT NULL AND new.email = v_admin_email);

  INSERT INTO profiles(id, display_name, avatar_emoji, is_admin, is_approved)
    VALUES (
      new.id,
      COALESCE(new.raw_user_meta_data->>'full_name',
               new.raw_user_meta_data->>'name',
               split_part(new.email, '@', 1)),
      '⚽', v_is_admin, v_is_admin)
    ON CONFLICT (id) DO NOTHING;

  IF v_is_admin THEN
    INSERT INTO transactions(profile_id, amount, kind)
      VALUES (new.id, bet4fun.app_setting_int('initial_chips', 1000), 'initial');
  END IF;
  RETURN new;
END; $$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION bet4fun.handle_new_user();
