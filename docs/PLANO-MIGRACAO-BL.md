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

## 4. Fases (re-baseline 2026-06-11)

**Pré-requisito (em curso):** re-IBD archive terminar (#126).

| Fase | Duração | Entrega | Slugs cutover |
|---|---|---|---|
| **A — Validação T0 + Price Oracle** | 1–2 sem | valida os 10 T0 (🟡→🟢); oracle: closes diários mediana de exchanges, backfill 2010→hoje (2010-2012 via fontes históricas — risco mapeado); shadow de hashrate/difficulty/txs vs BL | ~7 |
| **B — Tier 1 (Postgres + backfill)** | 3–4 sem | schema + ZMQ + walk genesis→tip (2–4 dias de processamento, checkpointed, ~150 GB); supply family, CDD/dormancy, volumes, fees, HODL waves, quantiles, script types | ~30 |
| **C — Tier 2 (cost basis)** | 5–6 sem | `price_at_creation` por UTXO; realized family completa, MVRV/NUPL/SOPR + cohorts, URPD, cointime (15), unrealized, supply in P/L | ~45 |
| **D — Cutover final** | 2 sem | flip dos derivados (17 migram sozinhos), 90 dias de estabilidade, **desligar assinatura BL** | +17 auto |

Total estimado: **11–14 semanas** após o fim do re-IBD. O rollout é gradual e
reversível a qualquer momento (a flag por-slug cai de volta pra BL em caso de
divergência — fallback já implementado e testado).

### Ordem de cutover dentro de cada fase (risco crescente)
1. Consenso puro (determinístico, erro impossível): difficulty, supply_total, txs.
2. Ratios sem preço: liveliness, vaultedness, supply percentuais.
3. Séries com preço: fees USD, realized family, MVRV.
4. Binned/pesados por último: URPD, HODL waves, quantiles.

---

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
