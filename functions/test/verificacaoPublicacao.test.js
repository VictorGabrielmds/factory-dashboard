const test = require('node:test');
const assert = require('node:assert/strict');
const { verificarFuncao, verificarAcesso, hashEndpoint, storagePodeConsultarStaff, verificarRevisaoAtiva } = require('../../scripts/lib/verificacao-publicacao.cjs');

const contrato = { nome: 'processarEventoMeta', hashEsperado: 'hash-testado',
  esperada: { runtime: 'nodejs24', segredos: ['TOKEN_META'], documento: 'eventos_meta/{eventoId}' } };
const publicada = () => ({ state: 'ACTIVE', buildConfig: { runtime: 'nodejs24', entryPoint: 'processarEventoMeta' },
  labels: { 'firebase-functions-hash': 'hash-testado' },
  serviceConfig: { secretEnvironmentVariables: [{ key: 'TOKEN_META' }] },
  eventTrigger: { eventType: 'google.cloud.firestore.document.v1.created', retryPolicy: 'RETRY_POLICY_RETRY',
    eventFilters: [{ attribute: 'document', value: 'eventos_meta/{eventoId}' }] } });

test('publicação: versão ativa pode estar antiga; fingerprint divergente falha', () => {
  const f = publicada();
  assert.deepEqual(verificarFuncao({ ...contrato, publicada: f }), []);
  f.labels['firebase-functions-hash'] = 'hash-antigo';
  assert.ok(verificarFuncao({ ...contrato, publicada: f }).includes('CODIGO_DIFERENTE_DO_LOCAL'));
});
test('publicação: runtime antigo impede aprovação da release', () => {
  const f = publicada();
  f.buildConfig.runtime = 'nodejs20';
  assert.ok(verificarFuncao({ ...contrato, publicada: f }).includes('RUNTIME_DIVERGENTE'));
});
test('publicação: recurso ausente, falho ou sem gatilho nunca aprova', () => {
  assert.deepEqual(verificarFuncao(contrato), ['FUNCAO_AUSENTE']);
  const f = publicada();
  f.state = 'FAILED';
  delete f.eventTrigger;
  assert.deepEqual(verificarFuncao({ ...contrato, publicada: f }), ['FUNCAO_NAO_ATIVA', 'GATILHO_DIVERGENTE', 'RETENTATIVA_AUSENTE']);
});
test('publicação: chave administrativa antiga vinculada é detectada', () => {
  const f = publicada();
  f.serviceConfig.secretEnvironmentVariables.push({ key: 'PANEL_API_KEY' });
  assert.ok(verificarFuncao({ ...contrato, publicada: f }).includes('CHAVE_COMPARTILHADA_AINDA_VINCULADA'));
});
test('publicação: fingerprint muda quando código, ambiente ou versão de segredo muda', () => {
  const hash = hashEndpoint('codigo', { GCLOUD_PROJECT: 'demo' }, [{ secret: 'TOKEN', version: '1' }]);
  assert.notEqual(hash, hashEndpoint('outro', { GCLOUD_PROJECT: 'demo' }, [{ secret: 'TOKEN', version: '1' }]));
  assert.notEqual(hash, hashEndpoint('codigo', { GCLOUD_PROJECT: 'outro' }, [{ secret: 'TOKEN', version: '1' }]));
  assert.notEqual(hash, hashEndpoint('codigo', { GCLOUD_PROJECT: 'demo' }, [{ secret: 'TOKEN', version: '2' }]));
});
function fakeFetch({ codigoErrado = false, cors = true } = {}) {
  return async (_url, req) => {
    assert.equal(req.redirect, 'error');
    const headers = cors ? { 'access-control-allow-origin': 'https://painel.test', 'access-control-allow-headers': 'content-type,authorization' } : {};
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    assert.equal(req.method, 'POST');
    assert.deepEqual(JSON.parse(req.body), { action: '__verificacao_publicacao_sem_efeito__' });
    assert.ok(!req.headers.Authorization || req.headers.Authorization === 'Bearer verificacao-invalida');
    const codigo = codigoErrado ? 'CHAVE_NECESSARIA' : req.headers.Authorization ? 'SESSAO_INVALIDA' : 'SESSAO_NECESSARIA';
    return Response.json({ codigo }, { status: 401, headers });
  };
}
test('publicação: smoke só envia uma ação inexistente sem credencial válida', async () => {
  assert.deepEqual(await verificarAcesso('https://api.test', 'https://painel.test', fakeFetch()), []);
});
test('publicação: HTTP 401 genérico não comprova autenticação nova; CORS também é obrigatório', async () => {
  assert.ok((await verificarAcesso('https://api.test', 'https://painel.test', fakeFetch({ codigoErrado: true }))).length > 0);
  assert.ok((await verificarAcesso('https://api.test', 'https://painel.test', fakeFetch({ cors: false }))).includes('PREFLIGHT_INVALIDO'));
});

test('publicação: Storage exige papel específico do agente, não de outro membro ou condicionado', () => {
  const membro = 'serviceAccount:storage-teste';
  const binding = { role: 'roles/firebaserules.firestoreServiceAgent', members: [membro] };
  assert.equal(storagePodeConsultarStaff({ bindings: [binding] }, membro), true);
  assert.equal(storagePodeConsultarStaff({ bindings: [binding] }, 'outra-pessoa'), false);
  assert.equal(storagePodeConsultarStaff({ bindings: [{ ...binding, condition: { expression: 'false' } }] }, membro), false);
});

test('publicação: label novo não basta quando revisão falhou ou tráfego ainda usa a antiga', () => {
  const s = { latestCreatedRevision: 'revisao-2', latestReadyRevision: 'revisao-2',
    terminalCondition: { state: 'CONDITION_SUCCEEDED' }, trafficStatuses: [{ revision: 'revisao-2', percent: 100 }] };
  assert.deepEqual(verificarRevisaoAtiva(s), []);
  assert.deepEqual(verificarRevisaoAtiva({ ...s, latestReadyRevision: 'revisao-1' }), ['REVISAO_NAO_PRONTA']);
  assert.deepEqual(verificarRevisaoAtiva({ ...s, reconciling: true }), ['REVISAO_NAO_PRONTA']);
  assert.deepEqual(verificarRevisaoAtiva({ ...s, trafficStatuses: [{ revision: 'revisao-1', percent: 100 }] }), ['TRAFEGO_EM_REVISAO_DIVERGENTE']);
  assert.deepEqual(verificarRevisaoAtiva({ ...s, trafficStatuses: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 100 }] }), []);
  assert.deepEqual(verificarRevisaoAtiva({ ...s, trafficStatuses: [{ percent: 100 }] }), ['TRAFEGO_EM_REVISAO_DIVERGENTE']);
  assert.deepEqual(verificarRevisaoAtiva({ ...s, latestReadyRevision: 'revisao-1',
    trafficStatuses: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 100 }] }), ['REVISAO_NAO_PRONTA']);
});
