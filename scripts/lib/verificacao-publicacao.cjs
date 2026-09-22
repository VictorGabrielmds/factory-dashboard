const crypto = require('node:crypto');

const sha1 = (valor) => crypto.createHash('sha1').update(valor).digest('hex');
const sha256 = (valor) => crypto.createHash('sha256').update(valor).digest('hex');

// Mesmo algoritmo de fingerprint da versão fixada da CLI Firebase (15.29.0).
// As versões dos segredos são metadados; os valores nunca são consultados.
function hashEndpoint(sourceHash, environmentVariables, secrets) {
  const versions = Object.fromEntries(secrets.map(({ secret, version }) => [secret, version || '']));
  return sha1(sourceHash + sha1(JSON.stringify(environmentVariables)) + sha1(JSON.stringify(versions)));
}

function verificarFuncao({ nome, publicada, esperada, hashEsperado }) {
  const erros = [];
  if (!publicada) return ['FUNCAO_AUSENTE'];
  if (publicada.state !== 'ACTIVE') erros.push('FUNCAO_NAO_ATIVA');
  if (publicada.buildConfig?.entryPoint !== nome) erros.push('ENTRYPOINT_DIVERGENTE');
  if (publicada.buildConfig?.runtime !== esperada.runtime) erros.push('RUNTIME_DIVERGENTE');
  if (hashEsperado && publicada.labels?.['firebase-functions-hash'] !== hashEsperado) {
    erros.push('CODIGO_DIFERENTE_DO_LOCAL');
  }
  const chaves = (publicada.serviceConfig?.secretEnvironmentVariables || []).map((s) => s.key).sort();
  if (JSON.stringify(chaves) !== JSON.stringify([...esperada.segredos].sort())) erros.push('SEGREDOS_DIVERGENTES');
  if (chaves.includes('PANEL_API_KEY') || Object.hasOwn(publicada.serviceConfig?.environmentVariables || {}, 'PANEL_API_KEY')) {
    erros.push('CHAVE_COMPARTILHADA_AINDA_VINCULADA');
  }
  if (esperada.documento) {
    const gatilho = publicada.eventTrigger;
    if (gatilho?.eventType !== 'google.cloud.firestore.document.v1.created' ||
        !gatilho.eventFilters?.some((f) => f.attribute === 'document' && f.value === esperada.documento)) {
      erros.push('GATILHO_DIVERGENTE');
    }
    if (gatilho?.retryPolicy !== 'RETRY_POLICY_RETRY') erros.push('RETENTATIVA_AUSENTE');
  }
  return erros;
}

async function verificarAcesso(url, origem, fetchImpl = fetch) {
  const erros = [];
  const opcoes = { redirect: 'error', signal: AbortSignal.timeout(20000) };
  const preflight = await fetchImpl(url, {
    ...opcoes, method: 'OPTIONS', headers: {
      Origin: origem, 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,authorization',
    },
  });
  if (preflight.status !== 204 || preflight.headers.get('access-control-allow-origin') !== origem ||
      !/authorization/i.test(preflight.headers.get('access-control-allow-headers') || '')) {
    erros.push('PREFLIGHT_INVALIDO');
  }
  await preflight.body?.cancel();
  for (const [authorization, codigo] of [[null, 'SESSAO_NECESSARIA'], ['Bearer verificacao-invalida', 'SESSAO_INVALIDA']]) {
    // Ação inexistente fixa: mesmo uma versão incorreta nunca recebe um comando de negócio.
    const resposta = await fetchImpl(url, {
      ...opcoes, signal: AbortSignal.timeout(20000), method: 'POST',
      headers: { Origin: origem, 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
      body: JSON.stringify({ action: '__verificacao_publicacao_sem_efeito__' }),
    });
    let corpo = {};
    if (resposta.headers.get('content-type')?.includes('application/json')) corpo = await resposta.json();
    else await resposta.body?.cancel();
    if (resposta.status !== 401 || corpo.codigo !== codigo) erros.push(codigo + '_NAO_COMPROVADA');
    if (resposta.headers.get('access-control-allow-origin') !== origem) erros.push('CORS_ERRO_INVALIDO');
  }
  return erros;
}

function storagePodeConsultarStaff(politica, principal) {
  return !!politica?.bindings?.some((b) => b.role === 'roles/firebaserules.firestoreServiceAgent' &&
    !b.condition && b.members?.includes(principal));
}

function verificarRevisaoAtiva(servico) {
  const pronta = servico?.latestReadyRevision;
  const trafego = servico?.trafficStatuses || [];
  if (!pronta || servico.latestCreatedRevision !== pronta || servico.reconciling ||
      servico.terminalCondition?.state !== 'CONDITION_SUCCEEDED') return ['REVISAO_NAO_PRONTA'];
  const apontaParaPronta = (t) => t.type === 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST' && !t.revision ||
    !!t.revision && t.revision.split('/').pop() === pronta.split('/').pop();
  if (!trafego.length || trafego.some((t) => t.percent > 0 && !apontaParaPronta(t)) ||
      trafego.reduce((n, t) => n + (t.percent || 0), 0) !== 100) return ['TRAFEGO_EM_REVISAO_DIVERGENTE'];
  return [];
}

module.exports = { sha1, sha256, hashEndpoint, verificarFuncao, verificarAcesso, storagePodeConsultarStaff, verificarRevisaoAtiva };
