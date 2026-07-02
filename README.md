# ⚽ Bet4Fun — Mundial 2026

App recreativa de prognósticos de futebol, para jogar entre amigos durante o Mundial 2026
(ou outro evento). Fichas virtuais, pool betting, bancarrotas com badge da vergonha. Zero
dinheiro real — a única coisa em jogo é o prestígio.

## Como se joga (resumo)

1. O admin aprova cada jogador, que recebe as **fichas iniciais**.
2. Antes do apito de cada jogo, apostas fichas nos mercados abertos (**1X2**, **Mais/Menos 2.5**,
   **Resultado exato** — e **Decisão por penáltis** nos jogos a eliminar).
3. As apostas são **secretas** até ao jogo começar. Depois o "livro" abre e toda a malta vê onde
   cada um pôs as fichas.
4. Quem acerta **divide o pote** de cada mercado na proporção do que apostou. Ninguém acerta →
   reembolso. Sobes (ou afundas) na **classificação**.

> Para não poluir a app numa fase inicial com poucos jogadores, o conjunto de mercados é
> **enxuto e global** (definido em `db/functions.sql`). Reabrir mercados extra é só descomentar/
> acrescentar lá.

## Estado atual

**Ligada ao Supabase** (Postgres + Auth com Google + RLS). Não há modo demo: preenche o
`js/config.js` com o `SUPABASE_URL` + `SUPABASE_ANON_KEY` do teu projeto e a app fala com a base
de dados real. Enquanto os placeholders não forem substituídos, a app mostra um ecrã de
configuração.

```bash
# correr localmente (precisa do config.js preenchido)
python3 -m http.server 8000
# abrir http://localhost:8000
```

## Pôr a funcionar (Supabase)

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
css/styles.css        tema (sportsbook escuro — relvado verde + acento coin)
js/config.js          ⚙️ credenciais do Supabase (preencher) + flag IS_CONFIGURED
js/supabase.js        cliente supabase-js (singleton; só criado se configurado)
js/api.js             camada de dados: queries + RPCs do Supabase
js/app.js             router + ecrãs (login, jogos, mercados, boletim, classificação,
                      perfil, admin, liquidação, criar jogo)
db/                   SQL do Supabase (schema.sql, functions.sql, policies.sql) + README
manifest.webmanifest  PWA
sw.js                 service worker (cache-first só do shell; dados sempre da rede)
icons/                ícones PWA (icon.svg + icon-192/512.png)
```

## Segurança

O cliente **nunca** escreve saldos, liquida mercados ou lê apostas alheias antes do apito.
Tudo isso é imposto por **RLS + RPCs `SECURITY DEFINER`** no Supabase (ver `db/`).
A `anon key` no `config.js` é pública por design — a service_role key NUNCA vai para o cliente.
