// Migração P0 de IAM: somente o agente gerenciado do Storage recebe o papel
// específico de leitura por regras. Não concede acesso a usuários/visitantes.
const path = require('node:path');
const { storagePodeConsultarStaff } = require('./lib/verificacao-publicacao.cjs');
const raiz = path.resolve(__dirname, '..');
const cli = path.join(raiz, 'functions/node_modules/firebase-tools');
const projeto = 'entregas-781a8';

async function main() {
  const { logger } = require(cli + '/lib/logger');
  logger.silent = true;
  logger.clear();
  const { Command } = require(cli + '/lib/command');
  const { requireAuth } = require(cli + '/lib/requireAuth');
  const { getProjectNumber } = require(cli + '/lib/getProjectNumber');
  const { Client } = require(cli + '/lib/apiv2');
  const opts = { project: projeto, cwd: raiz, nonInteractive: true, debug: false };
  await new Command('configurar-storage-staff').prepare(opts);
  await requireAuth(opts);
  const numero = await getProjectNumber(opts);
  if (!/^\d+$/.test(numero)) throw new Error('PROJETO_INVALIDO');
  const principal = `serviceAccount:service-${numero}@gcp-sa-firebasestorage.iam.gserviceaccount.com`;
  const cliente = new Client({ urlPrefix: 'https://cloudresourcemanager.googleapis.com', apiVersion: 'v1' });
  const opcoes = { retries: 0, timeout: 30000, resolveOnHTTPError: true,
    skipLog: { body: true, resBody: true, queryParams: true } };
  const resposta = await cliente.post(`/projects/${projeto}:getIamPolicy`,
    { options: { requestedPolicyVersion: 3 } }, opcoes);
  const politica = resposta.body;
  if (resposta.status !== 200 || !politica?.etag || !Array.isArray(politica.bindings)) throw new Error('IAM_INDISPONIVEL');
  if (storagePodeConsultarStaff(politica, principal)) {
    console.log('Permissão específica do Storage já configurada; nenhuma alteração.');
    return;
  }
  const papel = 'roles/firebaserules.firestoreServiceAgent';
  let binding = politica.bindings.find((b) => b.role === papel && !b.condition);
  if (!binding) { binding = { role: papel, members: [] }; politica.bindings.push(binding); }
  binding.members.push(principal);
  // Etag preservado impede sobrescrever uma alteração concorrente na política.
  const alteracao = await cliente.post(`/projects/${projeto}:setIamPolicy`,
    { policy: politica, updateMask: 'bindings,etag' }, opcoes);
  if (alteracao.status !== 200 || !storagePodeConsultarStaff(alteracao.body, principal)) throw new Error('IAM_NAO_CONFIRMADO');
  console.log('Papel específico de leitura por regras concedido somente ao agente gerenciado do Storage.');
}

main().catch(() => {
  console.error('Não foi possível confirmar a configuração de IAM do Storage. Execute a verificação antes de repetir.');
  process.exitCode = 1;
});
