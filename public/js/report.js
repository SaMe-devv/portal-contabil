// Relatório (cliente, notas, ranking e gráfico). Usado por ADM e CLIENTE.
import { $, esc, brl, compact, percent, fmtDate, fmtDoc } from './util.js';

const FILTER_IDS = ['op', 'tipo', 'de', 'ate', 'uf', 'min', 'max', 'q'];
const OPS = { entrada: 'Entrada', saida: 'Saída' };

// Textos que mudam conforme a operação escolhida.
const TEXTS = {
  entrada: {
    main: 'Relatório de Entradas/Compras', notes: 'Notas Fiscais Entradas [Filtros]', rank: 'Ranking De Fornecedores',
    chart: 'Evolução Das Compras No Mês', doc: 'CNPJ do emitente', nome: 'Nome do emitente', party: 'Fornecedor',
  },
  saida: {
    main: 'Relatório de Saídas/Vendas', notes: 'Notas Fiscais Saídas [Filtros]', rank: 'Ranking De Clientes',
    chart: 'Evolução Das Vendas No Mês', doc: 'CNPJ/CPF do destinatário', nome: 'Nome do destinatário', party: 'Cliente',
  },
  todas: {
    main: 'Relatório de Entradas e Saídas', notes: 'Notas Fiscais [Filtros]', rank: 'Ranking De Fornecedores E Clientes',
    chart: 'Evolução Do Movimento No Mês', doc: 'CNPJ/CPF', nome: 'Nome', party: 'Fornecedor/Cliente',
  },
};

// A "contraparte" é quem está do outro lado da nota: o emitente nas entradas e o destinatário nas saídas.
const counterparty = (n) => (n.op === 'entrada'
  ? { doc: n.eCnpj, nome: n.eNome, uf: n.eUF }
  : { doc: n.dCnpj, nome: n.dNome || 'Consumidor não identificado', uf: n.dUF });

export async function mountReport(root) {
  root.innerHTML = await (await fetch('partials/report.html')).text();
  const el = (id) => $(`#${id}`, root);
  let profile = null;
  let notes = [];

  function filteredNotes() {
    const op = el('op').value;
    const tipo = el('tipo').value;
    const from = el('de').value;
    const to = el('ate').value;
    const uf = el('uf').value;
    const min = parseFloat(el('min').value);
    const max = parseFloat(el('max').value);
    const query = el('q').value.toLowerCase().trim();
    const queryDigits = query.replace(/\D/g, '') || '§';

    return notes.filter((n) => {
      const p = counterparty(n);
      return (op === 'todas' || n.op === op) && (!tipo || n.tipo === tipo)
        && (!from || n.date >= from) && (!to || n.date <= to) && (!uf || p.uf === uf)
        && (Number.isNaN(min) || n.val >= min) && (Number.isNaN(max) || n.val <= max)
        && (!query || p.nome.toLowerCase().includes(query) || p.doc.includes(queryDigits));
    });
  }

  function drawProfile() {
    const p = profile;
    const address = [p.lgr, p.nro, p.cpl].filter(Boolean).join(', ');
    const fields = [
      ['Razão social', p.nome],
      ['CNPJ/CPF', fmtDoc(p.doc)],
      ['Inscrição estadual', p.ie],
      ['Endereço', address],
      ['Bairro', p.bairro],
      ['Município/UF', [p.mun, p.uf].filter(Boolean).join(' / ')],
      ['CEP', p.cep ? p.cep.replace(/(\d{5})(\d{3})/, '$1-$2') : ''],
      ['Telefone', p.fone],
    ];
    el('dest').innerHTML = fields
      .filter(([, value]) => value)
      .map(([label, value]) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`)
      .join('');
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

  function drawTable(rows, total) {
    el('rows').innerHTML = rows.length
      ? rows.map((n) => {
        const p = counterparty(n);
        return `
          <tr>
            <td>${fmtDate(n.date)}</td>
            <td>${esc(n.nf)}</td>
            <td>${esc(n.tipo)}</td>
            <td>${OPS[n.op]}</td>
            <td>${esc(fmtDoc(p.doc))}</td>
            <td class="nm">${esc(p.nome)}</td>
            <td>${esc(p.uf)}</td>
            <td class="num">${brl.format(n.val)}</td>
          </tr>`;
      }).join('')
      : '<tr><td colspan="8" class="empty">Nenhuma nota encontrada com esses filtros.</td></tr>';
    el('foot').innerHTML = `<tr><td colspan="7">${rows.length} notas</td><td class="num">${brl.format(total)}</td></tr>`;
  }

  function drawRanking(rows, total) {
    const byParty = new Map();
    for (const n of rows) {
      const p = counterparty(n);
      const key = p.doc || p.nome;
      const item = byParty.get(key) || { ...p, qtd: 0, total: 0 };
      item.qtd += 1;
      item.total += n.val;
      byParty.set(key, item);
    }
    const ranking = [...byParty.values()].sort((a, b) => b.total - a.total || b.qtd - a.qtd);

    el('rank').innerHTML = ranking.length
      ? ranking.map((s, i) => `
          <tr>
            <td>${i + 1}</td>
            <td class="nm">${esc(s.nome)}</td>
            <td>${esc(fmtDoc(s.doc))}</td>
            <td>${esc(s.uf)}</td>
            <td class="num">${s.qtd}</td>
            <td class="num">${brl.format(s.total)}</td>
            <td class="num">${percent(total ? (s.total / total) * 100 : 0)}</td>
          </tr>`).join('')
      : '<tr><td colspan="7" class="empty">Sem dados para o ranking.</td></tr>';
  }

  function drawChart(rows) {
    const months = [...new Set(rows.map((n) => n.date.slice(0, 7)).filter(Boolean))].sort();
    const previous = el('mes').value;
    el('mes').innerHTML = months.map((m) => `<option value="${m}">${m.slice(5)}/${m.slice(0, 4)}</option>`).join('');
    const month = months.includes(previous) ? previous : months[months.length - 1];

    if (!month) {
      el('chart').innerHTML = '<div class="empty">Sem dados para o gráfico.</div>';
      el('chcap').textContent = '';
      return;
    }
    el('mes').value = month;

    const daysInMonth = new Date(+month.slice(0, 4), +month.slice(5), 0).getDate();
    const perDay = Array(daysInMonth).fill(0);
    rows.filter((n) => n.date.startsWith(month)).forEach((n) => { perDay[+n.date.slice(8, 10) - 1] += n.val; });

    let running = 0;
    const cumulative = perDay.map((v) => (running += v));
    const total = running;
    const peak = Math.max(...perDay) || 1;

    const W = 900, H = 300, L = 62, R = 62, T = 14, B = 28;
    const plotW = W - L - R, plotH = H - T - B, slot = plotW / daysInMonth, baseline = T + plotH;

    let svg = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolução diária no mês">`;
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
      svg += `<rect class="bb" x="${x + slot * 0.15}" y="${baseline - h}" width="${slot * 0.7}" height="${h}">`
        + `<title>${day}/${month.slice(5)}: ${brl.format(v)}</title></rect>`
        + `<text x="${x + slot / 2}" y="${H - 10}" text-anchor="middle" fill="currentColor" font-size="10">${i + 1}</text>`;
    });
    const points = cumulative
      .map((v, i) => `${L + i * slot + slot / 2},${baseline - (total ? v / total : 0) * plotH}`)
      .join(' ');
    svg += `<polyline class="ln" points="${points}"/></svg>`;

    el('chart').innerHTML = svg;
    el('chcap').textContent = `Barras: valor por dia, em R$ (eixo esquerdo). `
      + `Linha: valor acumulado no mês (eixo direito). Total do mês: ${brl.format(total)}.`;
  }

  function draw() {
    const rows = filteredNotes();
    const total = rows.reduce((sum, n) => sum + n.val, 0);
    drawTitles(TEXTS[el('op').value]);
    drawTable(rows, total);
    drawRanking(rows, total);
    drawChart(rows);
  }

  FILTER_IDS.forEach((id) => el(id).addEventListener('input', draw));
  el('mes').addEventListener('change', draw);
  el('clear').addEventListener('click', () => {
    FILTER_IDS.filter((id) => id !== 'op').forEach((id) => { el(id).value = ''; });
    draw();
  });
  el('print').addEventListener('click', () => window.print());

  return {
    render(newProfile, newNotes) {
      profile = newProfile;
      notes = newNotes;

      // Abre em "Entradas" se houver; senão em "Saídas" (ex.: cliente que só emite NFC-e).
      el('op').value = notes.some((n) => n.op === 'entrada') || !notes.length ? 'entrada' : 'saida';

      const ufs = [...new Set(notes.map((n) => counterparty(n).uf).filter(Boolean))].sort();
      const selected = el('uf').value;
      el('uf').innerHTML = `<option value="">Todas</option>${ufs.map((u) => `<option>${u}</option>`).join('')}`;
      if (ufs.includes(selected)) el('uf').value = selected;

      drawProfile();
      draw();
    },
  };
}
