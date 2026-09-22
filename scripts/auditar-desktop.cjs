// Auditoria local, sem Firebase, rede, instalação ou execução do robô.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { analisarDesktop } = require('./lib/auditoria-desktop.cjs');
let etapa = 'fontes';

function main() {
  if (process.argv.length > 3) throw new Error('ARGUMENTOS_INVALIDOS');
  const raiz = path.resolve(process.argv[2] || 'C:/Users/vgmds/source/repos/RoboImpressaoDelivery');
  const fonte = path.join(raiz, 'RoboImpressaoDelivery');
  const arquivos = fs.readdirSync(fonte, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(?:cs|csproj)$/.test(e.name))
    .map((e) => {
      const arquivo = path.join(fonte, e.name);
      if (fs.statSync(arquivo).size > 2 * 1024 * 1024) throw new Error('FONTE_ACIMA_LIMITE');
      return { nome: e.name, conteudo: fs.readFileSync(arquivo, 'utf8') };
    });
  const projeto = arquivos.find((a) => a.nome === 'RoboImpressaoDelivery.csproj');
  const versao = projeto?.conteudo.match(/<Version>(\d+\.\d+\.\d+)<\/Version>/)?.[1];
  if (!versao) throw new Error('VERSAO_AUSENTE');
  const zip = path.join(raiz, `RoboImpressaoDelivery-v${versao}.zip`);
  const exe = path.join(raiz, `publicado-v${versao}`, 'RoboImpressaoDelivery.exe');
  const dll = path.join(raiz, `publicado-v${versao}`, 'RoboImpressaoDelivery.dll');
  // Caminhos passam por ambiente do subprocesso, nunca por interpolação de shell.
  // Só lê o diretório do ZIP e metadados do EXE; não extrai nem executa entradas.
  const comando = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$pacote = [System.IO.Compression.ZipFile]::OpenRead($env:FACTORY_DESKTOP_AUDIT_ZIP)
try {
  $entradas = @($pacote.Entries | ForEach-Object { $_.FullName })
  $exe = Get-Item -LiteralPath $env:FACTORY_DESKTOP_AUDIT_EXE
  $assinatura = Get-AuthenticodeSignature -LiteralPath $env:FACTORY_DESKTOP_AUDIT_EXE
  [Console]::Write((@{ entradas = $entradas; versaoArquivo = $exe.VersionInfo.FileVersion;
    assinatura = $assinatura.Status.ToString() } | ConvertTo-Json -Compress))
} finally { $pacote.Dispose() }`;
  etapa = 'metadados-pacote';
  // Não carregar módulos do PowerShell 7 no Windows PowerShell 5.1 filho.
  // Deixa o filho reconstruir o caminho padrão, sem alterar o ambiente da máquina.
  const ambienteFilho = Object.fromEntries(Object.entries(process.env)
    .filter(([nome]) => nome.toLowerCase() !== 'psmodulepath'));
  const saida = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', comando], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...ambienteFilho, FACTORY_DESKTOP_AUDIT_ZIP: zip, FACTORY_DESKTOP_AUDIT_EXE: exe },
  });
  etapa = 'interpretar-metadados';
  const meta = JSON.parse(saida.trim().replace(/^\uFEFF/, ''));
  const resultado = analisarDesktop(arquivos, meta.entradas);
  if (meta.assinatura !== 'Valid') resultado.achados.push({ codigo: 'EXECUTAVEL_SEM_ASSINATURA_VALIDA', arquivo: path.basename(exe) });
  if (meta.versaoArquivo !== `${versao}.0`) resultado.achados.push({ codigo: 'VERSAO_EXECUTAVEL_DIVERGENTE', arquivo: path.basename(exe) });
  etapa = 'hashes';
  const hash = (arquivo) => crypto.createHash('sha256').update(fs.readFileSync(arquivo)).digest('hex');
  console.log(JSON.stringify({ ...resultado, bloqueiosEstaticos: resultado.achados.length,
    instante: new Date().toISOString(), versaoFonte: versao, versaoExecutavel: meta.versaoArquivo,
    versaoInstaladaNaLoja: 'NAO_CONFIRMADA', assinatura: meta.assinatura,
    quantidadeFontes: arquivos.length, quantidadeEntradasPacote: meta.entradas.length,
    artefatos: [zip, exe, dll].map((a) => ({ nome: path.basename(a), sha256: hash(a) })),
  }, null, 2));
  process.exitCode = resultado.achados.length ? 1 : 0;
}
mainCatch();
function mainCatch() {
  try { main(); } catch (erro) {
    console.error('Inventário indisponível. Confira a pasta do projeto, o pacote e as permissões de leitura. Nenhuma credencial foi exibida.');
    console.error(JSON.stringify({ etapa, codigo: ['EACCES', 'ENOENT', 'ETIMEDOUT', 'EPERM'].includes(erro.code) ? erro.code : 'FALHA_LOCAL',
      subprocesso: Number.isInteger(erro.status) ? erro.status : null,
      categoriaPowerShell: String(erro.stderr || '').match(/FullyQualifiedErrorId\s*:\s*([A-Za-z0-9_.]+)/)?.[1] || null }));
    process.exitCode = 2;
  }
}
