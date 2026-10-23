// Coletor do catálogo do "Meu Financeiro".
// Lê as listas públicas de ações e fundos imobiliários do Fundamentus, busca o histórico de
// proventos de cada ativo e grava docs/catalogo.json. Roda no GitHub Actions (grátis), sem chaves.
// Uso:  node coletor/coletar.mjs            -> coleta de verdade
//       node coletor/coletar.mjs --teste    -> só testa o leitor de tabelas com um exemplo
import { writeFile, mkdir } from "node:fs/promises";

const BASE = "https://www.fundamentus.com.br";
const UA = "Mozilla/5.0 (compatible; MeuFinanceiroColetor/1.0; uso pessoal)";
const MAX_ACOES = 220, MAX_FIIS = 160;           // quantos ativos mais líquidos entram no catálogo
const LIQ_MIN_ACAO = 2_000_000, LIQ_MIN_FII = 300_000;
const HOJE = new Date();

const esperar = ms => new Promise(r => setTimeout(r, ms));
const semAcento = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

async function baixar(url, tentativas = 3) {
  let erro;
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": UA, "accept-language": "pt-BR,pt;q=0.9", referer: BASE + "/" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return new TextDecoder("windows-1252").decode(await r.arrayBuffer());
    } catch (e) { erro = e; await esperar(800 * (i + 1)); }
  }
  throw new Error(url + ": " + (erro && erro.message));
}

export function linhas(html) {
  const out = [];
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cel = [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map(c => c[1].replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim());
    if (cel.length) out.push(cel);
  }
  return out;
}
// "1.083.050.000,00" -> 1083050000 ; "9,26%" -> 0.0926 ; "-" ou vazio -> null
export function numero(s) {
  s = String(s ?? "").trim();
  if (!s || s === "-") return null;
  const pct = s.endsWith("%");
  const v = parseFloat(s.replace(/[%\s]/g, "").replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(v)) return null;
  return pct ? v / 100 : v;
}
function colunas(cab, regras) {
  const ix = {};
  const norm = cab.map(semAcento);
  for (const [chave, re] of Object.entries(regras)) {
    const i = norm.findIndex(c => re.test(c));
    if (i >= 0) ix[chave] = i;
  }
  return ix;
}
export function lerAcoes(html) {
  const L = linhas(html);
  const cab = L.find(l => semAcento(l[0]) === "papel");
  if (!cab) throw new Error("tabela de ações não encontrada (a página mudou?)");
  const ix = colunas(cab, { p: /^cotacao/, pl: /^p\/l$/, pvp: /^p\/vp$/, dy: /^div\.?yield/, mliq: /^mrg\.? liq/, roe: /^roe/, liq: /^liq\.?2meses/, dl: /^div\.?liq/, cr5: /^cresc\.? rec/ });
  for (const k of ["p", "pl", "pvp", "dy", "roe", "liq"]) if (ix[k] == null) throw new Error("coluna de ações ausente: " + k);
  const out = [];
  for (const l of L) {
    if (l === cab || !/^[A-Z]{4}\d{1,2}$/.test(l[0])) continue;
    const a = { t: l[0] };
    for (const [k, i] of Object.entries(ix)) a[k] = numero(l[i]);
    out.push(a);
  }
  return out;
}
export function lerFiis(html) {
  const L = linhas(html);
  const cab = L.find(l => semAcento(l[0]) === "papel");
  if (!cab) throw new Error("tabela de FIIs não encontrada (a página mudou?)");
  const ix = colunas(cab, { seg: /^segmento/, p: /^cotacao/, dy: /^dividend yield/, pvp: /^p\/vp$/, vm: /^valor de mercado/, liq: /^liquidez/, im: /^qtd de imoveis/, vac: /^vacancia media/, cap: /^cap rate/ });
  for (const k of ["p", "dy", "pvp", "liq"]) if (ix[k] == null) throw new Error("coluna de FIIs ausente: " + k);
  const out = [];
  for (const l of L) {
    if (l === cab || !/^[A-Z]{4}\d{2}$/.test(l[0])) continue;
    const f = { t: l[0] };
    for (const [k, i] of Object.entries(ix)) f[k] = k === "seg" ? (l[i] || "") : numero(l[i]);
    out.push(f);
  }
  return out;
}
const dataBR = s => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s || "").trim()); return m ? new Date(Date.UTC(+m[3], +m[2] - 1, +m[1])) : null; };
export function lerProventos(html, fii) {
  const L = linhas(html), out = [];
  const cab = L.find(l => /data/.test(semAcento(l[0])) && l.length >= 4);
  if (!cab) return out;
  for (const l of L) {
    if (l === cab) continue;
    let data, tipo, valor, por = 1;
    if (fii) { data = dataBR(l[0]); tipo = l[1] || ""; valor = numero(l[3]); }
    else { data = dataBR(l[0]); valor = numero(l[1]); tipo = l[2] || ""; por = numero(l[4]) || 1; }
    if (!data || valor == null || valor <= 0) continue;
    if (/amortiz/i.test(semAcento(tipo))) continue;          // devolução de capital, não é renda
    let v = valor / (por > 0 ? por : 1);
    if (/jrs|juros/.test(semAcento(tipo))) v *= 0.85;        // JCP: desconta 15% de IR na fonte
    out.push({ data, v });
  }
  return out;
}
// resume o histórico: soma de 12m, 12m anteriores, meses pagos, anos com proventos (de 5) e estabilidade
export function resumir(prov, hoje = HOJE) {
  const dia = 864e5, t = hoje.getTime();
  const soma = (a, b) => prov.filter(p => p.data.getTime() <= t - a * dia && p.data.getTime() > t - b * dia).reduce((x, p) => x + p.v, 0);
  const ult12 = prov.filter(p => p.data.getTime() <= t && p.data.getTime() > t - 365 * dia);
  const meses = new Map();
  for (const p of ult12) { const k = p.data.toISOString().slice(0, 7); meses.set(k, (meses.get(k) || 0) + p.v); }
  const vals = [...meses.values()];
  let cv = null;
  if (vals.length >= 3) { const m = vals.reduce((a, b) => a + b, 0) / vals.length; const sd = Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length); cv = m > 0 ? +(sd / m).toFixed(3) : null; }
  let ap = 0;
  for (let i = 0; i < 5; i++) if (prov.some(p => { const x = p.data.getTime(); return x <= t - 365 * i * dia && x > t - 365 * (i + 1) * dia; })) ap++;
  const ult = prov.filter(p => p.data.getTime() <= t).sort((a, b) => b.data - a.data)[0];
  // média anual dos últimos 6 anos (base do "preço-teto médio") e calendário: parte do ano paga em cada mês
  const primeiro = prov.length ? Math.min(...prov.map(p => p.data.getTime())) : null;
  let tot6 = 0, n6 = 0;
  for (let i = 0; i < 6; i++) { if (primeiro != null && t - 365 * i * dia > primeiro) { tot6 += soma(365 * i, 365 * (i + 1)); n6++; } }
  const hist = new Array(12).fill(0); let totM = 0;
  for (const p of prov) { const x = p.data.getTime(); if (x <= t && x > t - 730 * dia) { hist[p.data.getUTCMonth()] += p.v; totM += p.v; } }
  return { dv12: +soma(0, 365).toFixed(4), dvA: +soma(365, 730).toFixed(4), mp: meses.size, ap, cv, ult: ult ? ult.data.toISOString().slice(0, 10) : null,
    dm6: n6 >= 2 ? +(tot6 / n6).toFixed(4) : null, n6, mm: totM > 0 ? hist.map(v => +(v / totM).toFixed(3)) : null };
}
// página de detalhes: linhas de 4 células (rótulo, valor, rótulo, valor); rótulos vêm com "?" na frente
export function lerSetor(html) {
  const out = {};
  for (const l of linhas(html)) for (let i = 0; i < l.length - 1; i++) {
    const r = semAcento(l[i].replace(/^\?\s*/, "")).trim();
    if (r === "setor" && !out.setor) out.setor = l[i + 1];
    if (r === "subsetor" && !out.sub) out.sub = l[i + 1];
    // oscilações de preço: "12 meses" e um valor por ano (2026, 2025...)
    const v = l[i + 1] && l[i + 1].trim().endsWith("%") ? numero(l[i + 1]) : null;
    if (v != null && r === "12 meses" && out.o12 == null) out.o12 = +v.toFixed(4);
    if (v != null && /^\d{4}$/.test(r)) { out.oy = out.oy || {}; if (out.oy[r] == null) out.oy[r] = +v.toFixed(4); }
  }
  return out;
}
async function emLotes(itens, n, fn) {
  const resultado = new Array(itens.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < itens.length) { const k = i++; resultado[k] = await fn(itens[k], k); await esperar(250); }
  }));
  return resultado;
}

const EXEMPLO_DET = `<table><tr><td>?Dia</td><td>2,27%</td></tr><tr><td>?12 meses</td><td>49,48%</td></tr><tr><td>?2026</td><td>30,51%</td></tr><tr><td>?2025</td><td>62,40%</td></tr><tr><td>?2024</td><td>-3,80%</td></tr><tr><td><span>?</span>Papel</td><td>ITUB4</td><td>?Cotação</td><td>38,50</td></tr><tr><td><span class="help">?</span><span class="txt">Setor</span></td><td><a href="x">Intermediários Financeiros</a></td><td>?Max 52 sem</td><td>50,47</td></tr><tr><td>?Subsetor</td><td><a href="y">Bancos</a></td><td>?Vol $ méd (2m)</td><td>1.362.230.000</td></tr></table>`;
// ---------------------------------------------------------------- teste do leitor
const EXEMPLO_ACOES = `<table><tr><th>Papel</th><th>Cotação</th><th>P/L</th><th>P/VP</th><th>PSR</th><th>Div.Yield</th><th>P/Ativo</th><th>P/Cap.Giro</th><th>P/EBIT</th><th>P/Ativ Circ.Liq</th><th>EV/EBIT</th><th>EV/EBITDA</th><th>Mrg Bruta</th><th>Mrg Ebit</th><th>Mrg. Líq.</th><th>Liq. Corr.</th><th>ROIC</th><th>ROE</th><th>Liq.2meses</th><th>Patrim. Líq</th><th>Dív.Líq/ Patrim.</th><th>Cresc. Rec.5a</th></tr>
<tr><td><a href="detalhes.php?papel=ITUB4">ITUB4</a></td><td>38,50</td><td>8,90</td><td>1,95</td><td>1,500</td><td>6,50%</td><td>0,100</td><td>0,00</td><td>0,00</td><td>0,00</td><td>0,00</td><td>0,00</td><td>0,00%</td><td>0,00%</td><td>18,00%</td><td>1,10</td><td>0,00%</td><td>21,00%</td><td>543.000.000,00</td><td>1.083.050.000,00</td><td>0,10</td><td>8,00%</td></tr>
<tr><td>MNSA3</td><td>0,42</td><td>0,00</td><td>0,00</td><td>0,000</td><td>0,00%</td><td>0,000</td><td>0,00</td><td>0,00</td><td>0,00</td><td>0,00</td><td>0,00</td><td>66,76%</td><td>-208,15%</td><td>-362,66%</td><td>3,63</td><td>-13,50%</td><td>145,70%</td><td>0,00</td><td>-9.105.000,00</td><td>-5,16</td><td>-41,11%</td></tr></table>`;
const EXEMPLO_FIIS = `<table><tr><th>Papel</th><th>Segmento</th><th>Cotação</th><th>FFO Yield</th><th>Dividend Yield</th><th>P/VP</th><th>Valor de Mercado</th><th>Liquidez</th><th>Qtd de imóveis</th><th>Preço do m2</th><th>Aluguel por m2</th><th>Cap Rate</th><th>Vacância Média</th><th>Endereço</th></tr>
<tr><td>ABCP11</td><td>Shoppings</td><td>77,15</td><td>9,28%</td><td>9,26%</td><td>0,70</td><td>363.306.000</td><td>42.519</td><td>1</td><td>5.072,02</td><td>593,72</td><td>11,71%</td><td>2,69%</td><td>Avenida Industrial, 600</td></tr></table>`;
const EXEMPLO_PROV_ACAO = `<table><tr><th>Data</th><th>Valor</th><th>Tipo</th><th>Data de Pagamento</th><th>Por quantas ações</th></tr><tr><td>30/09/2026</td><td>0,0182</td><td>JRS CAP PROPRIO</td><td>03/11/2026</td><td>1</td></tr><tr><td>18/06/2026</td><td>0,3619</td><td>DIVIDENDO</td><td>28/08/2026</td><td>1</td></tr></table>`;
const EXEMPLO_PROV_FII = `<table><tr><th>Última Data Com</th><th>Tipo</th><th>Data de Pagamento</th><th>Valor</th></tr><tr><td>30/09/2026</td><td>Rendimento</td><td>15/10/2026</td><td>1,17</td></tr><tr><td>31/08/2026</td><td>Amortização</td><td>15/09/2026</td><td>9,99</td></tr></table>`;
function teste() {
  const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.error("FALHOU:", m, JSON.stringify(a), "!=", JSON.stringify(b)); process.exit(1); } };
  eq(numero("1.083.050.000,00"), 1083050000, "número grande"); eq(numero("9,26%"), 0.0926, "percentual"); eq(numero("-"), null, "traço"); eq(numero("-208,15%"), -2.0815, "negativo");
  const A = lerAcoes(EXEMPLO_ACOES); eq(A.length, 2, "ações"); eq([A[0].t, A[0].p, A[0].pl, A[0].pvp, A[0].dy, A[0].roe, A[0].liq, A[0].dl, A[0].cr5, A[0].mliq], ["ITUB4", 38.5, 8.9, 1.95, 0.065, 0.21, 543000000, 0.1, 0.08, 0.18], "campos ações");
  const F = lerFiis(EXEMPLO_FIIS); eq(F.length, 1, "fiis"); eq([F[0].t, F[0].seg, F[0].p, F[0].dy, F[0].pvp, F[0].liq, F[0].vac, F[0].im], ["ABCP11", "Shoppings", 77.15, 0.0926, 0.7, 42519, 0.0269, 1], "campos fiis");
  const pa = lerProventos(EXEMPLO_PROV_ACAO, false); eq(pa.length, 2, "proventos ação"); eq(+pa[0].v.toFixed(5), 0.01547, "JCP com IR 15%"); eq(pa[1].v, 0.3619, "dividendo sem IR");
  const pf = lerProventos(EXEMPLO_PROV_FII, true); eq(pf.length, 1, "FII ignora amortização"); eq(pf[0].v, 1.17, "valor FII");
  const r = resumir(pf, new Date("2026-10-11T12:00:00Z")); eq([r.dv12, r.mp, r.ult], [1.17, 1, "2026-09-30"], "resumo"); eq([r.mm && r.mm[8], r.mm && r.mm[2]], [1, 0], "calendário de proventos");
  const d = lerSetor(EXEMPLO_DET); eq([d.setor, d.sub], ["Intermediários Financeiros", "Bancos"], "setor e subsetor"); eq([d.o12, d.oy["2025"], d.oy["2024"], Object.keys(d.oy).length], [0.4948, 0.624, -0.038, 3], "oscilações");
  console.log("Leitor OK: ações, FIIs, proventos e resumo conferem com o exemplo.");
}

// ---------------------------------------------------------------- coleta
async function coletar() {
  const [hA, hF] = await Promise.all([baixar(BASE + "/resultado.php"), baixar(BASE + "/fii_resultado.php")]);
  let acoes = lerAcoes(hA).filter(a => a.p > 0 && a.liq >= LIQ_MIN_ACAO && a.pl > 0).sort((a, b) => b.liq - a.liq).slice(0, MAX_ACOES);
  let fiis = lerFiis(hF).filter(f => f.p > 0 && f.liq >= LIQ_MIN_FII && f.dy > 0).sort((a, b) => b.liq - a.liq).slice(0, MAX_FIIS);
  if (acoes.length < 80 || fiis.length < 40) throw new Error(`poucos ativos lidos (${acoes.length} ações, ${fiis.length} FIIs): a página do Fundamentus pode ter mudado`);
  console.log(`Lidos ${acoes.length} ações e ${fiis.length} FIIs. Buscando proventos…`);
  let falhas = 0;
  const prov = async (x, fii) => {
    try {
      const html = await baixar(`${BASE}/${fii ? "fii_proventos" : "proventos"}.php?papel=${x.t}&tipo=2`);
      Object.assign(x, resumir(lerProventos(html, fii)));
    } catch (e) { falhas++; console.warn("sem proventos de", x.t, "-", e.message); }
  };
  await emLotes(acoes, 3, a => prov(a, false));
  await emLotes(fiis, 3, f => prov(f, true));
  let semDet = 0;
  const det = async x => {
    try { const d = lerSetor(await baixar(`${BASE}/detalhes.php?papel=${x.t}`)); Object.assign(x, d); } catch (e) { semDet++; }
  };
  await emLotes(acoes, 3, det);
  await emLotes(fiis, 3, async f => { await det(f); delete f.setor; delete f.sub; });
  if (semDet) console.warn(`${semDet} ativos sem página de detalhes (setor e histórico de preço): o catálogo segue funcionando sem eles`);
  if (falhas > (acoes.length + fiis.length) * 0.3) throw new Error(`muitas falhas ao buscar proventos (${falhas})`);
  const cat = { versao: 1, geradoEm: new Date().toISOString(), fonte: "Fundamentus (resultado, FIIs e proventos)", acoes, fiis };
  await mkdir("docs", { recursive: true });
  await writeFile("docs/catalogo.json", JSON.stringify(cat));
  console.log(`Catálogo gravado: ${acoes.length} ações, ${fiis.length} FIIs, ${falhas} sem proventos.`);
}

if (process.argv[1] && process.argv[1].endsWith("coletar.mjs")) {
  (process.argv.includes("--teste") ? Promise.resolve(teste()) : coletar()).catch(e => { console.error("ERRO:", e.message); process.exit(1); });
}
