/* ============================================================
   Cliente Supabase (singleton).
   supabase-js v2 via CDN esm — sem build step, como manda o SPECS.
   Só é criado quando o config.js tem credenciais reais; caso
   contrário `supabase` fica null e a app mostra o ecrã de
   configuração (não há modo demo).
   ============================================================ */

import { CONFIG, IS_CONFIGURED } from "./config.js";

let client = null;

if (IS_CONFIGURED) {
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
