# Bet4Fun — Base de dados (Supabase)

Fonte de verdade do schema. **Edita aqui primeiro, depois aplica no Supabase** — nunca ao contrário.

App-alvo: *Bet4Fun* (Mundial 2026). Toda a lógica sensível vive em SQL — o cliente
nunca escreve saldos, nunca liquida mercados e nunca lê apostas alheias antes do apito.

## Schema dedicado

Como no FestasBV, esta app vive num **schema próprio** (`bet4fun`) dentro do projeto Supabase
partilhado, para não colidir com as outras apps. Isto implica dois passos de configuração:

1. **Expor o schema**: Project Settings → API → Data API → *Exposed schemas* → adiciona `bet4fun`.
   (Sem isto o PostgREST devolve 403/404.)
2. O frontend já aponta para o schema em `js/supabase.js` (`db: { schema: 'bet4fun' }`).

## Ordem de execução (BD limpa)

Corre no SQL Editor do Supabase, **por esta ordem**:

1. **`schema.sql`** — schema `bet4fun`, tabelas (+ RLS ativa), views (agregados) e seed dos settings.
2. **`functions.sql`** — helpers (`is_admin`, `app_setting_int`), RPCs (`place_bet`, `settle_market`,
   `void_market`, `request_bailout`, `approve_bailout`, `approve_player`, `create_match_with_markets`,
   `set_match_result`, `refresh_badges`, `ensure_profile`) e o trigger que congela colunas privilegiadas.
   A inscrição de perfis é feita pela RPC `ensure_profile()` (chamada pela app), **não** por trigger em
   `auth.users` — essa tabela é partilhada por várias apps do projeto.
3. **`policies.sql`** — RLS policies + grants.

`policies.sql` depende de `functions.sql` (usa `bet4fun.is_admin()`). Correr fora de ordem rebenta
com *"function ... does not exist"*.

## Passos completos (uma vez)

1. Corre os 3 ficheiros SQL pela ordem acima.
2. Em `schema.sql` (seed), mete o **teu Gmail** em `admin_email` — esse email entra como admin já
   aprovado e com fichas no 1.º login. (Ou depois:
   `update bet4fun.settings set value='"o-teu@gmail.com"'::jsonb where key='admin_email';`)
3. **Authentication → Providers → Google** → Enable (OAuth Client no Google Cloud Console; mete o
   redirect URI que o Supabase mostra). Em **URL Configuration** define o Site URL / Redirect URLs
   para onde alojas a app.
4. **Expor o schema `bet4fun`** na Data API (ver acima).
5. Project Settings → API → copia `Project URL` + `anon key` para `js/config.js`.

## Modelo de segurança

- **Admin** (`is_admin`): acesso total via RPCs.
- **Jogador aprovado** (`is_approved`): vê tudo o que é público, aposta via `place_bet`, vê as apostas
  dos outros só **depois do kickoff** (policy `bets_select`). Saldo = soma do ledger `transactions`.
- **Não aprovado**: fica no ecrã "à espera de aprovação"; o admin aprova no painel.
- As **views** (`balances`, `market_pools`, `market_totals`, `match_pots`, `leaderboard`) correm como
  owner e contornam a RLS de propósito — expõem agregados (potes, saldos) **sem** revelar quem apostou.

## Definições (tabela `settings`)

`initial_chips` (1000) · `bailout_chips` (200) · `min_stake` (5) ·
`show_pools_before_kickoff` (true) · `admin_email`.
Ex.: `update bet4fun.settings set value='1500'::jsonb where key='initial_chips';`

## Nota sobre IDs

Ao contrário do FestasBV (IDs atribuídos pela app), aqui as tabelas usam
`GENERATED ALWAYS AS IDENTITY`: como toda a escrita passa por RPCs no servidor e há inserções
concorrentes (vários a apostar em simultâneo), a sequence garante unicidade sem race conditions.

## Checklist anti-batota (testar com a anon key)

- [ ] apostar depois do kickoff → erro *"Mercado fechado"*
- [ ] ler apostas de outro antes do apito → 0 linhas
- [ ] inserir transação a crédito próprio → recusado (sem policy de INSERT)
- [ ] apostar mais fichas do que o saldo → erro *"Fichas insuficientes"*
- [ ] não-admin a liquidar/aprovar → erro *"Apenas admin"*
