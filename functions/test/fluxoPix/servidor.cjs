/* Harness local: handlers e transações reais; somente o transporte dos provedores
 * é substituído. Nunca carregar index.js (registraria efeitos fora do recorte). */
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const PROJECT = 'demo-fluxo-pix';
assert.equal(process.env.GCLOUD_PROJECT, PROJECT);
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8085');
assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:9098');
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
for (const name of ['ASAAS_API_KEY', 'ASAAS_API_KEY_ESCRITA', 'ASAAS_WEBHOOK_TOKEN', 'TOKEN_META']) {
  process.env[name] = 'somente-simulador-local';
}
const admin = require('firebase-admin');
admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();
const { http } = require('../../src/lib/http');
let mode = {};
let payments = [];
let customers = [];
let calls = [];
let notifications = 0;
let seq = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
function failure(status, message) {
  const error = new Error(message);
  if (status) error.response = { status, data: { errors: [{ description: message }] } };
  error.code = status ? 'ERR_BAD_RESPONSE' : 'ECONNRESET';
  return error;
}
// O adapter intercepta TODAS as chamadas axios antes de qualquer socket externo.
http.defaults.adapter = async config => {
  const url = new URL(config.url);
  const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
  const method = config.method.toUpperCase();
  const path = url.pathname.replace(/^\/v3/, '');
  calls.push({ method, path });
  let data;
  if (url.hostname === 'graph.facebook.com' && path.endsWith('/messages')) {
    notifications++;
    data = { messages: [{ id: `wamid.synthetic-${notifications}` }] };
  } else {
    assert.equal(url.hostname, 'api.asaas.com', 'Destino externo inesperado bloqueado');
    if (path === '/customers' && method === 'GET') {
      data = { data: customers.filter(c => c.cpfCnpj === config.params.cpfCnpj) };
    } else if (path === '/customers' && method === 'POST') {
      data = { ...body, id: `cus_synthetic_${++seq}` }; customers.push(data);
    } else if (path === '/payments' && method === 'GET') {
      data = { data: mode.hidePayments ? [] : payments.filter(p => p.externalReference === config.params.externalReference) };
    } else if (path === '/payments' && method === 'POST') {
      if (mode.rejectCreate) throw failure(mode.rejectCreate, 'Cobrança rejeitada pelo simulador');
      data = { ...body, id: `pay_synthetic_${++seq}`, status: 'PENDING', dateCreated: new Date().toISOString().slice(0, 10) };
      payments.push(data);
      if (mode.slowCreate) await sleep(mode.slowCreate);
      if (mode.lostProviderResponse) throw failure(null, 'Resposta da criação perdida após persistência no provedor');
    } else if (/\/payments\/[^/]+\/pixQrCode$/.test(path)) {
      if (mode.earlyPayment) await confirm(path.split('/')[2]);
      if (mode.failQr) throw failure(503, 'QR temporariamente indisponível');
      if (mode.slowQr) await sleep(mode.slowQr);
      data = { encodedImage: png, payload: 'PIX-SIMULADO-SEM-VALOR-BANCARIO', expirationDate: '2099-01-01 23:59:59' };
    } else if (/^\/payments\/[^/]+$/.test(path)) {
      data = payments.find(p => p.id === path.split('/')[2]);
      assert.ok(data, 'Pagamento sintético não encontrado');
    } else throw new Error(`Chamada inesperada bloqueada: ${method} ${path}`);
  }
  return { data, status: 200, statusText: 'OK', headers: {}, config };
};
// Rede fetch externa também é proibida; Admin SDK usa exclusivamente emuladores.
const nativeFetch = global.fetch;
global.fetch = (url, ...args) => {
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(String(url)).hostname), 'Fetch externo bloqueado');
  return nativeFetch(url, ...args);
};
const checkout = require('../../src/cliente/pedidos');
const asaas = require('../../src/webhooks/asaas');
const horario = require('../../src/services/horario');
const entregaApi = require('../../src/cliente/entrega');
const geral = require('../../src/services/pagamento');

async function drainEvents() {
  const snap = await db.collection('eventos_asaas').get();
  for (const doc of snap.docs) {
    if (!['concluido', 'requer_revisao'].includes(doc.data().estado)) {
      await asaas.processarEventoAsaas.run({ data: doc, params: { eventoId: doc.id } });
    }
  }
}
async function confirm(paymentId, repetitions = 1, status = 'RECEIVED', valueDelta = 0) {
  const payment = payments.find(p => p.id === paymentId);
  assert.ok(payment);
  payment.status = status;
  payment.value += valueDelta;
  if (status === 'REFUNDED') payment.refundedValue = payment.value;
  const event = { id: `evt_${paymentId}_${status}`, event: `PAYMENT_${status}`, payment: { ...payment } };
  const responses = [];
  for (let i = 0; i < repetitions; i++) {
    await asaas.webhookAsaas({ method: 'POST', headers: { 'asaas-access-token': process.env.ASAAS_WEBHOOK_TOKEN }, body: event }, {
      status(code) { this.code = code; return this; }, send(body) { responses.push({ code: this.code, body }); return this; },
    });
  }
  await drainEvents();
  return responses;
}
const tomorrow = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Fortaleza' }).format(new Date(Date.now() + 86400000));
async function seed() {
  await nativeFetch(`http://127.0.0.1:8085/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  payments = []; customers = []; calls = []; notifications = 0; mode = {};
  for (const uid of ['cliente-teste', 'outro-cliente', 'operador-teste']) {
    try { await admin.auth().getUser(uid); }
    catch { await admin.auth().createUser({ uid, email: `${uid}@fabrica.test`, password: 'Teste-local-123!' }); }
  }
  const days = Object.fromEntries(['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'].map(d => [d, {
    ativo: true, turnos: [{ abre: '00:00', fecha: '23:59', deliveryAtivo: true, retiradaAtivo: true }],
  }]));
  const fixtures = {
    'produtos/bolinha-teste': { nome: 'Bolinha de Queijo Teste', preco: 0.85, categoria: 'Salgados', disponivel: true, esgotado: false, imagemUrl: '', tempoPreparoMinutos: 0 },
    'produtos/agendamento_fritura': { nome: 'Agendar fritura', disponivel: false, preco: 0, itemSistema: true },
    'configuracoes/horario': { diasAntecedencia: 5, intervaloMinutos: 30, dias: days },
    'configuracoes/geral': { tempoPreparoPadraoMinutos: 0, valorMinimoEntrega: 0 },
    'configuracoes/entrega': { taxaPadrao: 5, tempoEntregaPadraoMinutos: 0 },
    'configuracoes/categorias': { ordem: ['Salgados'], descricoes: {} },
    'zonas_entrega/bairro teste': { bairro: 'Bairro Teste', ativo: true, taxa: 5, tempoEntregaMinutos: 0 },
    'zonas_entrega/bairro distante': { bairro: 'Bairro Distante', ativo: true, taxa: 9, tempoEntregaMinutos: 0 },
    'clientes/cliente-teste': { nome: 'Nome antigo salvo', telefone: '5598999990001', cpf: '11144477735', totalPedidos: 0 },
    'clientes/outro-cliente': { nome: 'Outro cliente', telefone: '5598999990002', cpf: '11144477735', totalPedidos: 0 },
    'staff/operador-teste': { ativo: true, papel: 'gestor' },
  };
  await Promise.all(Object.entries(fixtures).map(([path, value]) => db.doc(path).set(value)));
  return { tomorrow: tomorrow(), project: PROJECT };
}
async function state() {
  const names = ['pedidos', '_idempotency', 'eventos_asaas', 'pagamentos_asaas', 'pendencias'];
  const entries = await Promise.all(names.map(async name => [name, (await db.collection(name).get()).docs.map(d => ({ id: d.id, ...d.data() }))]));
  return { ...Object.fromEntries(entries), payments, calls, notifications, mode };
}
async function callable(name, request) {
  if (checkout[name]?.run) return checkout[name].run(request);
  if (name === 'consultarHorarioFuncionamento') return { horario: await horario.buscarHorarioFuncionamento() };
  if (name === 'consultarConfiguracoesGerais') return geral.buscarConfiguracaoGeral();
  if (name === 'consultarOrdemCategorias') return (await db.doc('configuracoes/categorias').get()).data();
  if (name === 'listarBairrosEntrega') return entregaApi.listarBairrosEntrega.run(request);
  if (name === 'consultarTaxaEntrega') {
    const delay = mode.slowDeliveryByBairro?.[request.data.bairro] ?? mode.slowDelivery;
    if (delay) await sleep(delay);
    if (mode.failDelivery) throw failure(503, 'Consulta de frete indisponível no simulador');
    return entregaApi.consultarTaxaEntrega.run(request);
  }
  throw new Error(`Callable não implementada no harness: ${name}`);
}
createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:5187');
  res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type,x-firebase-gmpid');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const finish = data => res.end(JSON.stringify(data));
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (req.url === '/test/seed') return finish(await seed());
    if (req.url === '/test/state') return finish(await state());
    if (req.url === '/test/mode') { mode = { ...mode, ...body }; return finish({ ok: true }); }
    if (req.url === '/test/confirm') return finish(await confirm(body.paymentId, body.repetitions, body.status, body.valueDelta));
    if (req.url === '/test/drain') { await drainEvents(); return finish(await state()); }
    if (req.url === '/test/patch') { assert.ok(['produtos', 'pedidos', '_idempotency'].includes(body.path.split('/')[0])); await db.doc(body.path).update(body.data); return finish({ ok: true }); }
    if (req.url === '/test/recover') {
      const snap = await db.collection('pedidos').get();
      for (const d of snap.docs) if (d.data().pix_checkout_pendente) await d.ref.update({ pix_checkout_proxima_tentativa_em: admin.firestore.Timestamp.fromMillis(0) });
      await checkout.reconciliarCheckoutsPix.run({}); return finish(await state());
    }
    if (req.url === '/test/reconcile') {
      for (const p of payments) p.status = 'RECEIVED';
      const snap = await db.collection('pedidos').get();
      for (const d of snap.docs) await d.ref.update({ pix_proxima_verificacao_em: admin.firestore.Timestamp.fromMillis(0) });
      await asaas.reconciliarPixAsaas.run({}); await drainEvents(); return finish(await state());
    }
    const name = req.url.split('/').pop();
    let auth;
    if (req.headers.authorization) {
      const token = await admin.auth().verifyIdToken(req.headers.authorization.replace(/^Bearer /, ''));
      auth = { uid: token.uid, token };
    }
    const result = await callable(name, { data: body.data, auth });
    if (name === 'criarPedido' && mode.dropCheckoutResponse) { req.socket.destroy(); return; }
    return finish({ result });
  } catch (error) {
    const status = error.httpErrorCode?.status || 500;
    res.statusCode = status;
    finish({ error: { status: error.httpErrorCode?.canonicalName || 'INTERNAL', message: error.message } });
  }
}).listen(5057, '127.0.0.1', () => console.log('Harness PIX isolado: http://127.0.0.1:5057'));
