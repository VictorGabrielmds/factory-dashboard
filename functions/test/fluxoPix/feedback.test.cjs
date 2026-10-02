const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const app = process.env.APP_CLIENTE_DIR || path.resolve(__dirname, '../../../../fabrica-app-cliente');
const { mensagemFalhaCheckout } = require(path.join(app, 'src/lib/checkoutFeedback.ts'));

test('offline orienta recuperar a tentativa sem afirmar que o pedido falhou', () => {
  const msg = mensagemFalhaCheckout({ code: 'functions/internal', message: 'internal' }, true);
  assert.match(msg, /sem conexão/); assert.match(msg, /recuperar esta tentativa/); assert.doesNotMatch(msg, /internal/);
});
test('timeout e falhas transitórias não vazam erro técnico nem sugerem outra compra', () => {
  for (const code of ['internal', 'unavailable', 'deadline-exceeded', 'unknown', 'resource-exhausted']) {
    const msg = mensagemFalhaCheckout({ code: `functions/${code}`, message: 'detalhe técnico privado' }, false);
    assert.match(msg, /mesma tentativa/); assert.doesNotMatch(msg, /detalhe técnico privado/);
  }
});
test('validação de negócio é preservada e erros desconhecidos são sanitizados', () => {
  assert.equal(mensagemFalhaCheckout({ code: 'functions/invalid-argument', message: 'Selecione um horário válido.' }, false), 'Selecione um horário válido.');
  assert.doesNotMatch(mensagemFalhaCheckout(new Error('stack privada'), false), /stack privada/);
  assert.match(mensagemFalhaCheckout({ code: 'functions/unauthenticated' }, false), /sessão expirou/);
});
