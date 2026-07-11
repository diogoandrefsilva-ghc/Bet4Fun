# 🏆 Mundial 2026: Bet4Fun ⚽

Conceito de uma aplicação recreativa de prognósticos de futebol e mecânica de apostas mútuas para jogar entre amigos durante o Mundial 2026. O objetivo é a picardia, a gestão de risco e, acima de tudo, a diversão.

---

## 🕹️ 1. Conceito e Mecânica Geral

O jogo funciona com base numa **moeda virtual (Fichas)**. Cada jogador recebe um orçamento inicial definido pelo Administrador e deve geri-lo ao longo do torneio. 

### 💰 Sistema de Pool Betting (Apostas Mútuas)
Para evitar a complexidade de gerir *odds* reais e estáticas, o prémio de cada mercado é dinâmico e calculado com base no comportamento do grupo:
* **A Distribuição:** O total de fichas apostadas num determinado mercado por todos os jogadores acumula num "pote". 
* **O Prémio:** Quem acertar no prognóstico divide o pote proporcionalmente à quantidade de fichas que apostou. 
* **A Dinâmica:** Isto cria cenários divertidos. Se quase toda a malta apostar na vitória de Portugal, quem arriscar no empate ou na derrota pode rebentar o *Jackpot* sozinho e saltar para o topo da classificação.
* **A Aposta da Casa:** Para ninguém perder tempo a apostar e depois ficar apenas "reembolsado" — porque ninguém mais apostou ou porque toda a gente escolheu o mesmo palpite — a Casa entra com fichas extra, não presas a nenhum palpite específico, só para engordar o pote de quem acertar. Nos mercados normais são 🪙 50 fichas, mas só nesses cenários (só tu apostaste, ou foi tudo no mesmo palpite); se já há vencedores e perdedores a sério, o pote já rende sozinho e a Casa fica de fora. No **Resultado Exato** — o Jackpot, difícil de acertar — a Casa entra sempre que há vencedor, com 🪙 200 fichas por cada aposta feita no mercado: quanto mais malta a arriscar, maior o prémio para quem acertar o resultado em cheio.

### 📉 O Mecanismo de "Bancarrota" (Bailout)
Se alguém for demasiado agressivo e perder as fichas todas logo na fase de grupos, o jogo não acaba para essa pessoa:
* **Pedido de Resgate:** O jogador pode solicitar um "Bailout" ao Administrador para receber um pacote mínimo de fichas de emergência para continuar a jogar.
* **Penalização de Prestígio:** Quem pede um resgate fica com um *badge* visual permanente no perfil (ex: "Falido", "Caloteiro" ou "Financiado pelo FMI") até ao fim do Mundial.

---

## 🎯 2. Tipos de Mercados (Eventos de Jogo)

Os mercados são divididos por níveis de risco para ajudar a malta a delinear a sua estratégia (ir pelo seguro ou arriscar tudo).

> **Nota (fase inicial):** para não poluir a app com poucos jogadores, por defeito só são abertos
> os mercados essenciais — **1X2**, **Mais/Menos 2.5** e **Resultado exato** (+ **Decisão por penáltis**
> nos jogos a eliminar). O catálogo completo abaixo é o leque possível; reabrir os restantes é um
> ajuste em `db/functions.sql` (`create_match_with_markets`).

### 🟢 Risco Baixo (O Pão Nosso)
* **Resultado Regular (1X2):** Vitória da Equipa A, Empate ou Vitória da Equipa B (conta o resultado ao **fim do jogo** — prolongamento incluído nos jogos a eliminar; exclui a marcação de grandes penalidades).
* **Mais/Menos Golos (Over/Under):** Apostar se o jogo terá mais ou menos de 2.5 golos.

### 🟡 Risco Médio (A Roleta)
* **Ambas Marcam:** Sim ou Não.
* **Prolongamento:** O jogo vai ou não a prolongamento?
* **Primeira Equipa a Marcar:** Equipa A, Equipa B ou Nenhuma.

### 🔴 Risco Alto (O Jackpot)
* **Resultado Exato:** O placar final correto do jogo (ex: 2-1, 0-3).
* **Decisão por Penáltis:** O jogo será decidido na marcação de grandes penalidades?
* **Eventos Disciplinares:** Haverá algum cartão vermelho ou penálti assinalado na partida?

### 👑 Apostas de Longo Prazo (Futures)
Submetidas obrigatoriamente antes do apito inicial do primeiro jogo do Mundial. Estas fichas ficam cativas no pote até ao final do torneio:
* **Campeão do Mundo:** Quem levanta a taça.
* **Melhor Marcador (Bota de Ouro):** O jogador com mais golos no torneio.
* **Equipa Sensação:** A equipa fora do top mundial que chega mais longe.

---

## 🚀 3. Funcionalidades de Interação & "Picardia"

A interface e as regras da app devem ser desenhadas para potenciar a competição saudável no grupo de amigos:

1. **Leaderboard em Tempo Real:** Uma tabela classificativa sempre visível, destacando quem é o "Rei da Tabela" (líder de fichas), quem subiu mais na última jornada e quem está na penúria económica.
2. **O "Blefe" e o Segredo:** Até ao momento exato em que o jogo começa, as apostas de cada jogador são estritamente secretas. Assim que o árbitro apita, a app abre o "livro" e revela onde cada um colocou as suas fichas, gerando discussão imediata no chat de amigos.
3. **Mural de Estatísticas Individuais:** Pequenos títulos automáticos no perfil de cada utilizador baseados no seu histórico, como:
   * *O Conservador:* Só aposta em mercados de risco baixo.
   * *O Lunático:* Só aposta em resultados exatos impossíveis.
   * *O Anti-Pátria:* Aposta sistematicamente contra a Seleção Nacional à procura de *odds* altas.
