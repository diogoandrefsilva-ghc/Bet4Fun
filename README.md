# 🎲 O Casino da Malta — Mundial 2026

App recreativa de prognósticos desportivos com mecânicas de casino, para jogar entre amigos
durante o Mundial 2026. Fichas virtuais, pool betting, bancarrotas com badge da vergonha.

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

1. Segue os passos em **`SUPABASE_SETUP.txt`** — cola o SQL no Supabase (cria tabelas,
   RLS, RPCs, trigger de signup) e ativa o Google OAuth.
2. Preenche `js/config.js` com o `SUPABASE_URL` e a `SUPABASE_ANON_KEY` do teu projeto.
3. Aloja o conteúdo estático (GitHub Pages / Netlify / Vercel — HTTPS obrigatório).
4. Entra com o Google. O email definido em `admin_email` (no SQL) entra como admin; os
   restantes ficam à espera de aprovação no Painel de Admin.

## Documentos

- **`CONCEITO.md`** — o conceito do jogo (regras, mercados, picardia)
- **`SPECS.md`** — especificação técnica (modelo de dados, RLS, RPCs, pool betting, fases)
- **`SUPABASE_SETUP.txt`** — script SQL + passos para o setup do Supabase

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
manifest.webmanifest  PWA
sw.js                 service worker (cache-first só do shell; dados sempre da rede)
icons/                ícones (falta gerar os PNG 192/512 a partir do icon.svg)
```

## Segurança

O cliente **nunca** escreve saldos, liquida mercados ou lê apostas alheias antes do apito.
Tudo isso é imposto por **RLS + RPCs `SECURITY DEFINER`** no Supabase (ver `SUPABASE_SETUP.txt`).
A `anon key` no `config.js` é pública por design — a service_role key NUNCA vai para o cliente.
