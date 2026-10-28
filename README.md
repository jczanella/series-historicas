# Séries Históricas

Gráficos interativos de séries históricas do Brasil: Ibovespa, Selic, IPCA, PIB, balança comercial, câmbio, crédito, contas externas e resultado fiscal. Dá para sobrepor séries, separar em painéis, ajustar escalas, medir variações entre duas datas e ver as faixas dos governos.

## Fontes

| Fonte | O que vem dela |
|---|---|
| [Banco Central do Brasil — SGS](https://www3.bcb.gov.br/sgspub/) | juros, inflação, câmbio, crédito, setor externo, balança comercial (balanço de pagamentos), fiscal |
| [IBGE — SIDRA](https://sidra.ibge.gov.br/) | PIB trimestral (Contas Nacionais), setores e componentes da demanda |
| B3 (Ibovespa) | ver `scripts/atualizar_dados.py` |

Os códigos de cada série estão no próprio script e no campo `fonte` de cada arquivo em `dados/`.

## Como funciona

- Site estático (GitHub Pages): `index.html`, `app.js`, `vendor/echarts.min.js` e os dados em `dados/*.json`. Não há servidor, banco de dados nem login.
- A rotina `.github/workflows/atualizar-dados.yml` roda nos dias úteis, baixa as séries com `scripts/atualizar_dados.py` e grava os arquivos novos; o Pages republica sozinho.
- `scripts/gerar_site.py` gera `index.html` e `app.js` a partir da página-fonte.

## Atualizar à mão

```
python -I scripts/atualizar_dados.py            # tudo
python -I scripts/atualizar_dados.py pib dolar  # só algumas séries
```
