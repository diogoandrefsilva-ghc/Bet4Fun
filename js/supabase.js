/* ============================================================
   Cliente Supabase (singleton).
   supabase-js v2 via CDN esm — sem build step, como manda o SPECS.
   O SDK só é carregado em MODO LIVE (import dinâmico): em modo
   demo a app funciona sem rede e `supabase` fica null.
   ============================================================ */

import { CONFIG, DEMO_MODE } from "./config.js";

let client = null;

if (!DEMO_MODE) {
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
  client = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    // Esta app vive no schema `bet4fun` (partilha o projeto Supabase com as
    // outras apps). Tem de estar exposto na Data API — ver db/README.md.
    db: { schema: "bet4fun" },
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true, // completa o fluxo OAuth no redirect de volta
    },
  });
}

export const supabase = client;
