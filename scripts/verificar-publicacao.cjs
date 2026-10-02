// Verificação de release P0. Só consulta configuração/código e faz probes
// negativos com ação inexistente. Não consulta pedidos, usuários ou segredos.
const fs = require('node:fs');
const path = require('node:path');
const { sha1, sha256, hashEndpoint, verificarFuncao, verificarAcesso, storagePodeConsultarStaff, verificarRevisaoAtiva } = require('./lib/verificacao-publicacao.cjs');
const raiz = path.resolve(__dirname, '..');
const cli = path.join(raiz, 'functions/node_modules/firebase-tools');
const projeto = 'entregas-781a8';
const regiao = 'southamerica-east1';
const bucket = 'entregas-781a8.firebasestorage.app';
const origem = 'https://entregas-781a8-painel.web.app';
const alvos = {
  chat: { segredos: ['TOKEN_META'] },
  conversas: { segredos: ['TOKEN_META', 'ASAAS_API_KEY'] },
  clientes: { segredos: [] },
  configuracoes: { segredos: [] },
  pendencias: { segredos: [] },
  processarEventoMeta: { segredos: ['TOKEN_META', 'META_APP_SECRET', 'META_VERIFY_TOKEN'], documento: 'eventos_meta/{eventoId}' },
};

async function main() {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== '--sem-smoke')) throw new Error('ARGUMENTO_INVALIDO');
  if (require(cli + '/package.json').version !== '15.29.0') throw new Error('CLI_NAO_HOMOLOGADA');
  // Saídas da CLI podem incluir ambiente/configuração: só o relatório abaixo sai.
  const { logger } = require(cli + '/lib/logger');
  logger.silent = true;
  logger.clear();
  const { Command } = require(cli + '/lib/command');
  const { requireAuth } = require(cli + '/lib/requireAuth');
  const { Client } = require(cli + '/lib/apiv2');
  const opts = { project: projeto, nonInteractive: true, debug: false, cwd: raiz };
  await new Command('verificar-publicacao').prepare(opts);
  await requireAuth(opts);
  const ro = { retries: 0, timeout: 30000, resolveOnHTTPError: true,
    skipLog: { body: true, resBody: true, queryParams: true } };
  async function get(host, version, endpoint) {
    const resposta = await new Client({ urlPrefix: `https://${host}.googleapis.com`, apiVersion: version }).get(endpoint, { ...ro });
    if (resposta.status !== 200) throw new Error(`CONSULTA_${resposta.status}`);
    return resposta.body;
  }
  const { readdirRecursive } = require(cli + '/lib/fsAsync');
  const config = JSON.parse(fs.readFileSync(path.join(raiz, 'firebase.json'), 'utf8')).functions[0];
  const arquivos = await readdirRecursive({ path: path.join(raiz, config.source),
    ignoreStrings: [...config.ignore, '.runtimeconfig.json'] });
  const sourceHash = sha1(arquivos.map((f) => sha1(fs.readFileSync(f.name))).sort().join(''));
  const { getFirebaseConfig } = require(cli + '/lib/functionsConfig');
  const { loadFirebaseEnvs, loadUserEnvs } = require(cli + '/lib/functions/env');
  const environmentVariables = {
    ...loadUserEnvs({ functionsSource: path.join(raiz, config.source), projectId: projeto, projectDir: raiz }),
    ...loadFirebaseEnvs(await getFirebaseConfig(opts), projeto),
  };
  const resultados = [];
  // O deploy não interativo da CLI não verifica esta permissão. Sem ela,
  // firestore.get/exists nas regras do Storage nega até a equipe legítima.
  try {
    const { getProjectNumber } = require(cli + '/lib/getProjectNumber');
    const numero = await getProjectNumber(opts);
    const resposta = await new Client({ urlPrefix: 'https://cloudresourcemanager.googleapis.com', apiVersion: 'v1' })
      .post(`/projects/${projeto}:getIamPolicy`, { options: { requestedPolicyVersion: 3 } }, { ...ro });
    if (resposta.status !== 200) throw new Error('IAM_INDISPONIVEL');
    const permitida = storagePodeConsultarStaff(resposta.body,
      `serviceAccount:service-${numero}@gcp-sa-firebasestorage.iam.gserviceaccount.com`);
    resultados.push({ recurso: 'storage:consulta-staff', erros: permitida ? [] : ['PERMISSAO_FIRESTORE_AUSENTE'] });
  } catch { resultados.push({ recurso: 'storage:consulta-staff', erros: ['VERIFICACAO_INDISPONIVEL'] }); }
  // Sequencial e com deadline: esta verificação não simula carga em produção.
  for (const [nome, contrato] of Object.entries(alvos)) {
    try {
      const publicada = await get('cloudfunctions', 'v2', `/projects/${projeto}/locations/${regiao}/functions/${nome}`);
      const segredosRemotos = publicada.serviceConfig?.secretEnvironmentVariables || [];
      const secrets = contrato.segredos.map((key) => ({ secret: key, version: segredosRemotos.find((s) => s.key === key)?.version }));
      const hashEsperado = hashEndpoint(sourceHash, environmentVariables, secrets);
      const erros = verificarFuncao({ nome, publicada, esperada: { ...contrato, runtime: 'nodejs24' }, hashEsperado });
      let revisoes;
      if (publicada.serviceConfig?.service) {
        const servico = await get('run', 'v2', '/' + publicada.serviceConfig.service);
        erros.push(...verificarRevisaoAtiva(servico));
        revisoes = { criada: servico.latestCreatedRevision, pronta: servico.latestReadyRevision,
          trafego: servico.trafficStatuses?.map(({ type, revision, percent }) => ({ type, revision, percent })) };
      } else erros.push('SERVICO_AUSENTE');
      if (!contrato.documento && !args.includes('--sem-smoke')) {
        const urls = new Set([`https://${regiao}-${projeto}.cloudfunctions.net/${nome}`, publicada.serviceConfig?.uri]);
        for (const url of urls) {
          if (!url) continue;
          erros.push(...(await verificarAcesso(url, origem)).map((e) => new URL(url).hostname + ':' + e));
        }
      }
      resultados.push({ recurso: nome, estado: publicada.state, atualizadoEm: publicada.updateTime, revisoes, erros });
    } catch (erro) { resultados.push({ recurso: nome, erros: [erro.message?.match(/^CONSULTA_\d+$/)?.[0] || 'VERIFICACAO_INDISPONIVEL'] }); }
  }
  for (const [arquivo, release] of [['firestore.rules', 'cloud.firestore'], ['storage.rules', `firebase.storage/${bucket}`]]) {
    try {
      const versao = await get('firebaserules', 'v1', `/projects/${projeto}/releases/${release}`);
      const ruleset = await get('firebaserules', 'v1', `/${versao.rulesetName}`);
      const local = fs.readFileSync(path.join(raiz, arquivo));
      const igual = ruleset.source?.files?.some((f) => sha256(f.content) === sha256(local));
      resultados.push({ recurso: arquivo, erros: igual ? [] : ['REGRAS_DIFERENTES_DO_LOCAL'] });
    } catch { resultados.push({ recurso: arquivo, erros: ['VERIFICACAO_INDISPONIVEL'] }); }
  }
  // Compara o índice efetivamente servido, não apenas o upload de uma versão.
  try {
    const resposta = await fetch(origem + '/', { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20000) });
    const publicado = await resposta.text();
    const igual = resposta.status === 200 && sha256(publicado) === sha256(fs.readFileSync(path.join(raiz, 'dist/index.html')));
    resultados.push({ recurso: 'hosting:painel', erros: igual ? [] : ['PAINEL_DIFERENTE_DO_BUILD_LOCAL'] });
  } catch { resultados.push({ recurso: 'hosting:painel', erros: ['VERIFICACAO_INDISPONIVEL'] }); }
  const ok = resultados.every((r) => r.erros.length === 0);
  console.log(JSON.stringify({ projeto, instante: new Date().toISOString(), ok, sourceHash, smokeExecutado: !args.includes('--sem-smoke'), resultados }, null, 2));
  process.exitCode = ok ? 0 : 1;
}

if (require.main === module) main().catch((erro) => {
  const motivos = {
    ARGUMENTO_INVALIDO: 'Argumento inválido. Use apenas --sem-smoke ou nenhum argumento.',
    CLI_NAO_HOMOLOGADA: 'Versão da CLI diferente de 15.29.0. Revise o fingerprint antes de aprovar uma publicação.',
  };
  console.error(motivos[erro.message] || 'Não foi possível verificar a publicação. Confira a sessão da CLI e o acesso ao projeto.');
  process.exitCode = 1;
});
