(() => {
  // ---------- catálogo ----------
  // Vem de dados/catalogo.json, gerado por scripts/atualizar_dados.py (fontes > temas > séries, em ordem de importância).
  // tipo 'nivel': preços e índices (comparáveis em % desde o início do período)
  // tipo 'taxa': valores já em % (juros, inflação, % do PIB)
  // tipo 'fluxo': montantes que podem ser negativos (saldo comercial); nunca viram %
  let CAT = {}, FONTES = [];
  // Mandatos presidenciais (Dilma até o afastamento; Temer desde a interinidade)
  const GOVERNOS = [
    { nome: 'Sarney', ini: '1985-03-15', fim: '1990-03-14', cor: '--g-sarney' },
    { nome: 'Collor', ini: '1990-03-15', fim: '1992-10-01', cor: '--g-collor' },
    { nome: 'Itamar', ini: '1992-10-02', fim: '1994-12-31', cor: '--g-itamar' },
    { nome: 'FHC', ini: '1995-01-01', fim: '2002-12-31', cor: '--g-fhc' },
    { nome: 'Lula', ini: '2003-01-01', fim: '2010-12-31', cor: '--g-lula' },
    { nome: 'Dilma', ini: '2011-01-01', fim: '2016-05-11', cor: '--g-dilma' },
    { nome: 'Temer', ini: '2016-05-12', fim: '2018-12-31', cor: '--g-temer' },
    { nome: 'Bolsonaro', ini: '2019-01-01', fim: '2022-12-31', cor: '--g-bolsonaro' },
    { nome: 'Lula', ini: '2023-01-01', fim: null, cor: '--g-lula' },
  ].map(g => ({ ...g, t0: Date.parse(g.ini), t1: g.fim ? Date.parse(g.fim) : Infinity }));
  const govEm = ts => GOVERNOS.find(g => ts >= g.t0 && ts <= g.t1);

  const DIA = 864e5;
  const $ = id => document.getElementById(id);
  const fmtN = (v, d) => v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtP = (f, d = 2) => (f > 0 ? '+' : f < 0 ? '−' : '') + fmtN(Math.abs(f) * 100, d) + '%';
  const fmtPP = d => (d > 0 ? '+' : d < 0 ? '−' : '') + fmtN(Math.abs(d), 2) + ' p.p.';
  const fmtD = ts => new Date(ts).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
  const fmtM = ts => new Date(ts).toLocaleDateString('pt-BR', { month: 'short', year: 'numeric', timeZone: 'UTC' }).replace('. de ', ' ').replace(' de ', ' ');
  const fmtData = ts => st.freq === 'm' ? fmtM(ts) : fmtD(ts);
  const iso = ts => new Date(ts).toISOString().slice(0, 10);
  const classe = f => f > 0 ? 'up' : f < 0 ? 'down' : '';
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function fmtVal(id, v) {
    const u = CAT[id].unid;
    if (u === 'pts') return fmtN(v, Math.abs(v) < 1000 ? 2 : 0);
    if (u === 'R$') return 'R$ ' + fmtN(v, 2);
    const m = u.match(/^(R\$|US\$) (bi|tri)$/);
    if (m) return (v < 0 ? '−' : '') + m[1] + ' ' + fmtN(Math.abs(v), m[2] === 'tri' ? 2 : 1) + ' ' + m[2];
    if (u[0] === '%') return fmtN(v, 2) + '%';
    return fmtN(v, v < 1000 ? 1 : 0);
  }
  // séries que não viram "% desde o início" (taxas e fluxos): diferença na própria unidade
  const bruto = id => CAT[id].tipo !== 'nivel';
  const fmtDif = (id, d) => CAT[id].unid[0] === '%' ? fmtPP(d) : (d > 0 ? '+' : d < 0 ? '−' : '') + fmtVal(id, Math.abs(d));

  // ---------- tema claro/escuro (lembrado neste navegador) ----------
  const raiz = document.documentElement;
  const temaAtual = () => raiz.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const marcaTema = () => document.querySelectorAll('#seg-tema button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === temaAtual()));
  try { const t = localStorage.getItem('tema'); if (t === 'light' || t === 'dark') raiz.dataset.theme = t; } catch (e) {}
  $('seg-tema').onclick = e => {
    const v = e.target.closest('button')?.dataset.v;
    if (!v) return;
    raiz.dataset.theme = v;
    try { localStorage.setItem('tema', v); } catch (e) {}
  };
  new MutationObserver(marcaTema).observe(raiz, { attributes: true, attributeFilter: ['data-theme'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', marcaTema);
  marcaTema();

  // grupos: cada grupo é um painel do gráfico, de cima para baixo
  const st = { freq: 'd', modo: 'val', log: false, ini: null, fim: null, pinos: [], grupos: [['ibovespa']], ref: 'ibovespa', gov: false,
    eixos: 'escala', yz: {}, solto: new Set(),
    escala: new Set() };   // painéis (1ª série) com a barra de escala aberta   // solto: séries com eixo próprio mesmo dividindo unidade   // yz: janela vertical [início%, fim%] de cada eixo no modo "por unidade"
  const series = {};      // id -> { d: [[ts, v]], m: [[ts, v]], meta }
  const carregando = {};  // id -> Promise
  let chart = null, extMin = 0, extMax = 0;
  const ativos = () => st.grupos.flat();

  // ---------- dados ----------
  function mensal(d) {
    const out = [];
    for (const p of d) {
      const k = new Date(p[0]).getUTCFullYear() * 12 + new Date(p[0]).getUTCMonth();
      if (out.length && out[out.length - 1].k === k) out[out.length - 1].p = p;
      else out.push({ k, p });
    }
    return out.map(o => o.p);
  }
  // taxa em degrau (Selic meta): repete o valor a cada semana para o zoom não perder o trecho
  function densificar(d) {
    const out = [];
    for (let i = 0; i < d.length; i++) {
      out.push(d[i]);
      const prox = i + 1 < d.length ? d[i + 1][0] : null;
      if (prox) for (let t = d[i][0] + 7 * DIA; t < prox; t += 7 * DIA) out.push([t, d[i][1]]);
    }
    return out;
  }
  function carregar(id) {
    if (series[id]) return Promise.resolve();
    if (!carregando[id]) {
      carregando[id] = fetch('dados/' + id + '.json')
        .then(r => r.ok ? r.json() : Promise.reject(new Error(id)))
        .then(j => {
          let d = j.d.map(([dt, v]) => [Date.parse(dt), v]);
          if (CAT[id].degrau) d = densificar(d);
          series[id] = { d, m: mensal(d), meta: j };
        })
        .finally(() => { delete carregando[id]; });
    }
    return carregando[id];
  }
  function primeiroDesde(arr, ts) {
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid][0] < ts) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function perto(arr, ts) {
    let i = primeiroDesde(arr, ts);
    if (i > 0 && Math.abs(arr[i - 1][0] - ts) < Math.abs(arr[i][0] - ts)) i--;
    return i;
  }
  // último ponto com data <= ts; null fora da série (trimestral aceita até ~100 dias de atraso)
  function pontoEm(arr, ts) {
    if (ts < arr[0][0] || ts > arr[arr.length - 1][0] + (arr.length > 1 && arr[1][0] - arr[0][0] > 200 * DIA ? 370 : 100) * DIA) return null;
    let i = primeiroDesde(arr, ts);
    if (arr[i][0] > ts) i--;
    return i >= 0 ? arr[i] : null;
  }
  const brutos = id => series[id][st.freq];
  const grupoDe = id => st.grupos.findIndex(g => g.includes(id));
  // séries em % (juros, inflação, % PIB) dividem o mesmo eixo; as demais, por unidade
  const chaveUnid = id => CAT[id].unid[0] === '%' ? '%' : CAT[id].unid;
  // eixos de um painel no modo "por unidade": mesma unidade = eixo ligado, salvo séries "desligadas" (st.solto)
  const divideEixo = (id, g) => g.filter(x => chaveUnid(x) === chaveUnid(id)).length > 1;
  function eixosDe(g) {
    const out = [];
    for (const id of g) {
      const u = chaveUnid(id) + (st.solto.has(id) && divideEixo(id, g) ? '#' + id : '');
      let e = out.find(x => x.u === u);
      if (!e) out.push(e = { u, ids: [] });
      e.ids.push(id);
    }
    return out;
  }
  function unidadesDe(g) {
    const out = [];
    for (const id of g) {
      const u = chaveUnid(id);
      let e = out.find(x => x.u === u);
      if (!e) out.push(e = { u, ids: [] });
      e.ids.push(id);
    }
    return out;
  }

  // como cada painel mostra seus valores
  function info(g) {
    const nN = g.filter(id => CAT[id].tipo === 'nivel').length, temTaxa = g.some(bruto);
    // eixo por unidade: séries de unidades diferentes no valor original, cada unidade com seu eixo
    if (st.eixos === 'escala' && eixosDe(g).length > 1) return { nN, temTaxa, pct: false, log: false, indice: false, indep: true };
    const pct = nN > 1 || (nN === 1 && temTaxa) || (nN === 1 && st.modo === 'pct');
    const log = st.log && !temTaxa;
    return { nN, temTaxa, pct, log, indice: pct && log, indep: false };
  }
  function base(id) { const a = brutos(id); return a[primeiroDesde(a, st.ini ?? extMin)][1]; }
  function transf(id) {
    const I = info(st.grupos[grupoDe(id)]);
    if (bruto(id) || !I.pct) return v => v;
    const b = base(id);
    return I.indice ? v => v / b * 100 : v => (v / b - 1) * 100;
  }
  function exibidos(id) {
    const f = transf(id), a = brutos(id);
    return a.map(p => [p[0], f(p[1])]);
  }
  const emPct = id => CAT[id].tipo === 'nivel' && info(st.grupos[grupoDe(id)]).pct;

  // ---------- cores do tema ----------
  function cores() {
    const cs = getComputedStyle(raiz);
    const g = n => cs.getPropertyValue(n).trim();
    return { fg: g('--fg'), fg2: g('--fg2'), muted: g('--muted'), line: g('--line'), axis: g('--axis'), panel: g('--panel'), bg: g('--bg'),
      accent: g('--accent'), soft: g('--accent-soft'), pin: g('--pin'), band: g('--band'), up: g('--up'), down: g('--down'), cor: g };
  }
  function hexA(hex, a) {
    const n = parseInt(hex.replace('#', ''), 16);
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
  }

  // ---------- gráfico ----------
  // margens iguais em todos os painéis (eixos X alinhados); no modo "por série" abrem espaço
  // para o 2º eixo à esquerda e para as barras verticais à direita
  // valor inicial fixo: o catálogo ainda não carregou quando o script começa (opcao() recalcula)
  let MARG = { esq: 14, dir: 96, topo: 26, baixo: 74, vao: 34 }, yBase = [];
  const movel = () => matchMedia('(max-width: 640px)').matches;
  function margens() {
    const ind = st.grupos.filter(g => info(g).indep), m = movel();
    // barras de escala só nos painéis abertos pelo clique no rótulo
    const abertos = st.grupos.filter(g => st.escala.has(g[0]));
    const n = Math.max(0, ...abertos.map(g => info(g).indep ? eixosDe(g).length : 1));
    return { esq: ind.length ? (m ? 46 : 70) : (m ? 6 : 14), dir: (m ? 48 : 74) + (n ? n * 16 + 6 : 0),
      topo: 26, baixo: m ? 58 : 74, vao: m ? 30 : 34 };
  }
  const passo = v => Math.abs(v) < 10 && v % 1 ? 1 : 0;
  function fmtEixo(id, v) {
    const u = CAT[id].unid;
    if (u[0] === '%') return fmtN(v, passo(v)) + '%';
    if (u === 'R$') return fmtN(v, 2);
    return fmtN(v, v < 100 && v % 1 ? 1 : 0);
  }
  function layout() {
    const N = st.grupos.length, H = chart.getHeight();
    const util = H - MARG.topo - MARG.baixo - MARG.vao * (N - 1);
    const pesos = st.grupos.map((_, i) => i === 0 ? 1.5 : 1), soma = pesos.reduce((a, b) => a + b, 0);
    let y = MARG.topo;
    return pesos.map(p => { const h = Math.round(util * p / soma), r = { top: y, height: h }; y += h + MARG.vao; return r; });
  }
  function opcao() {
    MARG = margens();
    const fsz = movel() ? 10 : 11;
    const c = cores(), L = layout(), N = st.grupos.length, mono = 'IBM Plex Mono, monospace';
    const so = ativos().length === 1;
    const grids = L.map(l => ({ left: MARG.esq, right: MARG.dir, top: l.top, height: l.height }));
    const eixosX = st.grupos.map((g, i) => ({
      type: 'time', gridIndex: i, min: extMin, max: extMax,
      axisLine: { lineStyle: { color: c.axis } }, axisTick: { show: false },
      axisLabel: { show: i === N - 1, color: c.muted, hideOverlap: true, fontSize: fsz },
      splitLine: { show: false },
      axisPointer: { label: { show: i === N - 1, formatter: q => fmtData(q.value) } },
    }));
    // eixos Y: um por painel; no modo "por unidade", um por unidade (1º à direita, 2º à esquerda, demais ocultos).
    // Todo eixo ganha uma barra vertical à direita do painel para ajustar mínimo e máximo.
    // Em escala linear a extensão do eixo é 3× a faixa dos dados e a barra começa no terço do meio,
    // para poder abrir (afastar) ou fechar (aproximar); em log a barra só aproxima.
    const eixosY = [], yIdx = {}, barras = [];
    const folga = v => (v.max - v.min) || Math.abs(v.max) || 1;
    const barra = (chave, idx, l, k, cor, log) => {
      const w = st.yz[chave] || (log ? [0, 100] : [100 / 3, 200 / 3]);
      // painel com a escala fechada: zoom invisível que só mantém a janela escolhida
      if (!st.escala.has(chave.split('|')[0])) {
        barras.push({ id: 'y-' + chave, type: 'inside', yAxisIndex: idx, filterMode: 'none', start: w[0], end: w[1],
          zoomOnMouseWheel: false, moveOnMouseMove: false, moveOnMouseWheel: false, preventDefaultMouseMove: false });
        return;
      }
      barras.push({
        id: 'y-' + chave, type: 'slider', yAxisIndex: idx, orient: 'vertical', filterMode: 'none',
        start: w[0], end: w[1], top: l.top, height: l.height, right: 8 + k * 16, width: 10,
        showDetail: false, showDataShadow: false, brushSelect: false, moveHandleSize: 0,
        borderColor: 'transparent', backgroundColor: c.line, fillerColor: hexA(cor, .5),
        handleSize: '140%', handleStyle: { color: c.panel, borderColor: cor, borderWidth: 1.5 },
      });
    };
    yBase = [];
    st.grupos.forEach((g, i) => {
      const I = info(g), id0 = g[0];
      yBase[i] = eixosY.length;
      if (I.indep) {
        eixosDe(g).forEach((e, k) => {
          const id = e.ids[0], so1 = e.ids.length === 1;
          const cor = so1 ? c.cor(CAT[id].cor) : c.fg2;
          const idx = eixosY.length;
          e.ids.forEach(x => { yIdx[x] = idx; });
          eixosY.push({
            type: 'value', gridIndex: i, position: k === 1 ? 'left' : 'right',
            min: v => v.min - folga(v), max: v => v.max + folga(v), splitNumber: i === 0 ? (movel() ? 4 : 5) : (movel() ? 2 : 3),
            axisLine: { show: k < 2, lineStyle: { color: cor, width: 2, type: so1 && CAT[id].traco ? 'dashed' : 'solid' } },
            axisTick: { show: false },
            axisLabel: { show: k < 2, color: c.muted, fontSize: fsz, fontFamily: mono, formatter: v => fmtEixo(id, v) },
            splitLine: { show: k === 0, lineStyle: { color: c.line } },
            axisPointer: k < 2 ? { label: { formatter: q => so1 ? fmtVal(id, q.value) : fmtEixo(id, q.value) } } : { show: false },
          });
          barra(g[0] + '|' + e.u, idx, L[i], k, cor, false);
        });
        return;
      }
      const fmt = (v, d) => I.nN === 0 ? fmtEixo(id0, v)
        : I.indice ? fmtP(v / 100 - 1, d)
        : I.pct ? (v > 0 ? '+' : v < 0 ? '−' : '') + fmtN(Math.abs(v), d) + '%'
        : CAT[id0].unid === 'R$' ? fmtN(v, 2) : fmtN(v, v < 100 ? 1 : 0);
      const idx = eixosY.length, cor = g.length === 1 ? c.cor(CAT[id0].cor) : c.fg2;
      g.forEach(id => { yIdx[id] = idx; });
      eixosY.push({
        type: I.log ? 'log' : 'value', logBase: 10, gridIndex: i, position: 'right',
        ...(I.log ? { scale: true } : { min: v => v.min - folga(v), max: v => v.max + folga(v) }),
        splitNumber: i === 0 ? (movel() ? 4 : 5) : (movel() ? 2 : 3),
        axisLabel: { color: c.muted, fontSize: fsz, fontFamily: mono, formatter: v => fmt(v, passo(v)) },
        splitLine: { lineStyle: { color: c.line } },
        axisPointer: { label: { formatter: q => I.pct ? fmt(q.value, 1) : fmtVal(id0, q.value) } },
      });
      barra(g[0] + '|comum' + (I.log ? '-log' : '') + (I.pct ? '-pct' : ''), idx, L[i], 0, cor, I.log);
    });
    const lista = [];
    st.grupos.forEach((g, gi) => {
      g.forEach((id, k) => {
        const cor = c.cor(CAT[id].cor);
        lista.push({
          id, name: CAT[id].nome, type: 'line', xAxisIndex: gi, yAxisIndex: yIdx[id], data: exibidos(id),
          step: CAT[id].degrau ? 'end' : false, z: 3,
          showSymbol: false, symbol: 'circle', symbolSize: 8, sampling: 'lttb',
          lineStyle: { width: 2, color: cor, type: CAT[id].traco ? [6, 3] : 'solid' },
          itemStyle: { color: cor, borderColor: c.panel, borderWidth: 2 },
          emphasis: { disabled: true },
          areaStyle: so ? { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: hexA(cor, .20) }, { offset: 1, color: hexA(cor, 0) }]) } : undefined,
          ...marcas(c, id, gi, k),
        });
      });
      if (st.gov) lista.push(serieGov(c, g, gi));
    });
    return {
      useUTC: true, animation: false,
      textStyle: { fontFamily: 'IBM Plex Sans, system-ui, sans-serif' },
      grid: grids, xAxis: eixosX, yAxis: eixosY,
      graphic: titulos(c, L),
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      tooltip: {
        trigger: 'axis', confine: true, transitionDuration: 0,
        backgroundColor: c.panel, borderColor: c.line, borderWidth: 1, padding: [8, 12],
        textStyle: { color: c.fg, fontSize: 13 },
        extraCssText: 'box-shadow:0 6px 24px rgba(0,0,0,.14);border-radius:10px;',
        axisPointer: {
          type: 'cross', snap: false,
          lineStyle: { color: c.muted, type: 'dashed', width: 1 },
          crossStyle: { color: c.muted, type: 'dashed', width: 1 },
          label: { backgroundColor: c.fg, color: c.panel, fontFamily: mono, fontSize: fsz },
        },
        formatter: tooltip,
      },
      dataZoom: [
        { id: 'x-in', type: 'inside', xAxisIndex: st.grupos.map((_, i) => i), filterMode: 'filter', startValue: st.ini, endValue: st.fim, minValueSpan: 7 * DIA },
        { id: 'x-sl', type: 'slider', xAxisIndex: st.grupos.map((_, i) => i), filterMode: 'filter', startValue: st.ini, endValue: st.fim, minValueSpan: 7 * DIA,
          height: movel() ? 28 : 38, bottom: 10, showDetail: !movel(), left: MARG.esq + 4, right: MARG.dir, brushSelect: true,
          borderColor: c.line, backgroundColor: 'transparent', fillerColor: c.soft,
          dataBackground: { lineStyle: { color: c.axis, width: 1 }, areaStyle: { color: c.line, opacity: .6 } },
          selectedDataBackground: { lineStyle: { color: c.accent, width: 1 }, areaStyle: { color: c.accent, opacity: .15 } },
          handleStyle: { color: c.panel, borderColor: c.accent, borderWidth: 1.5 },
          moveHandleStyle: { color: c.accent, opacity: .5 }, emphasis: { moveHandleStyle: { color: c.accent, opacity: .9 } },
          textStyle: { color: c.muted, fontSize: fsz }, labelFormatter: v => fmtD(v) },
        ...barras,
      ],
      series: lista,
    };
  }

  // título de cada painel (canto superior esquerdo): número do gráfico + séries com a cor/traço de cada linha
  const medir = (() => { const cv = document.createElement('canvas').getContext('2d'); return (t, f) => { cv.font = f; return cv.measureText(t).width; }; })();
  // caixas dos títulos (em pixels do gráfico): clicar nelas abre/fecha a barra de escala do painel
  let caixasTitulo = [];
  function titulos(c, L) {
    const m = movel();
    const f = `500 ${m ? 11 : 12}px IBM Plex Sans, system-ui, sans-serif`, fn = '600 11px IBM Plex Mono, monospace';
    const fs = `400 ${m ? 9 : 10}px IBM Plex Sans, system-ui, sans-serif`;
    const larguraMax = chart.getWidth() - MARG.esq - MARG.dir - 16, ALT = 34;
    caixasTitulo = [];
    return L.map((l, i) => {
      const filhos = [], aberta = st.escala.has(st.grupos[i][0]);
      let x = 8, y = 0, maxX = 0;
      if (st.grupos.length > 1) {
        filhos.push({ type: 'text', style: { text: String(i + 1), x, y: 17, verticalAlign: 'middle', fill: c.muted, font: fn } });
        x += medir(String(i + 1), fn) + 10;
      }
      const x0 = x;
      for (const id of st.grupos[i]) {
        // abaixo do nome, pequeno: só a fonte (sem o detalhe entre parênteses)
        const sub = (CAT[id].origem || '').split(' (')[0].replace(/,? soma de 12 meses$/, '');
        const w = 20 + Math.max(medir(CAT[id].nome, f), medir(sub, fs)) + 14;
        if (x > x0 && x + w > larguraMax) { maxX = Math.max(maxX, x); x = x0; y += ALT; }   // quebra de linha
        filhos.push({ type: 'line', shape: { x1: x, y1: y + 11, x2: x + 14, y2: y + 11 },
          style: { stroke: c.cor(CAT[id].cor), lineWidth: 3, lineCap: 'round', lineDash: CAT[id].traco ? [4, 3] : null } });
        filhos.push({ type: 'text', style: { text: CAT[id].nome, x: x + 20, y: y + 11, verticalAlign: 'middle', fill: c.fg, font: f } });
        filhos.push({ type: 'text', style: { text: sub, x: x + 20, y: y + 25, verticalAlign: 'middle', fill: c.muted, font: fs } });
        x += w;
      }
      // indicação de que o rótulo abre a escala
      filhos.push({ type: 'text', style: { text: aberta ? '⇕ ✕' : '⇕', x, y: y + 17, verticalAlign: 'middle', fill: aberta ? c.accent : c.muted, font: '600 13px IBM Plex Sans, sans-serif' } });
      x += aberta ? 30 : 16;
      maxX = Math.max(maxX, x);
      filhos.unshift({ type: 'rect', shape: { x: 0, y: 0, width: maxX - 2, height: y + ALT, r: 6 },
        style: { fill: hexA(c.panel, .9), stroke: aberta ? c.accent : c.line, lineWidth: 1 } });
      caixasTitulo.push({ x: MARG.esq + 6, y: l.top + 6, w: maxX - 2, h: y + ALT, chave: st.grupos[i][0] });
      return { type: 'group', left: MARG.esq + 6, top: l.top + 6, z: 10, silent: true, children: filhos };
    });
  }

  // faixas dos governos: série auxiliar invisível por painel, só carrega as áreas
  function serieGov(c, g, gi) {
    const larg = Math.max(1, chart.getWidth() - MARG.esq - MARG.dir) / Math.max(DIA, st.fim - st.ini);
    const af = parseFloat(c.cor('--g-alfa'));
    return {
      id: 'governos-' + gi, type: 'line', xAxisIndex: gi, yAxisIndex: yBase[gi] ?? gi, data: exibidos(g[0]), z: 1, silent: true,
      showSymbol: false, sampling: 'lttb', lineStyle: { opacity: 0 }, emphasis: { disabled: true },
      markArea: { silent: true, animation: false, data: GOVERNOS.flatMap(gv => {
        const x0 = Math.max(gv.t0, st.ini), x1 = Math.min(gv.t1, st.fim);
        if (x1 <= x0) return [];
        const w = (x1 - x0) * larg;
        return [[{ name: gv.nome, xAxis: x0, itemStyle: { color: hexA(c.cor(gv.cor), af) },
          label: { show: gi === 0 && w > gv.nome.length * 7 + 12, position: 'top', distance: 5, color: c.fg2, fontSize: 11, fontWeight: 600 } },
          { xAxis: x1 }]];
      }) },
    };
  }

  // pinos A/B: ponto em cada série, linhas verticais e faixa medida; linha de base 0% / 100
  function marcas(c, id, gi, k) {
    const a = brutos(id), f = transf(id);
    const pts = st.pinos.map((ts, i) => {
      const p = pontoEm(a, ts);
      return p && { ts: p[0], y: f(p[1]), nome: st.pinos.length === 2 ? 'AB'[i] : 'A' };
    }).filter(Boolean);
    const out = {
      markPoint: { silent: true, animation: false, data: pts.map(p => ({
        coord: [p.ts, p.y], symbol: 'circle', symbolSize: 10,
        itemStyle: { color: c.pin, borderColor: c.panel, borderWidth: 2 },
        label: { show: gi === 0 && k === 0, formatter: p.nome, position: 'top', distance: 6, color: c.fg, fontWeight: 600, fontSize: 12 } })) },
    };
    if (k > 0) return out;
    const I = info(st.grupos[gi]);
    const linhas = st.pinos.map(ts => ({ xAxis: ts, lineStyle: { color: c.pin, type: [4, 3], width: 1 }, label: { show: false } }));
    if (I.indice) linhas.push({ yAxis: 100, lineStyle: { color: c.axis, type: 'solid', width: 1 }, label: { show: false } });
    else if (I.pct || I.nN === 0) linhas.push({ yAxis: 0, lineStyle: { color: c.axis, type: 'solid', width: 1 }, label: { show: false } });
    let area = [];
    if (st.pinos.length === 2) {
      const m = gi === 0 ? mede(id) : null;
      area = [[{ xAxis: st.pinos[0], itemStyle: { color: c.band },
        label: { show: !!m, position: 'insideBottom', distance: 10, formatter: m ? m.txt : '',
          color: m && m.d >= 0 ? c.up : c.down, fontFamily: 'IBM Plex Mono, monospace', fontWeight: 600, fontSize: 13 } },
        { xAxis: st.pinos[1] }]];
    }
    return { ...out,
      markLine: { silent: true, symbol: 'none', animation: false, data: linhas },
      markArea: { silent: true, animation: false, data: area } };
  }

  // variação de uma série entre A e B
  function mede(id) {
    const a = brutos(id);
    const p = pontoEm(a, st.pinos[0]) || a[0], q = pontoEm(a, st.pinos[1]);
    if (!q || q[0] <= p[0]) return null;
    const dias = Math.round((q[0] - p[0]) / DIA), anos = dias / 365.25;
    if (bruto(id)) return { d: q[1] - p[1], txt: fmtDif(id, q[1] - p[1]), sub: fmtVal(id, p[1]) + ' → ' + fmtVal(id, q[1]), dias };
    const f = q[1] / p[1] - 1;
    return { d: f, txt: fmtP(f, 1), txtLongo: fmtP(f), sub: anos >= 1 ? fmtP(Math.pow(q[1] / p[1], 1 / anos) - 1) + ' a.a.' : '', dias };
  }

  function tooltip(params) {
    const lista = Array.isArray(params) ? params : [params];
    if (!lista.length) return '';
    const ts = lista[0].axisValue, g = st.gov && govEm(ts), c = cores(), mono = 'font-family:IBM Plex Mono,monospace;';
    let h = `<div style="display:flex;justify-content:space-between;gap:16px;${mono}font-size:12px;color:${c.muted};margin-bottom:4px"><span>${esc(fmtData(ts))}</span>`
      + (g ? `<span style="display:inline-flex;align-items:center;gap:6px;font-family:IBM Plex Sans,sans-serif;color:${c.fg2}"><i style="width:9px;height:9px;border-radius:2px;background:${c.cor(g.cor)}"></i>${esc(g.nome)}</span>` : '')
      + '</div>';
    const poucas = ativos().length <= 2;
    st.grupos.forEach((grp, gi) => {
      if (gi > 0) h += `<div style="height:1px;background:${c.line};margin:6px 0 4px"></div>`;
      for (const id of grp) {
        const a = brutos(id), p = pontoEm(a, ts);
        if (!p) continue;
        const i = a.indexOf(p), taxa = bruto(id);
        let principalTxt = fmtVal(id, p[1]), secund = '';
        if (emPct(id)) { principalTxt = fmtP(p[1] / base(id) - 1); secund = fmtVal(id, p[1]); }
        h += `<div style="display:flex;align-items:center;gap:8px;margin-top:3px">
          <span style="width:12px;height:0;border-top:2px ${CAT[id].traco ? 'dashed' : 'solid'} ${c.cor(CAT[id].cor)}"></span>
          <b style="${mono}font-size:14px;font-weight:500">${esc(principalTxt)}</b>
          <span style="color:${c.muted}">${esc(CAT[id].nome)}${secund ? ' · ' + esc(secund) : ''}</span></div>`;
        const linhas = [];
        if (poucas && i > 0 && !CAT[id].degrau) {
          const r = taxa ? [fmtDif(id, p[1] - a[i - 1][1]), p[1] - a[i - 1][1]] : [fmtP(p[1] / a[i - 1][1] - 1), p[1] / a[i - 1][1] - 1];
          const fq = CAT[id].freq;
          const per = fq === 'trimestral' ? 'no trimestre' : fq === 'anual' ? 'no ano' : st.freq === 'm' || fq !== 'diária' ? 'no mês' : 'no dia';
          linhas.push([per, ...r]);
        }
        if (st.pinos.length) {
          const pa = pontoEm(a, st.pinos[0]);
          if (pa && pa[0] < p[0]) linhas.push(['desde A', ...(taxa ? [fmtDif(id, p[1] - pa[1]), p[1] - pa[1]] : [fmtP(p[1] / pa[1] - 1), p[1] / pa[1] - 1])]);
        }
        for (const [r, txt, f] of linhas)
          h += `<div style="display:flex;justify-content:space-between;gap:16px;font-size:12px;padding-left:20px">
            <span style="color:${c.muted}">${r}</span><span style="${mono}color:${f >= 0 ? c.up : c.down}">${txt}</span></div>`;
      }
    });
    return h;
  }

  function desenhar() {
    if (!chart) return;
    const N = st.grupos.length;
    const alt = movel() ? Math.min(1500, N === 1 ? 380 : 330 + 230 * (N - 1)) + 'px'
      : N === 1 ? '' : Math.min(1400, 440 + 190 * (N - 1)) + 'px';
    if ($('grafico').style.height !== alt) { $('grafico').style.height = alt; chart.resize(); }
    chart.setOption(opcao(), { notMerge: true });
    atualizarUI();
  }
  // durante o zoom: só os dados (modo %) e as marcas mudam
  function atualizarSeries() {
    const c = cores(), lista = [];
    st.grupos.forEach((g, gi) => {
      g.forEach((id, k) => lista.push({ id, data: exibidos(id), ...marcas(c, id, gi, k) }));
      if (st.gov) lista.push(serieGov(c, g, gi));
    });
    chart.setOption({ series: lista });
  }

  // ---------- período ----------
  function recalcExtensao() {
    const eraMax = st.ini !== null && Math.abs(st.ini - extMin) < 5 * DIA && Math.abs(st.fim - extMax) < 5 * DIA;
    const ss = ativos().map(id => series[id].d);
    extMin = Math.min(...ss.map(d => d[0][0]));
    extMax = Math.max(...ss.map(d => d[d.length - 1][0]));
    if (st.ini === null || eraMax) { st.ini = extMin; st.fim = extMax; }
    else {
      st.ini = Math.max(st.ini, extMin); st.fim = Math.min(st.fim, extMax);
      if (st.fim - st.ini < 7 * DIA) { st.ini = extMin; st.fim = extMax; }
    }
    $('d-ini').min = $('d-fim').min = iso(extMin); $('d-ini').max = $('d-fim').max = iso(extMax);
  }
  function aplicarPeriodo(ini, fim) {
    ini = Math.max(extMin, ini); fim = Math.min(extMax, fim);
    if (fim - ini < 7 * DIA) return;
    chart.dispatchAction({ type: 'dataZoom', startValue: ini, endValue: fim });
  }
  function preset(v) {
    const f = new Date(extMax), y = f.getUTCFullYear(), m = f.getUTCMonth(), d = f.getUTCDate();
    const map = { '1m': Date.UTC(y, m - 1, d), '6m': Date.UTC(y, m - 6, d), 'ano': Date.UTC(y, 0, 1),
      '1a': Date.UTC(y - 1, m, d), '5a': Date.UTC(y - 5, m, d), '10a': Date.UTC(y - 10, m, d), 'max': extMin };
    return map[v];
  }
  let pend = false;
  function aoZoom() {
    const todos = chart.getOption().dataZoom, dz = todos.find(d => d.id === 'x-in');
    for (const d of todos) if (String(d.id).startsWith('y-')) st.yz[String(d.id).slice(2)] = [d.start, d.end];
    st.ini = dz.startValue; st.fim = dz.endValue;
    if (pend) return;
    pend = true;
    requestAnimationFrame(() => {
      pend = false;
      atualizarSeries();
      atualizarUI();
    });
  }

  // ---------- pinos ----------
  function clicar(px) {
    const a = brutos(st.ref);
    const ts = a[perto(a, chart.convertFromPixel({ xAxisIndex: 0 }, px))][0];
    const ja = st.pinos.indexOf(ts);
    if (ja >= 0) st.pinos.splice(ja, 1);
    else if (st.pinos.length >= 2) st.pinos = [ts];
    else st.pinos.push(ts);
    st.pinos.sort((x, y) => x - y);
    atualizarSeries(); rodape(); atualizarUI();
  }
  function limparPinos() { st.pinos = []; atualizarSeries(); rodape(); atualizarUI(); }
  function rodape() {
    const r = $('rodape');
    r.textContent = '';
    if (!st.pinos.length) {
      r.innerHTML = '<div class="dica"><span><b>Clique</b> fixa um ponto</span><span><b>2 pontos</b> medem o período</span><span><b>Roda / pinça</b> zoom · <b>arrastar</b> move</span></div>';
      return;
    }
    st.pinos.forEach((ts, i) => {
      const el = document.createElement('span'); el.className = 'pino';
      el.innerHTML = `<span class="l">${st.pinos.length === 2 ? 'AB'[i] : 'A'}</span><span class="num">${esc(fmtData(ts))}</span>`;
      const x = document.createElement('button'); x.textContent = '×'; x.setAttribute('aria-label', 'Remover ponto');
      x.onclick = () => { st.pinos.splice(i, 1); atualizarSeries(); rodape(); atualizarUI(); };
      el.append(x); r.append(el);
    });
    if (st.pinos.length === 2) {
      for (const id of ativos()) {
        const f = mede(id);
        if (!f) continue;
        const m = document.createElement('span'); m.className = 'medida'; m.style.setProperty('--c', `var(${CAT[id].cor})`);
        m.title = CAT[id].nome;
        m.innerHTML = `<span class="k"></span><span class="v ${classe(f.d)}">${esc(f.txtLongo || f.txt)}</span>${f.sub ? `<span class="s">${esc(f.sub)}</span>` : ''}`;
        r.append(m);
      }
      const z = document.createElement('button'); z.className = 'acao'; z.textContent = 'Zoom em A–B';
      z.onclick = () => aplicarPeriodo(st.pinos[0], st.pinos[1]);
      r.append(z);
    } else {
      const d = document.createElement('span'); d.className = 'dica'; d.textContent = 'clique em outro ponto para medir';
      r.append(d);
    }
    const l = document.createElement('button'); l.className = 'acao'; l.textContent = 'Limpar';
    l.onclick = limparPinos;
    r.append(l);
  }

  // ---------- painel ----------
  function atualizarUI() {
    const id = st.ref, a = brutos(id), taxa = bruto(id);
    const i0 = primeiroDesde(a, st.ini);
    let i1 = primeiroDesde(a, st.fim + 1);
    if (a[i1][0] > st.fim) i1--;
    const fatia = a.slice(i0, Math.max(i0, i1) + 1);
    $('st-k').style.setProperty('--c', `var(${CAT[id].cor})`);
    $('st-nome').textContent = CAT[id].nome;
    if (fatia.length) {
      const p = fatia[0], q = fatia[fatia.length - 1];
      let mx = p, mn = p;
      for (const x of fatia) { if (x[1] > mx[1]) mx = x; if (x[1] < mn[1]) mn = x; }
      const anos = (q[0] - p[0]) / DIA / 365.25, dias = fmtN(Math.round((q[0] - p[0]) / DIA), 0) + ' dias';
      if (taxa) {
        $('st-var').textContent = fmtDif(id, q[1] - p[1]); $('st-var').className = 'v';
        $('st-var-s').textContent = dias;
      } else {
        const f = q[1] / p[1] - 1;
        $('st-var').textContent = fmtP(f); $('st-var').className = 'v ' + classe(f);
        $('st-var-s').textContent = anos >= 1 ? fmtP(Math.pow(q[1] / p[1], 1 / anos) - 1) + ' a.a.' : dias;
      }
      $('st-ini').textContent = fmtVal(id, p[1]); $('st-ini-s').textContent = fmtData(p[0]);
      $('st-fim').textContent = fmtVal(id, q[1]); $('st-fim-s').textContent = fmtData(q[0]);
      $('st-max').textContent = fmtVal(id, mx[1]); $('st-max-s').textContent = fmtData(mx[0]);
      $('st-min').textContent = fmtVal(id, mn[1]); $('st-min-s').textContent = fmtData(mn[0]);
    }
    $('d-ini').value = iso(st.ini); $('d-fim').value = iso(st.fim);
    const proximo = (x, y) => Math.abs(x - y) <= 4 * DIA;
    document.querySelectorAll('#seg-per button').forEach(b => {
      b.setAttribute('aria-pressed', proximo(st.fim, extMax) && proximo(st.ini, Math.max(extMin, preset(b.dataset.v))));
    });
    const pressiona = (sel, v) => document.querySelectorAll(sel + ' button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === v));
    pressiona('#seg-freq', st.freq); pressiona('#seg-modo', st.modo); pressiona('#seg-escala', st.log ? 'log' : 'lin');
    const infos = st.grupos.map(info);
    $('m-val').disabled = $('m-pct').disabled = !infos.some(I => I.nN === 1 && !I.temTaxa && !I.indep);
    $('e-log').disabled = !infos.some(I => I.nN > 0 && !I.temTaxa && !I.indep);
    pressiona('#seg-eixo', st.eixos);
    $('y-serie').disabled = !st.grupos.some(g => g.length > 1);
    const a2 = brutos(st.ref);
    document.querySelectorAll('#govs .gchip').forEach(b => {
      const t = trechoGov(GOVERNOS[+b.dataset.i], a2);
      b.setAttribute('aria-pressed', !!t && st.pinos.length === 2 && st.pinos[0] === t[0] && st.pinos[1] === t[1]);
    });
    autoSalvar();
  }

  function cabecalho() {
    const nomes = [...new Set(ativos().map(i => FONTES.find(f => f.temas.some(t => t.series.includes(i))).nome))];
    const atual = Math.max(...ativos().map(i => Date.parse(series[i].meta.atualizado)));
    $('fonte').textContent = 'Fontes: ' + nomes.join(', ') + ' · atualizado em ' + fmtD(atual);
  }

  // ---------- séries por fonte (menu lateral) ----------
  function criarItem(id) {
    const it = document.createElement('button');
    it.className = 'item'; it.dataset.id = id; it.setAttribute('role', 'checkbox');
    it.style.setProperty('--c', `var(${CAT[id].cor})`);
    it.innerHTML = `<span class="cx"></span><span>${esc(CAT[id].nome)}</span><span class="u">${esc(CAT[id].unid)}</span>`;
    it.title = CAT[id].nome + ' · ' + CAT[id].unid + ' · ' + CAT[id].freq;
    it.onclick = () => alternar(id);
    return it;
  }
  // busca: filtra enquanto digita (sem diferenciar acentos/maiúsculas) e mostra fonte › tema de cada resultado
  const semAcento = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  function montarBusca(box) {
    const wrap = document.createElement('div'); wrap.className = 'busca';
    const inp = document.createElement('input');
    inp.type = 'search'; inp.id = 'busca'; inp.autocomplete = 'off';
    inp.placeholder = 'Buscar série (ex.: selic, pib, dólar)'; inp.setAttribute('aria-label', 'Buscar série');
    const res = document.createElement('div'); res.className = 'resultados'; res.hidden = true;
    wrap.append(inp, res); box.append(wrap);
    const indice = FONTES.flatMap(f => f.temas.flatMap(t => t.series.map(id => ({ id, f, t,
      chave: semAcento([CAT[id].nome, CAT[id].unid, CAT[id].freq, t.nome || '', f.nome, CAT[id].origem || ''].join(' ')) }))));
    inp.oninput = () => {
      const termos = semAcento(inp.value.trim()).split(/\s+/).filter(Boolean);
      document.querySelectorAll('#fontes > details').forEach(d => { d.hidden = termos.length > 0; });
      res.hidden = !termos.length; res.textContent = '';
      if (!termos.length) return;
      const achados = indice.filter(x => termos.every(t => x.chave.includes(t)));
      if (!achados.length) { const v = document.createElement('div'); v.className = 'vazio'; v.textContent = 'Nenhuma série encontrada'; res.append(v); return; }
      for (const x of achados) {
        const linha = document.createElement('div'); linha.className = 'achado';
        const cam = document.createElement('div'); cam.className = 'caminho';
        cam.textContent = x.f.nome + (x.t.nome ? ' › ' + x.t.nome : '');
        linha.append(criarItem(x.id), cam); res.append(linha);
      }
      marcarMenus();
    };
    inp.onkeydown = e => { if (e.key === 'Escape') { inp.value = ''; inp.oninput(); } };
  }

  function montarFontes() {
    const box = $('fontes');
    montarBusca(box);
    for (const f of FONTES) {
      const d = document.createElement('details'); d.className = 'sec'; d.open = true;
      const s = document.createElement('summary');
      s.innerHTML = `<span>Séries · ${esc(f.nome)}</span><span class="cont" data-conta="${esc(f.temas.flatMap(t => t.series).join(','))}"></span>`;
      const corpo = document.createElement('div'); corpo.className = 'sec-corpo';
      corpo.innerHTML = `<div class="fonte-cab"><span>${esc(f.site)}</span></div>`;
      for (const t of f.temas) {
        const l = document.createElement('div'); l.className = 'lista';
        let onde = corpo;
        if (t.nome) {
          // subgrupo recolhível; abre fechado, exceto o primeiro tema de cada fonte
          const sub = document.createElement('details'); sub.className = 'sub'; sub.open = t === f.temas[0];
          const ss = document.createElement('summary');
          ss.innerHTML = `<span>${esc(t.nome)}</span><span class="cont" data-conta="${esc(t.series.join(','))}"></span>`;
          sub.append(ss); corpo.append(sub); onde = sub;
        }
        for (const id of t.series) l.append(criarItem(id));
        onde.append(l);
      }
      d.append(s, corpo); box.append(d);
    }
    $('chip-gov').onclick = () => {
      st.gov = !st.gov; $('govs').hidden = !st.gov; $('chip-gov').setAttribute('aria-pressed', st.gov); desenhar();
    };
  }
  function marcarMenus() {
    document.querySelectorAll('.item').forEach(it => it.setAttribute('aria-checked', ativos().includes(it.dataset.id)));
    document.querySelectorAll('[data-conta]').forEach(el => {
      const n = el.dataset.conta.split(',').filter(id => ativos().includes(id)).length;
      el.textContent = n || '';
    });
  }

  // grupos de gráficos: arrastar uma série junta, separa ou muda a ordem; arrastar o número muda a ordem dos gráficos
  function montarGrupos() {
    const box = $('grupos');
    box.textContent = '';
    st.grupos.forEach((g, gi) => {
      const el = document.createElement('div'); el.className = 'grupo'; el.dataset.grupo = gi;
      if (st.grupos.length > 1) {
        const n = document.createElement('span'); n.className = 'gn'; n.textContent = gi + 1;
        n.title = 'Arraste para mudar a ordem dos gráficos';
        n.addEventListener('pointerdown', e => arrastar(e, el, n, (sob, x) => {
          const alvo = sob?.closest('.grupo:not(.novo)');
          if (!alvo || alvo === el) return null;
          const r = alvo.getBoundingClientRect(), lado = x < r.left + r.width / 2 ? 'antes' : 'depois';
          return { el: alvo, classe: lado, idx: +alvo.dataset.grupo, lado };
        }, a => {
          const [mov] = st.grupos.splice(gi, 1);
          let pos = a.idx > gi ? a.idx - 1 : a.idx;
          if (a.lado === 'depois') pos++;
          st.grupos.splice(pos, 0, mov);
          atualizarTudo();
        }));
        el.append(n);
      }
      for (const id of g) el.append(chipAtivo(id));
      box.append(el);
    });
    if (ativos().length > 1) {
      const novo = document.createElement('div'); novo.className = 'grupo novo'; novo.dataset.grupo = 'novo';
      novo.textContent = '＋ arraste aqui para separar';
      box.append(novo);
    }
  }
  function chipAtivo(id) {
    const el = document.createElement('span');
    el.className = 'ativo' + (id === st.ref && ativos().length > 1 ? ' ref' : '');
    el.dataset.id = id;
    el.style.setProperty('--c', `var(${CAT[id].cor})`);
    el.title = 'Clique: referência dos números · Arraste: juntar ou separar gráficos';
    const k = document.createElement('span'); k.className = 'k' + (CAT[id].traco ? ' traco' : '');
    el.append(k, document.createTextNode(CAT[id].nome));
    // elo: séries da mesma unidade no mesmo gráfico dividem o eixo; clique solta/religa
    const g = st.grupos[grupoDe(id)];
    if (st.eixos === 'escala' && g && divideEixo(id, g)) {
      const solto = st.solto.has(id), b = document.createElement('button');
      b.className = 'elo' + (solto ? ' solto' : '');
      b.innerHTML = solto
        ? '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6.5 4.5 7.6 3.4a2.6 2.6 0 0 1 3.7 3.7L10.2 8.2M5.8 7.8 4.7 8.9a2.6 2.6 0 0 0 3.7 3.7l1.1-1.1M3 3l1.5 1.5M13 13l-1.5-1.5"/></svg>'
        : '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6.8 9.2 9.2 6.8M7.6 4.4l1-1a2.6 2.6 0 0 1 3.7 3.7l-1 1M8.4 11.6l-1 1a2.6 2.6 0 0 1-3.7-3.7l1-1"/></svg>';
      b.title = solto ? 'Escala própria. Clique para ligar à escala das outras séries de mesma unidade'
                      : 'Escala ligada às outras séries de mesma unidade. Clique para soltar';
      b.setAttribute('aria-label', b.title);
      b.onclick = e => { e.stopPropagation(); solto ? st.solto.delete(id) : st.solto.add(id); montarGrupos(); desenhar(); };
      el.append(b);
    }
    if (ativos().length > 1) {
      const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.setAttribute('aria-label', 'Remover ' + CAT[id].nome);
      x.onclick = e => { e.stopPropagation(); alternar(id); };
      el.append(x);
    }
    el.addEventListener('pointerdown', e => {
      if (e.target.closest('.x, .elo')) return;
      arrastar(e, el, el, (sob, x) => {
        const chip = sob?.closest('.ativo');
        if (chip && chip !== el) {
          const r = chip.getBoundingClientRect(), lado = x < r.left + r.width / 2 ? 'antes' : 'depois';
          return { el: chip, classe: lado, grupo: chip.closest('[data-grupo]').dataset.grupo, ref: chip.dataset.id, lado };
        }
        const g = sob?.closest('[data-grupo]');
        return g ? { el: g, classe: 'alvo', grupo: g.dataset.grupo } : null;
      }, a => moverSerie(id, a), () => { if (st.ref !== id) { st.ref = id; montarGrupos(); desenhar(); rodape(); } });
    });
    return el;
  }
  // arrastar genérico com ponteiro (mouse e toque): fantasma segue o cursor, alvo marcado com uma classe
  function arrastar(e, el, pega, achar, soltar, clique) {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX, y0 = e.clientY;
    let fant = null, alvo = null;
    pega.setPointerCapture(e.pointerId);
    const limpa = () => alvo?.el.classList.remove('alvo', 'antes', 'depois');
    const mover = ev => {
      if (!fant) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
        fant = el.cloneNode(true); fant.classList.add('fantasma'); fant.style.width = el.offsetWidth + 'px';
        document.body.append(fant); el.style.opacity = .35;
      }
      fant.style.left = ev.clientX + 10 + 'px'; fant.style.top = ev.clientY + 10 + 'px';
      limpa();
      alvo = achar(document.elementFromPoint(ev.clientX, ev.clientY), ev.clientX);
      alvo?.el.classList.add(alvo.classe);
    };
    const fim = () => {
      pega.removeEventListener('pointermove', mover); pega.removeEventListener('pointerup', fim); pega.removeEventListener('pointercancel', fim);
      if (!fant) { clique?.(); return; }
      fant.remove(); el.style.opacity = ''; limpa();
      if (alvo) soltar(alvo); else montarGrupos();
    };
    pega.addEventListener('pointermove', mover); pega.addEventListener('pointerup', fim); pega.addEventListener('pointercancel', fim);
  }
  // move a série para outro gráfico (ou novo), antes/depois de outra série
  function moverSerie(id, a) {
    const de = grupoDe(id);
    st.grupos[de] = st.grupos[de].filter(x => x !== id);
    if (a.grupo === 'novo') st.grupos.push([id]);
    else {
      const g = st.grupos[+a.grupo];
      const pos = a.ref ? g.indexOf(a.ref) + (a.lado === 'depois' ? 1 : 0) : g.length;
      g.splice(pos, 0, id);
    }
    st.grupos = st.grupos.filter(g => g.length);
    atualizarTudo();
  }

  function alternar(id) {
    const gi = grupoDe(id);
    if (gi >= 0) {
      if (ativos().length === 1) return;
      st.grupos[gi] = st.grupos[gi].filter(x => x !== id);
      st.grupos = st.grupos.filter(g => g.length);
      if (st.ref === id) st.ref = ativos()[0];
      atualizarTudo();
      return;
    }
    const it = document.querySelector(`.item[data-id="${id}"]`);
    it?.classList.add('carregando');
    carregar(id).then(() => {
      it?.classList.remove('carregando');
      if (grupoDe(id) >= 0) return;
      // níveis juntam-se ao primeiro gráfico só de níveis; taxas ao primeiro só de taxas
      const t = CAT[id].tipo, g = st.grupos.find(g => g.every(x => CAT[x].tipo === t));
      if (g) g.push(id); else if (t === 'nivel') st.grupos.unshift([id]); else st.grupos.push([id]);
      atualizarTudo();
    }).catch(() => {
      it?.classList.remove('carregando');
      if (it) it.querySelector('.u').textContent = 'não carregou';
    });
  }
  function atualizarTudo() {
    if (!ativos().includes(st.ref)) st.ref = ativos()[0];
    recalcExtensao(); montarGrupos(); marcarMenus(); cabecalho(); desenhar(); rodape();
  }

  // ---------- governos ----------
  function trechoGov(g, a) {
    const x0 = Math.max(g.t0, a[0][0]), x1 = Math.min(g.t1, a[a.length - 1][0]);
    if (x1 <= x0) return null;
    const i0 = primeiroDesde(a, x0);
    let i1 = primeiroDesde(a, x1 + 1);
    if (a[i1][0] > x1) i1--;
    return i1 > i0 ? [a[i0][0], a[i1][0]] : null;
  }
  function governos() {
    const box = $('govs');
    GOVERNOS.forEach((g, i) => {
      if (g.t1 < Date.UTC(1993, 0, 1)) return;
      const b = document.createElement('button');
      b.className = 'gchip'; b.dataset.i = i; b.style.setProperty('--c', `var(${g.cor})`);
      b.title = 'Medir as séries neste governo';
      const sw = document.createElement('span'); sw.className = 'sw';
      const an = document.createElement('span'); an.className = 'a';
      an.textContent = g.ini.slice(2, 4) + '–' + (g.fim ? g.fim.slice(2, 4) : 'hoje');
      b.append(sw, document.createTextNode(g.nome), an);
      b.onclick = () => {
        const t = trechoGov(g, brutos(st.ref));
        if (!t) return;
        st.pinos = b.getAttribute('aria-pressed') === 'true' ? [] : t;
        atualizarSeries(); rodape(); atualizarUI();
      };
      box.append(b);
    });
  }

  // ---------- visões salvas (localStorage deste navegador) ----------
  const CHAVE = 'series-historicas:estado', CHAVE_V = 'series-historicas:visoes';
  const lerLS = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  const gravarLS = (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const PADRAO = { grupos: [['ibovespa']], ref: 'ibovespa', freq: 'd', modo: 'val', log: false, eixos: 'escala', yz: {}, solto: [], gov: false, pinos: [] };
  // ateFim / pinoFim: o período e o ponto B "até o dado mais recente" acompanham as atualizações dos dados
  const estado = () => ({ grupos: st.grupos, ref: st.ref, freq: st.freq, modo: st.modo, log: st.log, eixos: st.eixos,
    yz: st.yz, solto: [...st.solto], gov: st.gov, ini: st.ini, fim: st.fim, pinos: st.pinos,
    ateFim: Math.abs(st.fim - extMax) < 5 * DIA,
    pinoFim: st.pinos.length > 0 && Math.abs(st.pinos[st.pinos.length - 1] - extMax) < 5 * DIA });
  // visão padrão do site (dados/padrao.json): primeira visita e "Limpar tudo"
  const padraoSite = () => fetch('dados/padrao.json').then(r => r.ok ? r.json() : Promise.reject())
    .then(j => j.estado).catch(() => PADRAO);
  let pronto = false, tSalvar = 0;
  // a tela atual é salva sozinha a cada mudança e volta ao reabrir a página
  function autoSalvar() {
    if (!pronto) return;
    clearTimeout(tSalvar);
    tSalvar = setTimeout(() => gravarLS(CHAVE, estado()), 400);
  }
  async function aplicarEstado(e) {
    const ids = (e.grupos || []).flat().filter(id => CAT[id]);
    await Promise.all(ids.map(id => carregar(id).catch(() => null)));
    st.grupos = (e.grupos || []).map(g => g.filter(id => series[id])).filter(g => g.length);
    if (!st.grupos.length) st.grupos = [['ibovespa']];
    st.ref = ativos().includes(e.ref) ? e.ref : ativos()[0];
    st.freq = e.freq === 'm' ? 'm' : 'd'; st.modo = e.modo === 'pct' ? 'pct' : 'val'; st.log = !!e.log;
    st.eixos = e.eixos === 'comum' ? 'comum' : 'escala'; st.yz = e.yz || {}; st.solto = new Set(e.solto || []);
    st.gov = !!e.gov; st.pinos = Array.isArray(e.pinos) ? e.pinos.slice(0, 2) : [];
    st.ini = null; recalcExtensao();
    if (e.ini && e.fim && e.fim - e.ini >= 7 * DIA) { st.ini = Math.max(extMin, e.ini); st.fim = Math.min(extMax, e.fim); }
    if (e.ateFim) st.fim = extMax;
    if (e.pinoFim && st.pinos.length) {
      const a = brutos(st.ref);
      st.pinos[st.pinos.length - 1] = a[a.length - 1][0];
    }
    $('govs').hidden = !st.gov; $('chip-gov').setAttribute('aria-pressed', st.gov);
    montarGrupos(); marcarMenus(); cabecalho(); desenhar(); rodape();
  }
  function montarVisoes() {
    const box = $('visoes'), lista = lerLS(CHAVE_V) || [];
    box.textContent = '';
    lista.forEach((v, i) => {
      const linha = document.createElement('div'); linha.className = 'visao';
      const ab = document.createElement('button'); ab.className = 'abrir';
      const nm = document.createElement('span'); nm.textContent = v.nome;
      const q = document.createElement('span'); q.className = 'q'; q.textContent = fmtD(v.quando);
      ab.append(nm, q); ab.title = 'Abrir esta visão';
      ab.onclick = () => aplicarEstado(v.estado);
      const del = document.createElement('button'); del.className = 'del'; del.textContent = '×';
      del.setAttribute('aria-label', 'Apagar a visão ' + v.nome);
      del.onclick = () => { lista.splice(i, 1); gravarLS(CHAVE_V, lista); montarVisoes(); };
      linha.append(ab, del); box.append(linha);
    });
  }
  function ligarVisoes() {
    const salvar = () => {
      const lista = lerLS(CHAVE_V) || [], agora = Date.now();
      const nome = $('v-nome').value.trim() || ativos().map(id => CAT[id].nome).join(' + ').slice(0, 40);
      const i = lista.findIndex(v => v.nome === nome);
      const item = { nome, quando: agora, estado: estado() };
      if (i >= 0) lista[i] = item; else lista.unshift(item);
      gravarLS(CHAVE_V, lista.slice(0, 30));
      $('v-nome').value = ''; montarVisoes();
      $('v-salvar').textContent = 'Salvo'; setTimeout(() => { $('v-salvar').textContent = 'Salvar'; }, 1200);
    };
    $('v-salvar').onclick = salvar;
    $('v-nome').onkeydown = e => { if (e.key === 'Enter') salvar(); };
    // limpar pede um segundo clique para confirmar; não apaga as visões com nome
    let tConf = 0;
    $('v-limpar').onclick = () => {
      const b = $('v-limpar');
      if (!b.classList.contains('confirma')) {
        b.classList.add('confirma'); b.textContent = 'Confirmar limpeza';
        tConf = setTimeout(() => { b.classList.remove('confirma'); b.textContent = 'Limpar tudo'; }, 3000);
        return;
      }
      clearTimeout(tConf); b.classList.remove('confirma'); b.textContent = 'Limpar tudo';
      gravarLS(CHAVE, null);
      padraoSite().then(aplicarEstado);
    };
    montarVisoes();
  }

  // ---------- eventos ----------
  function ligar() {
    $('seg-freq').onclick = e => { const v = e.target.dataset?.v; if (!v || v === st.freq) return; st.freq = v; desenhar(); rodape(); };
    $('seg-modo').onclick = e => { const v = e.target.dataset?.v; if (!v || v === st.modo || e.target.disabled) return; st.modo = v; desenhar(); };
    $('seg-escala').onclick = e => { const v = e.target.dataset?.v; if (!v || e.target.disabled) return; st.log = v === 'log'; desenhar(); };
    $('ir-filtros').onclick = () => $('menu').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('ir-grafico').onclick = () => $('principal').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('seg-eixo').onclick = e => { const v = e.target.dataset?.v; if (!v || v === st.eixos || e.target.disabled) return; st.eixos = v; montarGrupos(); desenhar(); };
    $('y-reset').onclick = () => { st.yz = {}; desenhar(); };
    $('seg-per').onclick = e => { const v = e.target.dataset?.v; if (v) aplicarPeriodo(preset(v), extMax); };
    const datas = () => {
      const i = Date.parse($('d-ini').value), f = Date.parse($('d-fim').value);
      if (!isNaN(i) && !isNaN(f) && f > i) aplicarPeriodo(i, f); else atualizarUI();
    };
    $('d-ini').onchange = datas; $('d-fim').onchange = datas;

    chart.on('datazoom', aoZoom);
    const zr = chart.getZr();
    let baixo = null;
    zr.on('mousedown', e => { baixo = [e.offsetX, e.offsetY]; });
    zr.on('mousemove', e => {
      if (caixasTitulo.some(b => e.offsetX >= b.x && e.offsetX <= b.x + b.w && e.offsetY >= b.y && e.offsetY <= b.y + b.h)) zr.setCursorStyle('pointer');
    });
    zr.on('click', e => {
      if (baixo && Math.hypot(e.offsetX - baixo[0], e.offsetY - baixo[1]) > 5) return;
      // clique no rótulo do painel: abre/fecha a barra de ajuste da escala vertical
      const cx = caixasTitulo.find(b => e.offsetX >= b.x && e.offsetX <= b.x + b.w && e.offsetY >= b.y && e.offsetY <= b.y + b.h);
      if (cx) { st.escala.has(cx.chave) ? st.escala.delete(cx.chave) : st.escala.add(cx.chave); desenhar(); return; }
      const dentro = st.grupos.some((_, i) => chart.containPixel({ gridIndex: i }, [e.offsetX, e.offsetY]));
      if (dentro) clicar(e.offsetX);
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && st.pinos.length) limparPinos(); });
    let redim = 0;
    new ResizeObserver(() => { chart.resize(); cancelAnimationFrame(redim); redim = requestAnimationFrame(desenhar); }).observe($('grafico'));
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', desenhar);
    new MutationObserver(desenhar).observe(raiz, { attributes: true, attributeFilter: ['data-theme'] });
  }

  // ---------- início ----------
  const biblioteca = new Promise((ok, falha) => {
    if (window.echarts) return ok();
    const t0 = Date.now();
    const espera = setInterval(() => {
      if (window.echarts) { clearInterval(espera); ok(); }
      else if (Date.now() - t0 > 15000) { clearInterval(espera); falha('biblioteca de gráficos não carregou'); }
    }, 50);
  });

  biblioteca
    .then(() => fetch('dados/catalogo.json').then(r => r.ok ? r.json() : Promise.reject(new Error('catálogo'))))
    .then(j => { CAT = j.series; FONTES = j.fontes; })
    .then(() => carregar('ibovespa'))
    .then(() => {
      $('grafico').textContent = '';
      chart = echarts.init($('grafico'), null, { renderer: 'canvas' });
      montarFontes(); governos(); ligar(); ligarVisoes();
      const salvo = lerLS(CHAVE);
      // quem já usou a página vê a própria tela; na primeira visita, a visão padrão do site
      return (salvo ? Promise.resolve(salvo) : padraoSite()).then(aplicarEstado).then(() => { pronto = true; });
    })
    .catch(err => { $('grafico').innerHTML = '<div class="aviso">Não foi possível carregar os dados (' + esc(err) + ').</div>'; });
})();
