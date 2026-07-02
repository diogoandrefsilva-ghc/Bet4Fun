# 🎲 O Casino da Malta — Mundial 2026

App recreativa de prognósticos desportivos com mecânicas de casino, para jogar entre amigos
durante o Mundial 2026. Fichas virtuais, pool betting, bancarrotas com badge da vergonha.

## Estado atual

**Protótipo gráfico navegável** com dados fictícios — sem backend. Serve de referência
visual/UX para a implementação.

```bash
# correr localmente
python3 -m http.server 8000
# abrir http://localhost:8000
```

## Documentos

- **`CONCEITO.md`** — o conceito do jogo (regras, mercados, picardia)
- **`SPECS.md`** — especificação técnica para implementação: modelo de dados Supabase,
  RLS, RPCs, algoritmo de liquidação do pool, plano por fases com critérios de aceitação

## Stack alvo

HTML/CSS/JS vanilla (PWA) + Supabase (Postgres, Auth com Google OAuth, RLS). Sem build step.

## Estrutura

```
index.html            shell da app
css/styles.css        tema (casino escuro, dourado + feltro)
js/app.js             router + ecrãs (login, jogos, mercados, boletim, classificação, perfil, admin)
js/data.js            dados fictícios — SUBSTITUIR por Supabase na implementação
manifest.webmanifest  PWA
sw.js                 service worker (cache do shell)
icons/                ícones (falta gerar os PNG 192/512)
```
