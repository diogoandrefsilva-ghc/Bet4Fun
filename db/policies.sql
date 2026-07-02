-- =====================================================================
-- Bet4Fun — RLS Policies + Grants (bet4fun)
--
-- PRÉ-REQUISITO: DEPENDE das funções em functions.sql
--   bet4fun.is_admin()
-- Correr functions.sql ANTES deste ficheiro.
--
-- Ordem geral: schema.sql -> functions.sql -> policies.sql
-- =====================================================================

-- ---------------------------------------------------------------------
-- profiles: aprovados vêem todos; cada um vê-se a si; admin vê tudo.
-- UPDATE do próprio (nome/avatar); is_admin/is_approved congelados pelo
-- trigger trg_profiles_guard (ver functions.sql).
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS profiles_select ON bet4fun.profiles;
CREATE POLICY profiles_select ON bet4fun.profiles
  FOR SELECT TO authenticated
  USING (is_approved OR id = auth.uid() OR bet4fun.is_admin());

DROP POLICY IF EXISTS profiles_update ON bet4fun.profiles;
CREATE POLICY profiles_update ON bet4fun.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid()) WITH CHECK (id = auth.uid());

-- ---------------------------------------------------------------------
-- transactions: só as minhas (ou admin). Sem INSERT/UPDATE/DELETE
-- (escrita apenas via RPCs SECURITY DEFINER).
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS tx_select ON bet4fun.transactions;
CREATE POLICY tx_select ON bet4fun.transactions
  FOR SELECT TO authenticated
  USING (profile_id = auth.uid() OR bet4fun.is_admin());

-- ---------------------------------------------------------------------
-- Conteúdo público (autenticado). Escrita só via RPC — sem policies de escrita.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS matches_select ON bet4fun.matches;
CREATE POLICY matches_select ON bet4fun.matches
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS markets_select ON bet4fun.markets;
CREATE POLICY markets_select ON bet4fun.markets
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS options_select ON bet4fun.market_options;
CREATE POLICY options_select ON bet4fun.market_options
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS settings_select ON bet4fun.settings;
CREATE POLICY settings_select ON bet4fun.settings
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS badges_select ON bet4fun.badges;
CREATE POLICY badges_select ON bet4fun.badges
  FOR SELECT TO authenticated USING (true);

-- ---------------------------------------------------------------------
-- bets: A POLICY MAIS IMPORTANTE — o segredo até ao apito.
--   a minha, sempre; as dos outros só depois de closes_at; admin vê tudo.
--   INSERT/UPDATE/DELETE: nenhum (apostar só via bet4fun.place_bet()).
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS bets_select ON bet4fun.bets;
CREATE POLICY bets_select ON bet4fun.bets
  FOR SELECT TO authenticated
  USING (
    profile_id = auth.uid()
    OR bet4fun.is_admin()
    OR EXISTS (SELECT 1 FROM bet4fun.markets m WHERE m.id = bets.market_id AND now() >= m.closes_at)
  );

-- ---------------------------------------------------------------------
-- bailout_requests: as minhas (ou admin). INSERT só via request_bailout().
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS bailout_select ON bet4fun.bailout_requests;
CREATE POLICY bailout_select ON bet4fun.bailout_requests
  FOR SELECT TO authenticated
  USING (profile_id = auth.uid() OR bet4fun.is_admin());

-- =====================================================================
-- GRANTS
--   A RLS acima é que filtra as linhas; aqui damos apenas o acesso base.
--   Escrita fica só nas funções SECURITY DEFINER (que correm como owner).
--
--   ⚠️ EXPOR O SCHEMA: Project Settings → API → Data API → Exposed schemas
--      → adicionar "bet4fun" (senão o PostgREST devolve 403/404).
-- =====================================================================

GRANT USAGE ON SCHEMA bet4fun TO anon, authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA bet4fun TO authenticated;         -- inclui as views
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA bet4fun TO authenticated;
