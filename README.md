# 🎲 O Casino da Malta — Mundial 2026

App recreativa de prognósticos desportivos com mecânicas de casino, para jogar entre amigos
durante o Mundial 2026 (ou outro evento). Fichas virtuais, pool betting, bancarrotas com badge da vergonha.

## Estado atual

**Ligada ao Supabase.** A app comunica com uma base de dados real (Postgres + Auth com
Google + RLS). Enquanto o `js/config.js` não tiver credenciais, corre em **modo demo**
(dados fictícios do protótipo, nada é gravado) — assim que preencheres o URL + anon key,
passa automaticamente a comunicar com o Supabase.

```bash
# correr localmente (modo demo, ou live se já configuraste o config.js)
python3 -m http.server 8000
# abrir http://localhost:8000
```

## Pôr a funcionar a sério (Supabase)

1. Corre o SQL de **`db/`** no Supabase, por ordem: `schema.sql` → `functions.sql` → `policies.sql`
   (cria o schema `bet4fun`, tabelas, RLS, RPCs, trigger de signup). Ver **`db/README.md`**.
2. Expõe o schema `bet4fun` na Data API e ativa o **Google OAuth** (passos em `db/README.md`).
3. Preenche `js/config.js` com o `SUPABASE_URL` e a `SUPABASE_ANON_KEY` do teu projeto.
4. Aloja o conteúdo estático (GitHub Pages / Netlify / Vercel — HTTPS obrigatório).
5. Entra com o Google. O email definido em `admin_email` (no SQL) entra como admin; os
   restantes ficam à espera de aprovação no Painel de Admin.

## Documentos

- **`CONCEITO.md`** — o conceito do jogo (regras, mercados, picardia)
- **`SPECS.md`** — especificação técnica (modelo de dados, RLS, RPCs, pool betting, fases)
- **`db/`** — SQL do Supabase (`schema.sql`, `functions.sql`, `policies.sql`) + `db/README.md`

## Stack

HTML/CSS/JS vanilla (PWA) + Supabase (Postgres, Auth com Google OAuth, RLS).
`@supabase/supabase-js` v2 via CDN esm. Sem build step.

## Estrutura

```
index.html            shell da app (carrega js/app.js como módulo ESM)
css/styles.css        tema (casino escuro, dourado + feltro)
js/config.js          ⚙️ credenciais do Supabase (preencher) + flag de modo demo
js/supabase.js        cliente supabase-js (singleton)
js/api.js             camada de dados: queries + RPCs (com fallback demo)
js/app.js             router + ecrãs (login, jogos, mercados, boletim, classificação,
                      perfil, admin, liquidação, criar jogo)
js/data.js            dados fictícios (modo demo)
db/                   SQL do Supabase (schema.sql, functions.sql, policies.sql) + README
manifest.webmanifest  PWA
sw.js                 service worker (cache-first só do shell; dados sempre da rede)
icons/                ícones PWA (icon.svg + icon-192/512.png)
```

## Segurança

O cliente **nunca** escreve saldos, liquida mercados ou lê apostas alheias antes do apito.
Tudo isso é imposto por **RLS + RPCs `SECURITY DEFINER`** no Supabase (ver `db/`).
A `anon key` no `config.js` é pública por design — a service_role key NUNCA vai para o cliente.
