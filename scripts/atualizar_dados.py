"""Baixa as séries históricas e grava dados/<id>.json e dados/catalogo.json (lidos pela página).

Fontes (priorizando as oficiais):
- B3/Ibovespa: Yahoo Finance (^BVSP), fechamento diário.
- Banco Central do Brasil: API SGS (api.bcb.gov.br). Séries diárias só aceitam
  janelas de até 10 anos por consulta, então são baixadas em blocos.
- IBGE: API SIDRA (apisidra.ibge.gov.br), Contas Nacionais Trimestrais.

Séries do BCB começam no Plano Real (jul/1994): antes disso a hiperinflação e as
trocas de moeda tornam os valores incomparáveis.

Uso:  python -I scripts/atualizar_dados.py            (tudo)
      python -I scripts/atualizar_dados.py pib dolar  (só as séries pedidas)
O catálogo (nomes, unidades, cores, ordem no menu) é regravado em toda execução.
"""
import calendar
import json
import sys
import time
import urllib.request
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

PASTA = Path(__file__).resolve().parent.parent / "dados"
BRT = timezone(timedelta(hours=-3))
HOJE = datetime.now(BRT).date()
REAL = date(1994, 7, 1)
BASE = date(1994, 6, 30)


def baixar(url):
    for tentativa in range(5):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            return json.load(urllib.request.urlopen(req, timeout=90))
        except Exception:
            if tentativa == 4:
                raise
            time.sleep(2 + 3 * tentativa)


def gravar(id_, fonte, pontos):
    # algumas séries do SGS vêm com zeros antes do primeiro dado real
    while pontos and pontos[0][1] == 0:
        pontos = pontos[1:]
    # proteção: uma resposta truncada ou com defeito da fonte não substitui o histórico bom
    arq = PASTA / f"{id_}.json"
    if arq.exists():
        antes = len(json.loads(arq.read_text(encoding="utf-8"))["d"])
        if len(pontos) < antes * 0.95:
            raise ValueError(f"veio com {len(pontos)} pontos, antes tinha {antes}; arquivo mantido")
    serie = {"id": id_, "fonte": fonte, "atualizado": HOJE.isoformat(),
             "d": [[d.isoformat(), round(v, 6)] for d, v in pontos]}
    PASTA.mkdir(exist_ok=True)
    arq.write_text(json.dumps(serie, separators=(",", ":")), encoding="utf-8")
    print(f"{id_:16} {len(pontos):6} pontos  {pontos[0][0]} a {pontos[-1][0]}", flush=True)


# ---------- transformações ----------
def fim_do_mes(d):
    return date(d.year, d.month, calendar.monthrange(d.year, d.month)[1])


def mensal(pontos):
    """Séries mensais do SGS vêm datadas no dia 1; o valor vale para o mês inteiro."""
    return [(fim_do_mes(d), v) for d, v in pontos]


def acumulado(taxas, inicio):
    """Converte taxas % por período em índice (100 em `inicio`)."""
    idx, out = 100.0, [(inicio, 100.0)]
    for d, v in taxas:
        idx *= 1 + v / 100
        out.append((d, idx))
    return out


def so_mudancas(pontos):
    """Para taxas em degrau (Selic meta): guarda só as mudanças e o último dia."""
    out = [p for i, p in enumerate(pontos) if i == 0 or p[1] != pontos[i - 1][1]]
    if out[-1] != pontos[-1]:
        out.append(pontos[-1])
    return out


def escala(pontos, fator):
    return [(d, v * fator) for d, v in pontos]


def soma_movel(pontos, n):
    """Soma dos últimos n períodos (12 meses, 4 trimestres)."""
    return [(d, sum(v for _, v in pontos[i - n + 1:i + 1])) for i, (d, _) in enumerate(pontos) if i >= n - 1]


def combina(a, b, f):
    db = dict(b)
    return [(d, f(v, db[d])) for d, v in a if d in db]


def so_dezembro(pontos):
    return [(d, v) for d, v in pontos if d.month == 12]


# ---------- Ibovespa ----------
def ibovespa():
    res = baixar("https://query1.finance.yahoo.com/v8/finance/chart/%5EBVSP?period1=0&period2=9999999999&interval=1d")
    res = res["chart"]["result"][0]
    pontos = {}
    for ts, v in zip(res["timestamp"], res["indicators"]["quote"][0]["close"]):
        if v:
            pontos[datetime.fromtimestamp(ts, BRT).date()] = round(v, 2)
    return sorted(pontos.items())


# ---------- Banco Central (SGS) ----------
@lru_cache(None)
def _sgs(codigo, inicio):
    fmt = "%d/%m/%Y"
    pontos, ini = {}, inicio
    while ini <= HOJE:
        fim = min(date(ini.year + 9, ini.month, ini.day) - timedelta(days=1), HOJE)
        url = (f"https://api.bcb.gov.br/dados/serie/bcdata.sgs.{codigo}/dados?formato=json"
               f"&dataInicial={ini.strftime(fmt)}&dataFinal={fim.strftime(fmt)}")
        for p in baixar(url):
            if p["valor"] not in ("", None):
                pontos[datetime.strptime(p["data"], fmt).date()] = float(p["valor"])
        ini = fim + timedelta(days=1)
    return tuple(sorted(pontos.items()))


def sgs(codigo, inicio=REAL):
    return list(_sgs(codigo, inicio))


def sgs_bi(codigo):
    """Fluxo mensal em US$ milhões -> US$ bilhões, datado no fim do mês."""
    return escala(mensal(sgs(codigo)), 1 / 1000)


# ---------- IBGE (SIDRA, Contas Nacionais Trimestrais) ----------
PIB, AGRO, IND, EXTR, TRANSF, ELET, CONSTR, SERV = "90707", "90687", "90691", "90692", "90693", "90695", "90694", "90696"
COM, TRANSP, INFO, FIN, IMOB, OUTROS, ADM = "90697", "90698", "90699", "90700", "90702", "90701", "90703"
FAM, GOV, FBCF, EXP, IMP = "93404", "93405", "93406", "93407", "93408"


@lru_cache(None)
def _sidra(tabela, variavel):
    url = f"https://apisidra.ibge.gov.br/values/t/{tabela}/n1/all/v/{variavel}/p/all/c11255/all"
    out = {}
    for linha in baixar(url)[1:]:
        try:
            v = float(linha["V"])
        except ValueError:
            continue  # "-", "..." = sem dado
        p = linha["D3C"]
        d = fim_do_mes(date(int(p[:4]), int(p[4:]) * 3, 1))
        out.setdefault(linha["D4C"], []).append((d, v))
    return {k: tuple(sorted(x)) for k, x in out.items()}


def sidra(tabela, variavel, setor):
    return list(_sidra(tabela, variavel)[setor])


# variáveis da tabela 5932 (taxas de variação do volume)
VS_ANTERIOR, VS_ANO_ANT, ACUM_4T, ACUM_ANO = 6564, 6561, 6562, 6563


# ---------- Tesouro Nacional (Tesouro Direto, dados abertos) ----------
TD_CSV = ("https://www.tesourotransparente.gov.br/ckan/dataset/df56aa42-484a-4a59-8184-7676580c81e3/"
          "resource/796d2059-14e9-44e3-80c9-2d9e30b405c1/download/PrecoTaxaTesouroDireto.csv")


@lru_cache(None)
def _tesouro_prefixado():
    """{data base: [(dias até o vencimento, taxa % a.a.)]} dos Tesouro Prefixado (LTN, sem cupom)."""
    req = urllib.request.Request(TD_CSV, headers={"User-Agent": "Mozilla/5.0"})
    for tentativa in range(5):
        try:
            texto = urllib.request.urlopen(req, timeout=180).read().decode("latin-1")
            break
        except Exception:
            if tentativa == 4:
                raise
            time.sleep(5 + 5 * tentativa)
    fmt, por_dia = "%d/%m/%Y", {}
    for linha in texto.splitlines()[1:]:
        c = linha.split(";")
        if len(c) < 4 or c[0] != "Tesouro Prefixado" or not c[3]:
            continue
        taxa = float(c[3].replace(",", "."))
        if taxa <= 0:
            continue
        base, venc = datetime.strptime(c[2], fmt).date(), datetime.strptime(c[1], fmt).date()
        por_dia.setdefault(base, []).append(((venc - base).days, taxa))
    return por_dia


def juro_prefixado(dias):
    """Taxa prefixada com prazo constante (ex.: 365 dias), interpolando linearmente entre os
    dois vencimentos vizinhos; dias sem vencimentos dos dois lados ficam de fora."""
    out = []
    for base, pts in sorted(_tesouro_prefixado().items()):
        pts.sort()
        antes = [p for p in pts if p[0] <= dias]
        depois = [p for p in pts if p[0] >= dias]
        if not antes or not depois:
            continue
        (d0, t0), (d1, t1) = antes[-1], depois[0]
        out.append((base, t0 if d1 == d0 else t0 + (t1 - t0) * (dias - d0) / (d1 - d0)))
    return out


# ---------- Banco Central — pesquisa Focus (expectativas de mercado) ----------
OLINDA = "https://olinda.bcb.gov.br/olinda/servico/Expectativas/versao/v1/odata/"


def focus(recurso, filtro, campos):
    url = (OLINDA + recurso + "?$format=json&$top=100000&$select=" + campos
           + "&$filter=" + urllib.request.quote(filtro))
    return baixar(url)["value"]


def focus_selic_ano_seguinte():
    """Mediana da Selic esperada para o fim do ano seguinte, em cada data da pesquisa."""
    pontos = {}
    for r in focus("ExpectativasMercadoAnuais", "Indicador eq 'Selic' and baseCalculo eq 0", "Data,DataReferencia,Mediana"):
        d = datetime.strptime(r["Data"], "%Y-%m-%d").date()
        if r["Mediana"] is not None and int(r["DataReferencia"]) == d.year + 1:
            pontos[d] = r["Mediana"]
    return sorted(pontos.items())


def focus_ipca_12m():
    """Mediana do IPCA esperado para os próximos 12 meses (série suavizada)."""
    pontos = {}
    for r in focus("ExpectativasMercadoInflacao12Meses", "Indicador eq 'IPCA' and Suavizada eq 'S' and baseCalculo eq 0", "Data,Mediana"):
        if r["Mediana"] is not None:
            pontos[datetime.strptime(r["Data"], "%Y-%m-%d").date()] = r["Mediana"]
    return sorted(pontos.items())


# ---------- catálogo ----------
FONTES = {
    "b3": {"nome": "B3", "site": "via Yahoo Finance"},
    "ibge": {"nome": "IBGE", "site": "sidra.ibge.gov.br · Contas Nacionais"},
    "bcb": {"nome": "Banco Central", "site": "bcb.gov.br"},
    "tesouro": {"nome": "Tesouro Nacional", "site": "tesourotransparente.gov.br · Tesouro Direto"},
}
PALETA = ["--c-azul", "--c-laranja", "--c-aqua", "--c-amarelo", "--c-magenta", "--c-verde", "--c-violeta", "--c-vermelho"]
CATALOGO = []   # ordem de inserção = ordem de importância no menu


def serie(id_, fonte, tema, nome, tipo, unid, freq, origem, fn, cor=None, traco=False, degrau=False):
    """tipo: 'nivel' (preço/índice, pode virar % desde o início do período),
    'taxa' (já em %), 'fluxo' (montante que pode ser negativo, ex.: saldo)."""
    CATALOGO.append(dict(id=id_, fonte=fonte, tema=tema, nome=nome, tipo=tipo, unid=unid, freq=freq,
                         origem=origem, fn=fn, cor=cor, traco=traco, degrau=degrau))


B = "Banco Central do Brasil — SGS "
I = "IBGE — SIDRA, tabela "

serie("ibovespa", "b3", None, "Ibovespa", "nivel", "pts", "diária", "Yahoo Finance (^BVSP), fechamento diário", ibovespa, cor="--c-azul")

# IBGE — PIB
T = "PIB — principais"
# ordem da divulgação do IBGE e da imprensa: manchete = trimestre vs anterior; depois 12 meses e vs mesmo tri do ano anterior
serie("pib_tt", "ibge", T, "PIB no trimestre (vs anterior, dessaz.)", "taxa", "%", "trimestral", I + "5932 (var. % vs trimestre anterior, com ajuste sazonal)", lambda: sidra(5932, VS_ANTERIOR, PIB), cor="--c-vermelho")
serie("pib_4t", "ibge", T, "PIB em 12 meses (4 trimestres)", "taxa", "%", "trimestral", I + "5932 (var. % acumulada em 4 trimestres)", lambda: sidra(5932, ACUM_4T, PIB), cor="--c-laranja")
serie("pib", "ibge", T, "PIB vs mesmo trimestre do ano anterior", "taxa", "%", "trimestral", I + "5932 (var. % vs mesmo trimestre do ano anterior)", lambda: sidra(5932, VS_ANO_ANT, PIB), cor="--c-laranja", traco=True)
serie("pib_ano", "ibge", T, "PIB acumulado no ano", "taxa", "%", "trimestral", I + "5932", lambda: sidra(5932, ACUM_ANO, PIB), cor="--c-amarelo")
serie("pib_anual", "ibge", T, "PIB anual (crescimento)", "taxa", "%", "anual", I + "5932 (acumulado em 4 trimestres no 4º tri)", lambda: so_dezembro(sidra(5932, ACUM_4T, PIB)), cor="--c-violeta")
serie("pib_valor", "ibge", T, "PIB em R$ (12 meses)", "nivel", "R$ tri", "trimestral", I + "1846 (preços correntes, soma de 4 trimestres)", lambda: escala(soma_movel(sidra(1846, 585, PIB), 4), 1 / 1e6), cor="--c-verde")
serie("pib_indice", "ibge", T, "PIB real (índice, dessaz.)", "nivel", "índice", "trimestral", I + "1621 (volume encadeado, média 1995 = 100)", lambda: sidra(1621, 584, PIB), cor="--c-aqua")
serie("taxa_invest", "ibge", T, "Taxa de investimento (FBCF/PIB)", "taxa", "% PIB", "trimestral", I + "1846 (FBCF ÷ PIB, 4 trimestres)",
      lambda: combina(soma_movel(sidra(1846, 585, FBCF), 4), soma_movel(sidra(1846, 585, PIB), 4), lambda a, b: a / b * 100), cor="--c-magenta")

T = "PIB — setores (acum. 4 trimestres)"
for id_, nome, cod in [("pib_agro", "Agropecuária", AGRO), ("pib_ind", "Indústria", IND), ("pib_serv", "Serviços", SERV),
                       ("pib_transf", "Indústria de transformação", TRANSF), ("pib_extr", "Indústria extrativa", EXTR),
                       ("pib_constr", "Construção", CONSTR), ("pib_elet", "Eletricidade, gás e água", ELET),
                       ("pib_com", "Comércio", COM), ("pib_transp", "Transporte e armazenagem", TRANSP),
                       ("pib_info", "Informação e comunicação", INFO), ("pib_fin", "Atividades financeiras", FIN),
                       ("pib_imob", "Atividades imobiliárias", IMOB), ("pib_adm", "Administração pública, saúde e educação", ADM),
                       ("pib_outros", "Outros serviços", OUTROS)]:
    serie(id_, "ibge", T, nome, "taxa", "%", "trimestral", I + "5932 (var. % acumulada em 4 trimestres)", lambda c=cod: sidra(5932, ACUM_4T, c))

T = "PIB — demanda (acum. 4 trimestres)"
for id_, nome, cod in [("pib_familias", "Consumo das famílias", FAM), ("pib_governo", "Consumo do governo", GOV),
                       ("pib_fbcf", "Investimento (FBCF)", FBCF), ("pib_exp", "Exportações de bens e serviços", EXP),
                       ("pib_imp", "Importações de bens e serviços", IMP)]:
    serie(id_, "ibge", T, nome, "taxa", "%", "trimestral", I + "5932 (var. % acumulada em 4 trimestres)", lambda c=cod: sidra(5932, ACUM_4T, c))

# Banco Central
T = "Juros e inflação"
serie("selic_meta", "bcb", T, "Selic meta", "taxa", "% a.a.", "Copom", B + "432", lambda: so_mudancas(sgs(432, date(1999, 3, 5))), cor="--c-cinza", degrau=True)
# 12 meses só depois de jun/1995: antes a janela inclui meses pré-Real
serie("ipca_12m", "bcb", T, "IPCA 12 meses", "taxa", "%", "mensal", B + "13522", lambda: [p for p in mensal(sgs(13522)) if p[0] >= date(1995, 6, 30)], cor="--c-vermelho")
serie("ipca_acum", "bcb", T, "IPCA acumulado", "nivel", "índice", "mensal", B + "433 (acumulado, 30/06/1994 = 100)", lambda: acumulado(mensal(sgs(433)), BASE), cor="--c-vermelho")
serie("selic_acum", "bcb", T, "Selic acumulada", "nivel", "índice", "diária", B + "11 (acumulado, 30/06/1994 = 100)", lambda: acumulado(sgs(11), BASE), cor="--c-cinza", traco=True)
serie("ipca_mensal", "bcb", T, "IPCA mensal", "taxa", "% a.m.", "mensal", B + "433", lambda: mensal(sgs(433)), cor="--c-magenta")
serie("igpm_acum", "bcb", T, "IGP-M acumulado", "nivel", "índice", "mensal", B + "189 (acumulado, 30/06/1994 = 100)", lambda: acumulado(mensal(sgs(189)), BASE), cor="--c-amarelo")
serie("cdi_acum", "bcb", T, "CDI acumulado", "nivel", "índice", "diária", B + "12 (acumulado, 30/06/1994 = 100)", lambda: acumulado(sgs(12), BASE), cor="--c-aqua")
serie("inpc_acum", "bcb", T, "INPC acumulado", "nivel", "índice", "mensal", B + "188 (acumulado, 30/06/1994 = 100)", lambda: acumulado(mensal(sgs(188)), BASE), cor="--c-violeta")

T = "Juros futuros e expectativas"
serie("selic_focus", "bcb", T, "Selic esperada p/ fim do ano seguinte (Focus)", "taxa", "% a.a.", "diária", "Banco Central do Brasil — pesquisa Focus (mediana)", focus_selic_ano_seguinte, cor="--c-cinza")
serie("ipca_focus", "bcb", T, "IPCA esperado 12 meses à frente (Focus)", "taxa", "%", "diária", "Banco Central do Brasil — pesquisa Focus (mediana, suavizada)", focus_ipca_12m, cor="--c-vermelho", traco=True)

T = "Atividade e emprego"
serie("pib_us", "bcb", T, "PIB em US$ (12 meses)", "nivel", "US$ tri", "mensal", B + "4385 (PIB mensal estimado pelo BCB, soma de 12 meses)", lambda: escala(soma_movel(mensal(sgs(4385)), 12), 1 / 1e6), cor="--c-verde", traco=True)
serie("ibcbr", "bcb", T, "Índice de atividade econômica (IBC-Br)", "nivel", "índice", "mensal", B + "24364 (com ajuste sazonal)", lambda: mensal(sgs(24364, date(2003, 1, 1))), cor="--c-laranja", traco=True)
serie("desocupacao", "bcb", T, "Desemprego", "taxa", "%", "mensal", B + "24369 (IBGE, PNAD Contínua)", lambda: mensal(sgs(24369, date(2012, 3, 1))), cor="--c-violeta")

T = "Crédito"
serie("icc", "bcb", T, "Custo do crédito (ICC)", "taxa", "% a.a.", "mensal", B + "25351", lambda: mensal(sgs(25351, date(2013, 3, 1))), cor="--c-amarelo")
serie("concessoes", "bcb", T, "Concessões recursos livres", "nivel", "R$ bi", "mensal", B + "20634, R$ bilhões", lambda: escala(mensal(sgs(20634, date(2011, 3, 1))), 1 / 1000), cor="--c-aqua", traco=True)

T = "Balança comercial"
serie("bal_saldo12", "bcb", T, "Saldo comercial (12 meses)", "fluxo", "US$ bi", "12 meses", B + "22707 (balanço de pagamentos), soma de 12 meses", lambda: soma_movel(sgs_bi(22707), 12), cor="--c-azul")
serie("bal_exp12", "bcb", T, "Exportações (12 meses)", "fluxo", "US$ bi", "12 meses", B + "22708, soma de 12 meses", lambda: soma_movel(sgs_bi(22708), 12), cor="--c-verde")
serie("bal_imp12", "bcb", T, "Importações (12 meses)", "fluxo", "US$ bi", "12 meses", B + "22709, soma de 12 meses", lambda: soma_movel(sgs_bi(22709), 12), cor="--c-vermelho")
serie("bal_corrente12", "bcb", T, "Corrente de comércio (12 meses)", "fluxo", "US$ bi", "12 meses", B + "22708 + 22709, soma de 12 meses",
      lambda: combina(soma_movel(sgs_bi(22708), 12), soma_movel(sgs_bi(22709), 12), lambda a, b: a + b), cor="--c-violeta")
serie("bal_saldo", "bcb", T, "Saldo comercial mensal", "fluxo", "US$ bi", "mensal", B + "22707", lambda: sgs_bi(22707), cor="--c-azul", traco=True)
serie("bal_exp", "bcb", T, "Exportações mensais", "fluxo", "US$ bi", "mensal", B + "22708", lambda: sgs_bi(22708), cor="--c-verde", traco=True)
serie("bal_imp", "bcb", T, "Importações mensais", "fluxo", "US$ bi", "mensal", B + "22709", lambda: sgs_bi(22709), cor="--c-vermelho", traco=True)

T = "Balança comercial — subgrupos (12 meses)"
serie("bal_merc_exp12", "bcb", T, "Exportações de mercadorias em geral", "fluxo", "US$ bi", "12 meses", B + "22711, soma de 12 meses", lambda: soma_movel(sgs_bi(22711), 12), cor="--c-verde")
serie("bal_merc_imp12", "bcb", T, "Importações de mercadorias em geral", "fluxo", "US$ bi", "12 meses", B + "22712, soma de 12 meses", lambda: soma_movel(sgs_bi(22712), 12), cor="--c-vermelho")
serie("bal_merc_saldo12", "bcb", T, "Saldo de mercadorias em geral", "fluxo", "US$ bi", "12 meses", B + "22710, soma de 12 meses", lambda: soma_movel(sgs_bi(22710), 12), cor="--c-azul")
serie("bal_ouro_exp12", "bcb", T, "Exportações de ouro não monetário", "fluxo", "US$ bi", "12 meses", B + "22717, soma de 12 meses", lambda: soma_movel(sgs_bi(22717), 12), cor="--c-amarelo")
serie("bal_ouro_imp12", "bcb", T, "Importações de ouro não monetário", "fluxo", "US$ bi", "12 meses", B + "22718, soma de 12 meses", lambda: soma_movel(sgs_bi(22718), 12), cor="--c-amarelo", traco=True)
serie("bal_merch12", "bcb", T, "Saldo de merchanting", "fluxo", "US$ bi", "12 meses", B + "22713, soma de 12 meses", lambda: soma_movel(sgs_bi(22713), 12), cor="--c-magenta")

T = "Serviços (12 meses)"
serie("serv_saldo12", "bcb", T, "Saldo de serviços", "fluxo", "US$ bi", "12 meses", B + "22704 − 22707 (bens e serviços − bens), soma de 12 meses",
      lambda: combina(soma_movel(sgs_bi(22704), 12), soma_movel(sgs_bi(22707), 12), lambda a, b: a - b), cor="--c-azul")
serie("serv_rec12", "bcb", T, "Receitas de serviços", "fluxo", "US$ bi", "12 meses", B + "22705 − 22708, soma de 12 meses",
      lambda: combina(soma_movel(sgs_bi(22705), 12), soma_movel(sgs_bi(22708), 12), lambda a, b: a - b), cor="--c-verde")
serie("serv_desp12", "bcb", T, "Despesas de serviços", "fluxo", "US$ bi", "12 meses", B + "22706 − 22709, soma de 12 meses",
      lambda: combina(soma_movel(sgs_bi(22706), 12), soma_movel(sgs_bi(22709), 12), lambda a, b: a - b), cor="--c-vermelho")

T = "Setor externo e câmbio"
serie("dolar", "bcb", T, "Dólar (PTAX)", "nivel", "R$", "diária", B + "1 (PTAX venda)", lambda: sgs(1), cor="--c-verde")
# 11752 = contra a cesta de moedas dos parceiros comerciais (a 11753 é só contra o dólar, IPCA/CPI)
serie("cambio_real", "bcb", T, "Câmbio real efetivo", "nivel", "índice", "mensal",
      B + "11752 (cesta de moedas dos parceiros comerciais, deflacionada pelo IPCA; jun/1994 = 100; alta = real mais desvalorizado)",
      lambda: mensal(sgs(11752, date(1994, 6, 1))), cor="--c-laranja")
serie("trans_corr", "bcb", T, "Transações correntes", "taxa", "% PIB", "12 meses", B + "23079", lambda: mensal(sgs(23079)), cor="--c-verde", traco=True)
serie("idp", "bcb", T, "IDP líquido", "taxa", "% PIB", "12 meses", B + "23080", lambda: mensal(sgs(23080)), cor="--c-aqua")
serie("reservas", "bcb", T, "Reservas internacionais", "nivel", "US$ bi", "diária", B + "13621 (conceito caixa)", lambda: escala(sgs(13621), 1 / 1000), cor="--c-violeta", traco=True)
serie("euro", "bcb", T, "Euro (PTAX)", "nivel", "R$", "diária", B + "21619 (PTAX venda)", lambda: sgs(21619, date(1999, 1, 1)), cor="--c-magenta", traco=True)

T = "Fiscal (+ superávit, − déficit)"
# NFSP positiva = déficit; o sinal é invertido para superávit aparecer positivo
serie("primario", "bcb", T, "Resultado primário", "taxa", "% PIB", "12 meses", B + "5793 (sinal invertido: + = superávit)", lambda: escala(mensal(sgs(5793)), -1), cor="--c-azul", traco=True)
serie("nominal", "bcb", T, "Resultado nominal", "taxa", "% PIB", "12 meses", B + "5727 (sinal invertido: + = superávit)", lambda: escala(mensal(sgs(5727)), -1), cor="--c-vermelho", traco=True)


# Tesouro Direto: equivalente oficial e aberto ao "DI futuro" (B3 não tem acesso aberto; swap DI×pré do BCB parou em 2019)
T = "Juros futuros (prefixados)"
TD = "Tesouro Nacional — Tesouro Direto (taxa de compra do Tesouro Prefixado, interpolada para {})"
serie("juro_pre_1a", "tesouro", T, "Juro prefixado 1 ano", "taxa", "% a.a.", "diária", TD.format("365 dias"), lambda: juro_prefixado(365), cor="--c-azul")
serie("juro_pre_2a", "tesouro", T, "Juro prefixado 2 anos", "taxa", "% a.a.", "diária", TD.format("730 dias"), lambda: juro_prefixado(730), cor="--c-violeta")
serie("juro_pre_5a", "tesouro", T, "Juro prefixado 5 anos", "taxa", "% a.a.", "diária", TD.format("1.826 dias"), lambda: juro_prefixado(1826), cor="--c-magenta")


def gravar_catalogo():
    """Índice lido pela página: fontes > temas > séries, na ordem de importância."""
    fontes, series, usadas = [], {}, {}
    for s in CATALOGO:
        f = next((x for x in fontes if x["id"] == s["fonte"]), None)
        if not f:
            f = {"id": s["fonte"], **FONTES[s["fonte"]], "temas": []}
            fontes.append(f)
        t = next((x for x in f["temas"] if x["nome"] == s["tema"]), None)
        if not t:
            t = {"nome": s["tema"], "series": []}
            f["temas"].append(t)
        t["series"].append(s["id"])
        cor, traco = s["cor"], s["traco"]
        if not cor:   # cores automáticas: paleta em ordem dentro do tema, tracejada na segunda volta
            n = usadas.get(s["tema"], 0)
            usadas[s["tema"]] = n + 1
            cor, traco = PALETA[n % len(PALETA)], n >= len(PALETA)
        series[s["id"]] = {k: s[k] for k in ("nome", "tipo", "unid", "freq", "origem")} | {"cor": cor, "traco": traco, "degrau": s["degrau"]}
    ordem = list(FONTES)
    fontes.sort(key=lambda f: ordem.index(f["id"]))
    (PASTA / "catalogo.json").write_text(json.dumps({"fontes": fontes, "series": series}, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    PASTA.mkdir(exist_ok=True)
    gravar_catalogo()
    pedidas = set(sys.argv[1:])
    falhas = 0
    for s in CATALOGO:
        if pedidas and s["id"] not in pedidas:
            continue
        try:
            gravar(s["id"], s["origem"], s["fn"]())
        except Exception as e:
            falhas += 1
            print(f"{s['id']:16} FALHOU: {e}", flush=True)
    # sai com erro só se quase tudo falhou (fonte fora do ar); falhas isoladas mantêm o arquivo anterior
    if falhas and falhas >= len([s for s in CATALOGO if not pedidas or s["id"] in pedidas]) * 0.5:
        sys.exit(1)
