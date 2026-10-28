"""Gera o site estático (index.html + app.js) a partir de series-historicas.html, a página do artifact.

O artifact recebe <!doctype>/<head> na publicação; aqui o documento é montado completo,
o script vai para app.js (para a política de segurança proibir scripts embutidos) e o
ECharts é servido de vendor/ (sem depender de CDN de terceiros).

Uso:  python -I scripts/gerar_site.py
"""
import re
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
fonte = (RAIZ / "series-historicas.html").read_text(encoding="utf-8")

titulo = re.search(r"<title>.*?</title>", fonte, re.S).group(0)
links = "\n".join(re.findall(r"<link [^>]*>", fonte))
estilo = re.search(r"<style>.*?</style>", fonte, re.S).group(0)
corpo = fonte[fonte.index("</style>") + len("</style>"):fonte.index("<script src=")].strip()
script = re.search(r"<script>\n(.*?)</script>", fonte, re.S).group(1)

# Política de segurança: só scripts do próprio site, dados só do próprio site, fontes do Google.
CSP = ("default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' data:; "
       "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; "
       "base-uri 'none'; form-action 'none'; object-src 'none'; manifest-src 'self'")

# reset que o artifact injeta na publicação (a página depende dele)
RESET = """<style>
:root { color-scheme: light; padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }
body { margin: 0; font: 14px system-ui, -apple-system, "Segoe UI", sans-serif; }
img { max-width: 100%; }
[hidden] { display: none !important; }
</style>"""

html = f"""<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="{CSP}">
<meta name="referrer" content="no-referrer">
<meta name="description" content="Séries históricas do Brasil — Ibovespa, Selic, IPCA, PIB, balança comercial e mais, em gráficos interativos. Dados oficiais do Banco Central e do IBGE.">
{titulo}
{RESET}
{links}
{estilo}
</head>
<body>
{corpo}
<script src="vendor/echarts.min.js"></script>
<script src="app.js"></script>
</body>
</html>
"""
(RAIZ / "index.html").write_text(html, encoding="utf-8")
(RAIZ / "app.js").write_text(script, encoding="utf-8")
print(f"index.html ({len(html):,} bytes) e app.js ({len(script):,} bytes) gerados")
