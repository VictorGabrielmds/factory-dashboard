// Uso: node scripts/auditar-exposicao-publica.cjs
// Não lê .env, node_modules, .git ou diretórios temporários; não imprime valores encontrados.
const fs = require('node:fs');
const path = require('node:path');
const { CAMINHOS_PADRAO, analisarExposicaoPublica } = require('./lib/auditoria-exposicao-publica.cjs');

const raiz = path.resolve(__dirname, '..');
const ignorados = new Set(['node_modules', '.git', '.firebase', '.pnpm-store', '.claude', '.codex-temp', 'functions-backup-antigo']);

function coletar(caminhoRelativo, arquivos) {
  const absoluto = path.join(raiz, caminhoRelativo);
  if (!fs.existsSync(absoluto)) return;
  const stat = fs.statSync(absoluto);
  if (stat.isFile()) {
    if (path.extname(absoluto).toLowerCase() !== '.env') arquivos.push({ nome: caminhoRelativo, conteudo: fs.readFileSync(absoluto, 'utf8') });
    return;
  }
  for (const entrada of fs.readdirSync(absoluto, { withFileTypes: true })) {
    if (ignorados.has(entrada.name) || entrada.name.startsWith('.tmp-')) continue;
    coletar(path.join(caminhoRelativo, entrada.name), arquivos);
  }
}

try {
  const arquivos = [];
  for (const caminho of CAMINHOS_PADRAO) coletar(caminho, arquivos);
  const resultado = analisarExposicaoPublica(arquivos);
  console.log(JSON.stringify({ escopo: CAMINHOS_PADRAO, arquivosAnalisados: arquivos.length, ...resultado }, null, 2));
  process.exitCode = resultado.bloqueios ? 1 : 0;
} catch (erro) {
  console.error(erro.message === 'INVENTARIO_INCOMPLETO' ? 'Inventário de exposição indisponível.' : 'Não foi possível concluir a auditoria de exposição.');
  process.exitCode = 2;
}
