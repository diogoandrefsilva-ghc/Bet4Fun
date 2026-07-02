/* ============================================================
   Configuração do Casino da Malta
   ------------------------------------------------------------
   PREENCHE ESTES DOIS VALORES com os do teu projeto Supabase:
     Supabase Dashboard → Project Settings → API
       • Project URL         → SUPABASE_URL
       • Project API keys → anon / public → SUPABASE_ANON_KEY

   Enquanto o URL não for preenchido, a app corre em MODO DEMO
   (dados fictícios do protótipo, nada é gravado). Assim que
   puseres o URL + anon key reais, passa automaticamente a
   comunicar com o Supabase.

   ⚠️ A anon key é PÚBLICA por design — pode ficar aqui. A
   segurança vem toda das políticas RLS + RPCs no Supabase
   (ver db/README.md). NUNCA metas aqui a service_role key.
   ============================================================ */

export const CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT-ref.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-ANON-PUBLIC-KEY",

  // Forçar modo demo mesmo com credenciais preenchidas (útil para mostrar
  // o protótipo sem tocar na base de dados). Deixa false em produção.
  FORCE_DEMO: false,
};

/* A app está configurada quando o URL deixou de ser o placeholder. */
export const IS_CONFIGURED =
  !!CONFIG.SUPABASE_URL &&
  !CONFIG.SUPABASE_URL.includes("YOUR-PROJECT") &&
  !!CONFIG.SUPABASE_ANON_KEY &&
  !CONFIG.SUPABASE_ANON_KEY.includes("YOUR-ANON");

/* Modo demo = não configurado, ou forçado explicitamente. */
export const DEMO_MODE = CONFIG.FORCE_DEMO || !IS_CONFIGURED;
