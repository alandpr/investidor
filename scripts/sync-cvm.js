// ─────────────────────────────────────────────────────────────────────────
// Sincroniza proventos de FIIs (CVM → Firestore)
//
// Modo diagnóstico (não grava nada, só inspeciona os dados da CVM):
//   DIAGNOSTIC=true node scripts/sync-cvm.js
//
// Modo normal (grava proventos novos no Firestore):
//   FIREBASE_SERVICE_ACCOUNT='{...json...}' node scripts/sync-cvm.js
// ─────────────────────────────────────────────────────────────────────────
const admin = require('firebase-admin');
const AdmZip = require('adm-zip');
const https = require('https');

const DIAGNOSTIC = String(process.env.DIAGNOSTIC || '').toLowerCase() === 'true';
const CVM_BASE = 'https://dados.cvm.gov.br/dados/FII/DOC/INF_MENSAL/DADOS';

// ── Helpers ─────────────────────────────────────────────────────────────
function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Muitos redirecionamentos: ' + url));
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} ao baixar ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// CSVs da CVM: latin1, separador ';'
function parseCSV(buf) {
  const text = buf.toString('latin1');
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = lines[0].split(';').map(h => h.trim());
  const rows = lines.slice(1).map(line => {
    const cols = line.split(';');
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (cols[i] || '').trim(); });
    return obj;
  });
  return { headers, rows };
}

function norm(s) {
  return String(s || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function findColumn(headers, candidates) {
  const normHeaders = headers.map(norm);
  for (const cand of candidates) {
    const idx = normHeaders.findIndex(h => h === norm(cand));
    if (idx >= 0) return headers[idx];
  }
  for (const cand of candidates) {
    const idx = normHeaders.findIndex(h => h.includes(norm(cand)));
    if (idx >= 0) return headers[idx];
  }
  return null;
}

function brNumberToFloat(s) {
  if (!s) return 0;
  // remove separador de milhar (.) e troca vírgula decimal por ponto
  const clean = String(s).trim().replace(/\./g, '').replace(',', '.');
  return parseFloat(clean) || 0;
}

function toISODate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const m2 = String(s).match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m2) return `${m2[3]}-${m2[2]}-${m2[1]}`;
  return null;
}

function normalizaTipo(t) {
  const n = norm(t);
  if (n.includes('AMORTIZ')) return 'Amortização';
  if (n.includes('JCP') || n.includes('JURO')) return 'JCP';
  if (n.includes('DIVID')) return 'Dividendo';
  return 'Rendimento';
}

// mesma lógica usada no app (index.html) para calcular posição numa data
function qtyAtDate(ops, codigo, dateISO) {
  let qtd = 0;
  ops.filter(o => o.codigo === codigo && o.data <= dateISO)
     .sort((a, b) => a.data < b.data ? -1 : 1)
     .forEach(op => { qtd += op.tipo === 'compra' ? op.qtd : -op.qtd; });
  return Math.max(0, qtd);
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  const anoAtual = new Date().getFullYear();
  const anos = [anoAtual, anoAtual - 1];

  let allHeaders = null;
  let allRows = [];

  for (const ano of anos) {
    const url = `${CVM_BASE}/inf_mensal_fii_${ano}.zip`;
    console.log(`\nBaixando ${url} ...`);
    let buf;
    try {
      buf = await download(url);
    } catch (e) {
      console.log(`  -> falhou: ${e.message}`);
      continue;
    }
    console.log(`  OK (${(buf.length / 1024).toFixed(0)} KB)`);

    const zip = new AdmZip(buf);
    const entries = zip.getEntries();
    console.log(`  Arquivos no ZIP (${entries.length}):`);
    entries.forEach(e => console.log('   -', e.entryName));

    const rendEntry = entries.find(e => /rendimento/i.test(e.entryName));
    if (!rendEntry) {
      console.log('  !! Nenhum arquivo com "rendimento" no nome encontrado neste ZIP.');
      if (DIAGNOSTIC) {
        // em modo diagnóstico, mostra colunas de TODOS os arquivos pra ajudar a localizar
        entries.forEach(e => {
          if (!/\.csv$/i.test(e.entryName)) return;
          const { headers, rows } = parseCSV(e.getData());
          console.log(`\n  [${e.entryName}] (${rows.length} linhas)`);
          console.log('  Colunas:', headers.join(' | '));
        });
      }
      continue;
    }

    const { headers, rows } = parseCSV(rendEntry.getData());
    console.log(`  Arquivo de rendimentos: ${rendEntry.entryName} (${rows.length} linhas)`);
    console.log(`  Colunas: ${headers.join(' | ')}`);
    if (DIAGNOSTIC && rows.length > 0) {
      console.log('  Exemplo de linha:', JSON.stringify(rows[0], null, 2));
    }

    allHeaders = allHeaders || headers;
    allRows = allRows.concat(rows);
  }

  if (DIAGNOSTIC) {
    console.log('\n[DIAGNOSTIC] Nada foi gravado no Firestore. Revise as colunas acima.');
    return;
  }

  if (!allHeaders || allRows.length === 0) {
    console.log('\nNenhum dado de rendimentos encontrado. Abortando sem gravar.');
    return;
  }

  // detecta colunas relevantes (lida com pequenas variações de nome entre anos)
  const COL = {
    cnpj: findColumn(allHeaders, ['CNPJ_Fundo_Classe', 'CNPJ_Fundo', 'CNPJ_FUNDO_CLASSE', 'CNPJ_FUNDO', 'CNPJ']),
    dataRegistro: findColumn(allHeaders, ['Data_Registro', 'Data_Base', 'Data_Aprovacao', 'Data_Referencia']),
    dataPagamento: findColumn(allHeaders, ['Data_Pagamento', 'Data_Pagto']),
    valorCota: findColumn(allHeaders, ['Valor_Provento_Cota', 'Valor_Rendimento_Cota', 'Valor_Total_Provento_Cota', 'Valor_Cota']),
    tipo: findColumn(allHeaders, ['Tipo_Rendimento', 'Tipo_Provento', 'Tipo']),
  };
  console.log('\nColunas detectadas:', COL);

  const faltando = Object.entries(COL).filter(([, v]) => !v).map(([k]) => k);
  if (faltando.length > 0) {
    console.log(`\n!! Não consegui identificar as colunas: ${faltando.join(', ')}.`);
    console.log('Rode com DIAGNOSTIC=true para ver as colunas disponíveis e ajuste os candidatos em COL.');
    return;
  }

  // ── Firestore ────────────────────────────────────────────────────────
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
  const db = admin.firestore();

  // monta mapa CNPJ -> [{uid, ticker}], carregando operações e proventos já lançados
  const usersSnap = await db.collection('usuarios').get();
  const cnpjMap = {};
  const userData = {};

  for (const userDoc of usersSnap.docs) {
    const uid = userDoc.id;
    const cadSnap = await db.collection('usuarios').doc(uid).collection('fii_cadastro').get();
    if (cadSnap.empty) continue;

    const opsSnap = await db.collection('usuarios').doc(uid).collection('operacoes').get();
    const ops = opsSnap.docs.map(d => d.data());

    const provSnap = await db.collection('usuarios').doc(uid).collection('proventos')
      .where('origem', '==', 'cvm').get();
    const existentes = new Set(provSnap.docs.map(d => d.data().refCvm).filter(Boolean));

    userData[uid] = { ops, existentes };

    cadSnap.docs.forEach(d => {
      const { ticker, cnpj } = d.data();
      if (!cnpj || !ticker) return;
      (cnpjMap[cnpj] = cnpjMap[cnpj] || []).push({ uid, ticker });
    });
  }

  console.log(`\nUsuários com FIIs cadastrados: ${Object.keys(userData).length}`);
  console.log(`CNPJs monitorados: ${Object.keys(cnpjMap).length}`);

  let criados = 0;
  for (const row of allRows) {
    const cnpj = String(row[COL.cnpj] || '').replace(/\D/g, '');
    const targets = cnpjMap[cnpj];
    if (!targets) continue;

    const valorCota = brNumberToFloat(row[COL.valorCota]);
    if (valorCota <= 0) continue;

    const dataRegistro = toISODate(row[COL.dataRegistro]);
    const dataPagamento = toISODate(row[COL.dataPagamento]) || dataRegistro;
    if (!dataRegistro || !dataPagamento) continue;

    const tipoCvm = row[COL.tipo] || 'Rendimento';

    for (const { uid, ticker } of targets) {
      const refCvm = `${cnpj}_${dataRegistro}_${dataPagamento}`;
      const { ops, existentes } = userData[uid];
      if (existentes.has(refCvm)) continue;

      const qtd = qtyAtDate(ops, ticker, dataRegistro);
      if (qtd <= 0) continue;

      const total = qtd * valorCota;
      await db.collection('usuarios').doc(uid).collection('proventos').add({
        codigo: ticker,
        tipo: normalizaTipo(tipoCvm),
        data: dataPagamento,
        valorCota,
        qtd,
        total,
        origem: 'cvm',
        refCvm,
        criadoEm: admin.firestore.FieldValue.serverTimestamp(),
      });

      existentes.add(refCvm);
      criados++;
      console.log(`+ ${ticker} (uid ${uid.slice(0, 6)}...): ${tipoCvm} R$ ${valorCota} x ${qtd} = R$ ${total.toFixed(2)} | pagamento ${dataPagamento}`);
    }
  }

  console.log(`\nConcluído. ${criados} provento(s) novo(s) lançado(s).`);
}

main().catch(e => {
  console.error('Erro:', e);
  process.exit(1);
});
