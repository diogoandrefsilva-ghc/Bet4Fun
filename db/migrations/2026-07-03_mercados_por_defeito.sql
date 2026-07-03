-- =====================================================================
-- Bet4Fun — Migração 2026-07-03 (c)
-- Mercados por defeito configuráveis no painel de admin
-- ---------------------------------------------------------------------
-- Até aqui o conjunto de mercados abertos em cada jogo novo estava
-- hardcoded no create_match_with_markets (1X2, Mais/Menos 2.5, Resultado
-- exato + penáltis nos jogos a eliminar). Passa a ser configurável:
--
--   · settings('default_markets') — array JSON com os nomes dos mercados
--     do catálogo que abrem automaticamente em cada jogo novo;
--   · bet4fun.market_catalog(a, b) — catálogo único (nome/risco/opções),
--     fonte de verdade para a geração; espelhado no MARKET_CATALOG do
--     js/app.js (que serve só para desenhar o UI);
--   · set_default_markets(names) — RPC admin que guarda a config;
--   · apply_default_markets() — RPC admin que abre os mercados em falta
--     nos jogos que ainda não começaram (não remove nenhum: remoções
--     devolvem apostas e fazem-se jogo a jogo no "Editar jogo").
--
-- Correr no SQL editor do Supabase. Idempotente.
-- =====================================================================

-- 1) Setting: mercados por defeito (a config inicial replica o comportamento
--    antigo; 'Decisão por penáltis' só se aplica aos jogos a eliminar)
INSERT INTO bet4fun.settings (key, value) VALUES
  ('default_markets', '["Resultado (1X2)","Mais/Menos 2.5 golos","Resultado exato","Decisão por penáltis"]'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 2) Catálogo de mercados por jogo (fonte de verdade para a geração automática)
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

-- 3) Nomes dos mercados por defeito (lê o setting; fallback = conjunto enxuto)
CREATE OR REPLACE FUNCTION bet4fun.default_market_names()
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = bet4fun AS $$
  SELECT COALESCE(
    (SELECT array_agg(x.v)
     FROM settings s, jsonb_array_elements_text(s.value) AS x(v)
     WHERE s.key = 'default_markets' AND jsonb_typeof(s.value) = 'array'),
    ARRAY['Resultado (1X2)', 'Mais/Menos 2.5 golos', 'Resultado exato', 'Decisão por penáltis']
  );
$$;

-- 4) Guardar a config (admin). Valida contra o catálogo e guarda na ordem
--    do catálogo (deduplica de borla).
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

-- 5) Criar jogo passa a abrir os mercados da config (em vez do conjunto fixo)
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

-- 6) Aplicar a config aos jogos existentes que ainda não começaram: abre os
--    mercados por defeito em falta. Não remove nenhum mercado já aberto
--    (remoções devolvem apostas — fazem-se jogo a jogo no "Editar jogo").
--    Devolve o nº de mercados abertos.
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

GRANT EXECUTE ON FUNCTION bet4fun.set_default_markets(text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION bet4fun.apply_default_markets() TO authenticated;
