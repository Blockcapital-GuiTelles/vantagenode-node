# Plano de migração — API BL → VantageNode (node próprio)

> Status em 2026-06-11. Responde: "é possível substituir a fonte BL pelo nosso
> node?" — **Sim, 100% dos 85 indicadores BL diretos são substituíveis**, com
> uma única dependência externa nova (price oracle interno via exchanges).
> Outros 17 indicadores derivados migram automaticamente quando os caches-fonte
> virarem. O caminho crítico é o re-IBD archive (#126) terminar.

---

## 1. Inventário — o que vem da BL hoje

Do catálogo curado (134 indicadores no terminal):

| Origem | Qtde | Observação |
|---|---|---|
| **BL direto** (pipeline de cache BL) | **85** | escopo desta migração |
| Derivados de caches BL | 17 | histograms (8), by-age (4), RHODL, ETF/CBP (4)* — **migram sozinhos** quando o cache-fonte virar |
| Não-BL (Macro, Futuros, Sentiment, ER especiais) | 32 | fora de escopo — fontes próprias já |

\* ETF flows e Coinbase Premium não são BL (fontes próprias), mas o CBP usa o
cache de `price` como âncora — migra junto com o price oracle.

### Os 85 BL diretos, por o que exigem do node

| Classe | Qtde | Famílias | O que exige |
|---|---|---|---|
| **T0 — RPC puro** | ~7 | hashrate, difficulty, block_time_avg, txs_n, supply_total, issuance, S2F/inflação | bitcoind RPC (já implementado 🟡, falta validar) |
| **T1 — UTXO-set + idade** | ~30 | supply LTH/STH/hot/aged, CDD/dormancy/ASOL, coindays, volumes, fees, HODL waves (sumbtc), quantiles, script types, addresses_by_btc | Postgres + backfill genesis→tip + ZMQ |
| **T2 — cost basis por UTXO** | ~45 | Realized Cap/Price/P&L (+cohorts), MVRV/NUPL/SOPR (+cohorts), Unrealized*, Supply in P/L, URPD, Cointime (15: liveliness, vaultedness, AVIV, vaulted_*, thermo/investor cap, TMM), NVT | T1 + **price oracle** + `price_at_creation` por UTXO |
| **Price oracle** | 2 | price, market_cap | NÃO vem da chain — closes diários de exchanges (mediana), backfill 2010→hoje |

Conclusão técnica: **não existe indicador BL no nosso catálogo que o node não
consiga computar**. Tudo é UTXO-set + idade + preço histórico. As únicas séries
que não saem da chain (price, market_cap) saem do price oracle — que o T2 já
exige de qualquer forma.

---

## 2. O que já está pronto (infraestrutura de migração)

| Peça | Status | Evidência |
|---|---|---|
| Node archive (txindex+coinstatsindex) | 🔄 re-IBD em curso (#126) | bloqueia backfill T1/T2 |
| Indexer Tier-0 (10 slugs) | 🟡 implementado, não validado | `indexer/src/server.ts` |
| Ponte Studio↔node (HMAC, per-slug, fallback) | ✅ em produção | `tryFetchNodeMetric` + flag #129 |
| Transporte fim-a-fim validado | ✅ | mvrv_node_test servido pelo node, renderizado no terminal |
| Metodologia de paridade | ✅ definida | `METRIC-PARITY.md` (±0.5% → 🟢 → cutover → ✅) |
| Mascaramento de origem | ✅ | API `source: 'onchain'` genérico (Studio PR #265) |

---

## 3. Comparação de valores — o que já temos e como será

### 3.1 Já medido (valida a PONTE, não a computação)

| Indicador | Node (snapshot) | BL | Diferença | Referência externa |
|---|---|---|---|---|
| MVRV | 1.1512 | 1.1523 | **0.10%** | mercado ~1.15 ✓ |
| Realized Loss | série idêntica ao cache | — | 0% | formato/render ✓ |

**Atenção:** os `*_node_test` servem snapshot congelado do cache BL pelo node.
Provam que ponte, HMAC, slugs, render e janela funcionam — a computação
on-node ainda não existe (T2).

### 3.2 Protocolo de comparação por slug (quando cada tier entregar)

1. **Shadow run** — `parity-check.sh <slug>`: busca node e BL para os últimos
   90 dias, calcula erro relativo máximo e médio.
2. **Âncoras históricas** — além dos 90 dias, 5 datas fixas por slug:
   topo abr/2021, capitulação jun/2021, FTX nov/2022, halving abr/2024,
   última semana. (Mesmo método que validou os packs macro.)
3. **Tolerâncias por classe:**

| Classe | Tolerância | Racional |
|---|---|---|
| Counts/consenso (txs, difficulty, supply_total) | exato (±0.001%) | determinístico da chain |
| Ratios (MVRV, SOPR, NUPL, liveliness) | ±0.5% | delta de price oracle + cutoff |
| Agregados USD (realized P/L, fees USD, caps) | ±1–2% | composição do oracle difere da BL |
| Binned (URPD, HODL waves, quantiles) | 95% dos bins ±1% | fronteiras de bucket |

4. **Divergência > tolerância** → investigar e documentar em
   `METRIC-PARITY.md › Known methodology deltas`. Deltas prováveis:
   - cutoff de dia (UTC vs outro) — ±0.3% em agregados diários;
   - price oracle (nossa mediana de exchanges vs composição BL);
   - fronteira LTH (≥155d vs >155d) e tratamento de coinbase imaturo;
   - dust/OP_RETURN/provably-unspendable no supply;
   - reorgs (nós: tentative até 6 conf).
5. **Cutover por slug:** 🟢 → flip da flag → 48h de monitoração → ✅ →
   14 dias em ✅ com série dupla (shadow continua) → BL desligada pro slug.

---

## 4. Roadmap em DIAS (re-baseline 2026-06-11 — execução em ritmo de IA)

> Princípio: nada de semanas. Cada dia fecha entregas verificáveis. Dois
> destravamentos de engenharia tornam isso possível:
>
> **(a) Backfill começa DURANTE o IBD.** O IBD baixa blocos em ordem — os
> anos 2009-202x já validados estão NO DISCO antes do sync terminar. O walk
> do indexer processa o trecho já sincronizado e vai "caçando a ponta",
> em vez de esperar 100%.
>
> **(b) Um walk só para T1+T2.** Em vez de dois backfills (T1 depois T2),
> um único passe do gênesis à ponta mantém o UTXO-set com `value`,
> `price_at_creation` e bucket de idade — e emite TODOS os agregados
> diários (supply cohorts, CDD, realized cap, P/L, HODL waves, URPD) de
> uma vez. O custo extra do T2 dentro do walk é marginal; re-walk é que
> custa caro.

| Dia | Entrega | Gate de saída |
|---|---|---|
| **D0** | Destravar healthz (bitcoind RPC p/ indexer) + medir IBD; **price oracle v1** (closes diários, mediana de exchanges, backfill 2010→hoje + refresher) — não depende da chain; `parity-check.sh` funcional | oracle com ~5.8K dias; healthz `ok:true` |
| **D1** | Validar T0 (10 slugs vs BL); schema Postgres + consumer ZMQ; **walk único T1+T2 começa** sobre os blocos já em disco | T0 🟢; walk processando ≥ 2015 |
| **D2** | Walk avança (checkpoint/resume); agregadores T1 emitindo snapshots diários; shadow parity dos determinísticos | difficulty/supply_total/txs ✅ cutover |
| **D3** | Walk alcança a ponta (ou a borda do IBD); T1 completo: supply LTH/STH, CDD, dormancy, volumes, fees, HODL waves | ~30 slugs T1 em shadow |
| **D4** | T2 emite: realized cap/price, MVRV/NUPL/SOPR + cohorts; parity 90d + âncoras (topo 2021, FTX, halving) | erros ≤ tolerância por classe |
| **D5** | T2 pesados: URPD, cointime (15), unrealized, supply in P/L, binned | catálogo T2 completo em shadow |
| **D6** | Relatório de paridade COMPLETO (85 slugs, node × BL, 90d + âncoras) entregue pra revisão | aprovação humana por família |
| **D7-D8** | Cutover gradual por risco (flag por-slug, fallback automático); 17 derivados migram sozinhos | catálogo 100% node |
| **D9-D10** | Buffer p/ divergências + hardening (reorg test, restart test, snapshot Storage Box) | BL em shadow 30 dias → desligar |

Condicionante única: o fim do IBD limita o D3 (o walk só alcança a ponta
quando a chain estiver completa). Tudo até D2 roda em paralelo ao IBD.

### Gargalos identificados e como cada um é resolvido

| # | Gargalo | Impacto | Solução |
|---|---|---|---|
| 1 | **re-IBD em curso** (#126) — e healthz reportando RPC down | bloqueia o walk de alcançar a ponta | monitorar/destravar D0; backfill paralelo ao IBD (destravamento *a*) elimina a espera |
| 2 | **Price oracle inexistente** | trava T2 e o trecho 2010-2012 | construir D0 — independe da chain; 2010-2012 best-effort com BL de referência no shadow |
| 3 | **Backfill compute-bound** | walk de ~900K blocos | walk único T1+T2 (destravamento *b*), checkpoint por altura, CPU do AX42 dedicada |
| 4 | **Acesso operacional ao node** | sessões do agente sem SSH autorizado → operação manual | autorizar SSH ao node nas sessões de execução (ou rodar via runbook colado) |
| 5 | **Revisão humana é serial** | cutover de 85 slugs não pode pingar 1-a-1 | relatório de paridade em LOTE (D6) com aprovação por família, não por slug |
| 6 | **Dependência BL até o fim** | custo + risco de terceiro | é o objetivo do plano; BL vira shadow em D8 e desliga após 30 dias estáveis |

## 5. Riscos e mitigações

| Risco | Impacto | Mitigação |
|---|---|---|
| Price oracle 2010–2012 (pré-exchanges líquidas) | realized cap histórico distorce | fontes históricas múltiplas, marcar trecho como best-effort; BL fica de referência no shadow |
| Backfill T1/T2 demora/corrompe | atraso de fase | checkpoint por bloco, resumível; Storage Box p/ snapshots |
| Divergência metodológica sistemática | série "salta" no cutover | shadow 90d + âncoras; se delta constante e explicável, documentar e aceitar; se errático, investigar antes do flip |
| Node down pós-cutover | charts quebram | fallback automático pro cache (último snapshot BL) já implementado; manter caches mornos por 90 dias |
| Reorg profundo | dados do dia errados | tentative até 6 conf (já no design F3) |

---

## 6. Decisão recomendada

Prosseguir com a Fase A imediatamente após o re-IBD concluir. O investimento
restante é majoritariamente o que já estava no roadmap (F3/F4); este plano
acrescenta o mapeamento completo dos 85 slugs, a ordem de cutover por risco e
a malha de comparação com tolerâncias por classe. Benefício final: catálogo
onchain 100% proprietário, custo fixo de infra (~€39/mo + storage) substituindo
a assinatura BL, e nenhuma dependência de terceiro no caminho dos dados.
