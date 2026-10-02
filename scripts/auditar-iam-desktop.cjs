// Somente leitura. A autenticação vem da sessão da CLI, nunca da chave auditada.
// Do JSON local usamos apenas project_id/client_email/private_key_id em memória.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const raiz = path.resolve(__dirname, '..');
const cli = path.join(raiz, 'functions/node_modules/firebase-tools');
const projeto = 'entregas-781a8';
const chaveLocal = 'C:/Windows/entregas-781a8-firebase-adminsdk-ttnmu-43e1dbeb7b.json';
let etapa = 'metadados-locais';

async function main() {
  const { project_id, client_email, private_key_id } = JSON.parse(fs.readFileSync(chaveLocal, 'utf8').replace(/^\uFEFF/, ''));
  if (project_id !== projeto || !/^[a-z0-9-]+@entregas-781a8\.iam\.gserviceaccount\.com$/.test(client_email) ||
      !/^[a-f0-9]{40}$/.test(private_key_id)) throw new Error('METADADOS_INVALIDOS');
  const { logger } = require(cli + '/lib/logger');
  etapa = 'sessao-cli';
  logger.silent = true;
  logger.clear();
  const { Command } = require(cli + '/lib/command');
  const { requireAuth } = require(cli + '/lib/requireAuth');
  const { Client } = require(cli + '/lib/apiv2');
  const opts = { project: projeto, nonInteractive: true, debug: false, cwd: raiz };
  await new Command('auditar-iam-desktop').prepare(opts);
  await requireAuth(opts);
  const opcoes = { retries: 0, timeout: 30000, resolveOnHTTPError: true,
    skipLog: { body: true, resBody: true, queryParams: true } };
  async function get(host, version, endpoint, queryParams = {}) {
    etapa = host + (endpoint.endsWith('/keys') ? ':chaves' : endpoint.startsWith('/roles/') ? ':papel' : ':recurso');
    const r = await new Client({ urlPrefix: `https://${host}.googleapis.com`, apiVersion: version })
      .get(endpoint, { ...opcoes, queryParams });
    if (r.status !== 200) throw new Error(`CONSULTA_${r.status}`);
    return r.body;
  }
  const nomeConta = `/projects/${projeto}/serviceAccounts/${client_email}`;
  const conta = await get('iam', 'v1', nomeConta);
  const chaves = await get('iam', 'v1', nomeConta + '/keys', { keyTypes: 'USER_MANAGED' });
  const chave = chaves.keys?.find((k) => k.name.split('/').pop() === private_key_id);
  const politica = await new Client({ urlPrefix: 'https://cloudresourcemanager.googleapis.com', apiVersion: 'v1' })
    .post(`/projects/${projeto}:getIamPolicy`, { options: { requestedPolicyVersion: 3 } }, { ...opcoes });
  if (politica.status !== 200) throw new Error('IAM_INDISPONIVEL');
  const papeis = [];
  for (const binding of politica.body.bindings || []) {
    if (!binding.members?.includes(`serviceAccount:${client_email}`)) continue;
    let papel;
    try { papel = await get('iam', 'v1', '/' + binding.role); }
    catch (erro) {
      papeis.push({ papel: binding.role, condicional: !!binding.condition, permissoesConsultadas: false,
        motivo: Number.isInteger(erro.status) ? `HTTP_${erro.status}` : 'CONSULTA_INDISPONIVEL' });
      continue;
    }
    papeis.push({ papel: binding.role, condicional: !!binding.condition, permissoesConsultadas: true,
      quantidadePermissoes: papel.includedPermissions?.length || 0,
      permissoesSensiveis: (papel.includedPermissions || []).filter((p) =>
        /^(datastore\.entities\.|firebaseauth\.users\.|iam\.serviceAccounts\.(signBlob|signJwt|getAccessToken)|storage\.objects\.(get|list|create|delete|update))/.test(p)) });
  }
  async function listar(host, version, endpoint, campo) {
    const itens = [];
    let pageToken;
    do {
      const pagina = await get(host, version, endpoint, { pageSize: 100, ...(pageToken ? { pageToken } : {}) });
      if (pagina.unreachable?.length) throw new Error('INVENTARIO_INCOMPLETO');
      itens.push(...pagina[campo] || []);
      pageToken = pagina.nextPageToken;
      if (itens.length > 1000) throw new Error('INVENTARIO_ACIMA_LIMITE');
    } while (pageToken);
    return itens;
  }
  async function consumidores(host, version, endpoint, campo, email) {
    try {
      const itens = await listar(host, version, endpoint, campo);
      const corresponde = (valor) => String(valor || '').replace(/^serviceAccount:/, '') === client_email;
      return { consultado: true, recursos: itens.filter((i) => corresponde(email(i))).map((i) => i.name.split('/').pop()) };
    } catch (erro) {
      const status = String(erro?.message || '').match(/^CONSULTA_(\d{3})$/)?.[1];
      return { consultado: false, codigo: status ? `HTTP_${status}` : 'CONSULTA_INDISPONIVEL' };
    }
  }
  async function consumidoresCompute() {
    try {
      const recursos = [];
      let pageToken;
      do {
        const pagina = await get('compute', 'v1', `/projects/${projeto}/aggregated/instances`, {
          maxResults: 100, ...(pageToken ? { pageToken } : {}),
        });
        if (pagina.unreachable?.length) throw new Error('INVENTARIO_INCOMPLETO');
        for (const zona of Object.values(pagina.items || {})) {
          for (const instancia of zona.instances || []) {
            if (instancia.serviceAccounts?.some((conta) => conta.email === client_email)) recursos.push(instancia.name);
          }
        }
        pageToken = pagina.nextPageToken;
        if (recursos.length > 1000) throw new Error('INVENTARIO_ACIMA_LIMITE');
      } while (pageToken);
      return { consultado: true, recursos };
    } catch (erro) {
      const status = String(erro?.message || '').match(/^CONSULTA_(\d{3})$/)?.[1];
      return { consultado: false, codigo: status ? `HTTP_${status}` : 'CONSULTA_INDISPONIVEL' };
    }
  }
  const funcoesV2 = await consumidores('cloudfunctions', 'v2', `/projects/${projeto}/locations/-/functions`, 'functions', (f) => f.serviceConfig?.serviceAccountEmail);
  const funcoesV1 = await consumidores('cloudfunctions', 'v1', `/projects/${projeto}/locations/-/functions`, 'functions', (f) => f.serviceAccountEmail);
  const servicosCloudRun = await consumidores('run', 'v2', `/projects/${projeto}/locations/-/services`, 'services', (s) => s.template?.serviceAccount);
  const jobsCloudRun = await consumidores('run', 'v2', `/projects/${projeto}/locations/-/jobs`, 'jobs', (j) => j.template?.template?.serviceAccount);
  const scheduler = await consumidores('cloudscheduler', 'v1', `/projects/${projeto}/locations/-/jobs`, 'jobs', (j) => j.httpTarget?.oidcToken?.serviceAccountEmail);
  const pubsub = await consumidores('pubsub', 'v1', `/projects/${projeto}/subscriptions`, 'subscriptions', (s) => s.pushConfig?.oidcToken?.serviceAccountEmail);
  const workflows = await consumidores('workflows', 'v1', `/projects/${projeto}/locations/-/workflows`, 'workflows', (w) => w.serviceAccount);
  const cloudBuild = await consumidores('cloudbuild', 'v1', `/projects/${projeto}/triggers`, 'triggers', (t) => t.serviceAccount);
  const compute = await consumidoresCompute();
  console.log(JSON.stringify({ projeto, instante: new Date().toISOString(), conta: client_email,
    contaDesativada: conta.disabled === true,
    chaveLocal: { identificadorReduzido: crypto.createHash('sha256').update(private_key_id).digest('hex').slice(0, 12),
      encontrada: !!chave, desativada: chave ? chave.disabled === true : null,
      validaAte: chave?.validBeforeTime || null },
    papeisDiretosProjeto: papeis,
    consumidoresComMesmaIdentidade: {
      funcoesV2,
      funcoesV1,
      cloudRunServicosTodasAsRegioes: servicosCloudRun,
      cloudRunJobsTodasAsRegioes: jobsCloudRun,
      schedulerOidc: scheduler,
      pubsubPushOidc: pubsub,
      workflows,
      cloudBuildTriggers: cloudBuild,
      computeEngine: compute,
    },
    limites: 'Identidade do arquivo local confirmado; arquivo instalado na loja não comparado. Consumidores listados usam a conta, não necessariamente esta chave. Não inclui credenciais embutidas, outros PCs/projetos, herança IAM, grupos, deny policies, recursos não listáveis pela sessão ou permissões por recurso. Nenhuma revogação autorizada por este relatório.',
  }, null, 2));
}
main().catch((erro) => {
  console.error(JSON.stringify({ auditoria: 'indisponivel', etapa, codigo: /^CONSULTA_\d+$|^METADADOS_INVALIDOS$|^IAM_INDISPONIVEL$/.test(erro.message) ? erro.message : 'FALHA_SEGURA',
    http: String(erro.message || '').match(/HTTP Error:\s*(\d{3})/)?.[1] || null,
  }));
  process.exitCode = 1;
});
