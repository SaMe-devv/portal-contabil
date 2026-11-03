// Relatório (cliente, resumo do mês, notas, ranking, gráfico e download dos XMLs). Usado por ADM e CLIENTE.
import { api } from './api.js';
import { $, esc, brl, compact, int, percent, fmtDate, fmtDateTime, fmtDoc, icon } from './util.js';

const FILTER_IDS = ['op', 'tipo', 'sit', 'de', 'ate', 'uf', 'min', 'max', 'q'];
const OPS = { entrada: 'Entrada', saida: 'Saída' };
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

// Textos que mudam conforme a operação escolhida.
const TEXTS = {
  entrada: {
    main: 'Relatório de entradas e compras', notes: 'Notas fiscais de entrada', rank: 'Maiores fornecedores',
    chart: 'Compras dia a dia', doc: 'CNPJ do emitente', nome: 'Emitente', party: 'Fornecedor',
  },
  saida: {
    main: 'Relatório de saídas e vendas', notes: 'Notas fiscais de saída', rank: 'Maiores clientes',
    chart: 'Vendas dia a dia', doc: 'CNPJ/CPF do destinatário', nome: 'Destinatário', party: 'Cliente',
  },
  todas: {
    main: 'Relatório de entradas e saídas', notes: 'Notas fiscais', rank: 'Maiores fornecedores e clientes',
    chart: 'Movimento dia a dia', doc: 'CNPJ/CPF', nome: 'Nome', party: 'Fornecedor ou cliente',
  },
};

// A "contraparte" é quem está do outro lado da nota: o emitente nas entradas e o destinatário nas saídas.
const counterparty = (n) => (n.op === 'entrada'
  ? { doc: n.eCnpj, nome: n.eNome, uf: n.eUF }
  : { doc: n.dCnpj, nome: n.dNome || 'Consumidor não identificado', uf: n.dUF });

const monthLabel = (m) => `${MONTHS[Number(m.slice(5)) - 1]} de ${m.slice(0, 4)}`;

// Descompacta o XML (gzip em base64) no navegador.
async function gunzip(b64) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

export async function mountReport(root, { clientId = null } = {}) {
  root.innerHTML = await (await fetch('partials/report.html')).text();
  const el = (id) => $(`#${id}`, root);
  let profile = null;
  let notes = [];
  let sync = null;

  function filteredNotes() {
    const op = el('op').value;
    const tipo = el('tipo').value;
    const sit = el('sit').value;
    const from = el('de').value;
    const to = el('ate').value;
    const uf = el('uf').value;
    const min = parseFloat(el('min').value);
    const max = parseFloat(el('max').value);
    const query = el('q').value.toLowerCase().trim();
    const queryDoc = query.toUpperCase().replace(/[^0-9A-Z]/g, '') || '§';

    return notes.filter((n) => {
      const p = counterparty(n);
      return (op === 'todas' || n.op === op) && (!tipo || n.tipo === tipo)
        && (!sit || (sit === 'validas' ? n.situacao === 'autorizada' : n.situacao === sit))
        && (!from || n.date >= from) && (!to || n.date <= to) && (!uf || p.uf === uf)
        && (Number.isNaN(min) || n.val >= min) && (Number.isNaN(max) || n.val <= max)
        && (!query || p.nome.toLowerCase().includes(query) || String(p.doc).includes(queryDoc));
    });
  }

  function drawProfile() {
    const p = profile;
    el('rNome').textContent = p.nome;
    el('rDoc').textContent = fmtDoc(p.doc);
    const address = [p.lgr, p.nro, p.cpl].filter(Boolean).join(', ');
    const fields = [
      ['Inscrição estadual', p.ie],
      ['Endereço', [address, p.bairro].filter(Boolean).join(' – ')],
      ['Município/UF', [p.mun, p.uf].filter(Boolean).join(' / ')],
      ['CEP', p.cep ? p.cep.replace(/(\d{5})(\d{3})/, '$1-$2') : ''],
      ['Telefone', p.fone],
    ];
    const visible = fields.filter(([, value]) => value);
    el('dest').hidden = !visible.length;
    el('dest').innerHTML = visible.map(([label, value]) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`).join('');

    const info = el('sincInfo').querySelector('span');
    if (sync?.enabled && sync.lastRun) info.textContent = `Notas buscadas na SEFAZ às 6h e às 18h. Última busca: ${fmtDateTime(sync.lastRun)}.`;
    else if (sync?.enabled) info.textContent = 'Notas buscadas na SEFAZ às 6h e às 18h.';
    else info.textContent = 'Notas enviadas pelo escritório.';
  }

  function drawTitles(text) {
    el('tMain').textContent = text.main;
    el('tNotes').textContent = text.notes;
    el('tRank').textContent = text.rank;
    el('tChart').textContent = text.chart;
    el('thDoc').textContent = text.doc;
    el('thNome').textContent = text.nome;
    el('thRankNome').textContent = text.party;
  }

  const xmlCell = (n) => (n.xml === 1 ? '<span class="xml-ok">Completo</span>'
    : n.xml === 0 ? '<span class="xml-res" title="A SEFAZ entregou só o resumo desta nota">Resumo</span>' : '<span class="xml-res">—</span>');

  function drawTable(rows, total) {
    el('rows').innerHTML = rows.length
      ? rows.map((n) => {
        const p = counterparty(n);
        const canc = n.situacao === 'cancelada';
        return `
          <tr class="${canc ? 'cancelada' : ''}">
            <td>${fmtDate(n.date)}</td>
            <td>${esc(n.nf)}${canc ? ' <span class="selo off">Cancelada</span>' : ''}</td>
            <td>${esc(n.tipo)}</td>
            <td>${OPS[n.op]}</td>
            <td>${esc(fmtDoc(p.doc))}</td>
            <td class="nome">${esc(p.nome)}</td>
            <td>${esc(p.uf)}</td>
            <td class="num">${brl.format(n.val)}</td>
            <td class="noprint">${xmlCell(n)}</td>
          </tr>`;
      }).join('')
      : `<tr><td colspan="9" class="vazio">${notes.length ? 'Nenhuma nota com esses filtros. Experimente limpar os filtros.' : 'Ainda não há notas para esta empresa.'}</td></tr>`;
    el('foot').innerHTML = rows.length ? `<tr><td colspan="7">${int.format(rows.length)} nota(s)</td><td class="num">${brl.format(total)}</td><td class="noprint"></td></tr>` : '';
    el('notesCap').textContent = rows.length ? `${int.format(rows.length)} nota(s), total de ${brl.format(total)}.` : '';
  }

  function drawRanking(rows, total) {
    const byParty = new Map();
    for (const n of rows) {
      if (n.situacao === 'cancelada') continue;
      const p = counterparty(n);
      const key = p.doc || p.nome;
      const item = byParty.get(key) || { ...p, qtd: 0, total: 0 };
      item.qtd += 1;
      item.total += n.val;
      byParty.set(key, item);
    }
    const ranking = [...byParty.values()].sort((a, b) => b.total - a.total || b.qtd - a.qtd);
    const top = ranking[0]?.total || 1;

    el('rank').innerHTML = ranking.length
      ? ranking.map((s, i) => `
          <tr>
            <td class="num">${i + 1}</td>
            <td class="nome">${esc(s.nome)}</td>
            <td>${esc(fmtDoc(s.doc))}</td>
            <td>${esc(s.uf)}</td>
            <td class="num">${s.qtd}</td>
            <td class="num">${brl.format(s.total)}</td>
            <td><div class="part"><i data-w="${((s.total / top) * 100).toFixed(1)}"></i><span>${percent(total ? (s.total / total) * 100 : 0)}</span></div></td>
          </tr>`).join('')
      : '<tr><td colspan="7" class="vazio">Sem dados para o ranking.</td></tr>';
    // Larguras via CSSOM (permitido pela política de segurança, ao contrário de style="" no HTML).
    root.querySelectorAll('.part i').forEach((bar) => { bar.style.width = `${Math.max(Number(bar.dataset.w), 1) * 1.2}px`; });
  }

  function months() {
    return [...new Set(notes.map((n) => n.date.slice(0, 7)).filter(Boolean))].sort();
  }

  function drawSummary(month) {
    const inMonth = notes.filter((n) => n.date.startsWith(month));
    const valid = inMonth.filter((n) => n.situacao === 'autorizada');
    const sum = (op) => valid.filter((n) => n.op === op).reduce((s, n) => s + n.val, 0);
    const count = (op) => valid.filter((n) => n.op === op).length;
    const canceled = inMonth.filter((n) => n.situacao === 'cancelada').length;
    const items = [
      ['i-receipt', 'Compras', `${count('entrada')} nota(s) de entrada`, brl.format(sum('entrada')), false],
      ['i-chart', 'Vendas', `${count('saida')} nota(s) de saída`, brl.format(sum('saida')), false],
      ['i-doc', 'Canceladas', 'Fora dos totais', String(canceled), canceled > 0],
    ];
    el('resumo').innerHTML = month
      ? items.map(([ic, title, sub, value, hi]) => `
        <li><span class="ic-box">${icon(ic)}</span><div><strong>${title}</strong><small>${sub}</small></div>
        <span class="valor${hi ? ' destaque' : ''}">${value}</span></li>`).join('')
      : '<li><span class="ic-box">' + icon('i-doc') + '</span><div><strong>Sem notas ainda</strong><small>Assim que chegarem, o resumo aparece aqui.</small></div><span></span></li>';
  }

  function drawChart(rows, month) {
    if (!month) {
      el('chart').innerHTML = '<p class="vazio">Sem dados para o gráfico.</p>';
      el('chcap').textContent = '';
      return;
    }
    const daysInMonth = new Date(+month.slice(0, 4), +month.slice(5), 0).getDate();
    const perDay = Array(daysInMonth).fill(0);
    rows.filter((n) => n.date.startsWith(month) && n.situacao !== 'cancelada').forEach((n) => { perDay[+n.date.slice(8, 10) - 1] += n.val; });

    let running = 0;
    const cumulative = perDay.map((v) => (running += v));
    const total = running;
    const peak = Math.max(...perDay) || 1;

    const W = 900, H = 300, L = 62, R = 62, T = 14, B = 28;
    const plotW = W - L - R, plotH = H - T - B, slot = plotW / daysInMonth, baseline = T + plotH;

    let svg = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Valor por dia e acumulado em ${monthLabel(month)}">`;
    for (let i = 0; i <= 4; i += 1) {
      const y = T + (plotH * i) / 4;
      svg += `<line class="gl" x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/>`
        + `<text x="${L - 6}" y="${y + 4}" text-anchor="end" fill="currentColor">${compact.format(peak * (1 - i / 4))}</text>`
        + `<text x="${W - R + 6}" y="${y + 4}" fill="currentColor">${compact.format(total * (1 - i / 4))}</text>`;
    }
    perDay.forEach((v, i) => {
      const x = L + i * slot;
      const h = (v / peak) * plotH;
      const day = String(i + 1).padStart(2, '0');
      svg += `<rect class="bb" rx="2" x="${x + slot * 0.18}" y="${baseline - h}" width="${slot * 0.64}" height="${h}">`
        + `<title>${day}/${month.slice(5)}: ${brl.format(v)}</title></rect>`
        + `<text x="${x + slot / 2}" y="${H - 10}" text-anchor="middle" fill="currentColor" font-size="10">${i + 1}</text>`;
    });
    const points = cumulative
      .map((v, i) => `${L + i * slot + slot / 2},${baseline - (total ? v / total : 0) * plotH}`)
      .join(' ');
    svg += `<polyline class="ln" points="${points}"/></svg>`;

    el('chart').innerHTML = svg;
    el('chcap').textContent = `${monthLabel(month)[0].toUpperCase()}${monthLabel(month).slice(1)}: ${brl.format(total)} nas notas filtradas. Eixo esquerdo: valor do dia; eixo direito: acumulado.`;
  }

  function draw() {
    const rows = filteredNotes();
    const total = rows.filter((n) => n.situacao !== 'cancelada').reduce((sum, n) => sum + n.val, 0);
    const month = el('mes').value;
    drawTitles(TEXTS[el('op').value]);
    drawTable(rows, total);
    drawRanking(rows, total);
    drawSummary(month);
    drawChart(rows, month);
  }

  // Baixa os XMLs das notas filtradas num único .zip.
  async function downloadXmls() {
    const msg = el('xmlMsg');
    const button = el('baixarXml');
    const rows = filteredNotes().filter((n) => n.xml >= 0);
    if (!rows.length) {
      msg.textContent = 'Nenhuma nota filtrada tem XML guardado.';
      msg.hidden = false;
      return;
    }
    if (!window.JSZip || !window.DecompressionStream) {
      msg.textContent = 'Seu navegador não permite gerar o .zip. Atualize o navegador e tente de novo.';
      msg.hidden = false;
      return;
    }
    button.disabled = true;
    const zip = new window.JSZip();
    try {
      const keys = rows.map((n) => n.chave);
      for (let i = 0; i < keys.length; i += 300) {
        msg.textContent = `Preparando ${Math.min(i + 300, keys.length)} de ${keys.length} XMLs…`;
        msg.hidden = false;
        const { xmls } = await api('/api/xmls', {
          method: 'POST',
          body: { client: clientId, chaves: keys.slice(i, i + 300), first: i === 0, total: keys.length },
        });
        for (const x of xmls) zip.file(`${x.chave}${x.full ? '' : '-resumo'}.xml`, await gunzip(x.gz));
      }
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `XMLs-${String(profile.doc)}-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.append(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      const resumos = rows.filter((n) => n.xml === 0).length;
      msg.textContent = `${keys.length} XML(s) baixado(s).${resumos ? ` ${resumos} são resumos: a SEFAZ libera o XML completo depois da ciência da operação.` : ''}`;
    } catch (error) {
      msg.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  FILTER_IDS.forEach((id) => el(id).addEventListener('input', draw));
  el('mes').addEventListener('change', draw);
  el('clear').addEventListener('click', () => {
    FILTER_IDS.filter((id) => id !== 'op').forEach((id) => { el(id).value = id === 'sit' ? 'validas' : ''; });
    draw();
  });
  el('print').addEventListener('click', () => window.print());
  el('baixarXml').addEventListener('click', downloadXmls);

  return {
    render(newProfile, newNotes, newSync = null) {
      profile = newProfile;
      notes = newNotes;
      sync = newSync;

      // Abre em "Entradas" se houver; senão em "Saídas" (ex.: cliente que só emite NFC-e).
      el('op').value = notes.some((n) => n.op === 'entrada') || !notes.length ? 'entrada' : 'saida';

      const ufs = [...new Set(notes.map((n) => counterparty(n).uf).filter(Boolean))].sort();
      const selected = el('uf').value;
      el('uf').innerHTML = `<option value="">Todas</option>${ufs.map((u) => `<option>${esc(u)}</option>`).join('')}`;
      if (ufs.includes(selected)) el('uf').value = selected;

      const list = months();
      const previous = el('mes').value;
      el('mes').innerHTML = list.slice().reverse().map((m) => `<option value="${m}">${monthLabel(m)}</option>`).join('');
      el('mes').value = list.includes(previous) ? previous : (list[list.length - 1] || '');
      el('mes').hidden = !list.length;

      drawProfile();
      draw();
    },
  };
}
