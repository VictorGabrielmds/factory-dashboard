const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const BASE = 'http://127.0.0.1:5187';
const HARNESS = 'http://127.0.0.1:5057';
const results = [];
const evidence = [];
const contexts = new Set();

async function post(path, body = {}) {
  const response = await fetch(`${HARNESS}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.ok(response.ok, `${path}: HTTP ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
const state = () => post('/test/state');

async function createPage(browser, path = '/') {
  const context = await browser.newContext({ locale: 'pt-BR', timezoneId: 'America/Fortaleza', viewport: path === '/dashboard' ? { width: 1366, height: 900 } : { width: 390, height: 844 } });
  contexts.add(context);
  context.on('close', () => contexts.delete(context));
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return ['127.0.0.1', 'localhost'].includes(url.hostname) || ['data:', 'blob:'].includes(url.protocol)
      ? route.continue() : route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.trim().length > 0);
  return { context, page, pageErrors };
}

async function toSummary(page) {
  await page.getByRole('button', { name: /Adicionar Bolinha de Queijo Teste/ }).click();
  await page.getByRole('link', { name: 'Ir para o carrinho' }).click();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByRole('heading', { name: 'Resumo do pedido' }).waitFor();
}

async function fillPix(page, name = 'Nome digitado no checkout') {
  const value = await page.locator('select option').evaluateAll(options => {
    const option = options.find(o => o.textContent?.startsWith('Amanhã'));
    return option?.value;
  });
  assert.ok(value, 'Nenhum horário de amanhã foi exibido');
  await page.locator('select').selectOption(value);
  await page.getByRole('textbox', { name: 'Seu nome' }).fill(name);
  await page.getByRole('textbox', { name: /CPF ou CNPJ/ }).fill('11144477735');
  await page.getByRole('button', { name: /^PIX / }).click();
}

async function confirmOrder(page, duplicateClick = false) {
  await page.getByRole('button', { name: /Finalizar —/ }).click();
  const confirm = page.getByRole('button', { name: 'Confirmar pedido', exact: true });
  await confirm.waitFor();
  if (duplicateClick) await confirm.evaluate(button => { button.click(); button.click(); });
  else await confirm.click();
}

async function waitOrder(page, timeout = 30000) {
  await page.waitForURL(/\/pedido\/\d+$/, { timeout });
  await page.getByRole('heading', { name: 'Pague com PIX' }).waitFor({ timeout });
  return page.url().split('/').pop();
}

async function scenario(name, fn) {
  if (process.env.E2E_ONLY && !name.toLowerCase().includes(process.env.E2E_ONLY.toLowerCase())) return;
  try { await fn(); results.push({ name, ok: true }); console.log(`OK  ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.stack || String(error) }); console.error(`FALHA  ${name}\n${error.stack || error}`); }
  finally { await Promise.all([...contexts].map(context => context.close())); }
}

function payload(date, overrides = {}) {
  return { idempotencyKey: require('node:crypto').randomUUID(), itens: [{ produtoId: 'bolinha-teste', quantidade: 1 }],
    formaPagamento: 'pix', nome: 'Cliente teste concorrente', cpf: '11144477735', tipoEntrega: 'retirada',
    endereco: null, agendamento: { data: date, hora: '12:00' }, observacoes: '', cupomCodigo: null, ...overrides };
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });

  await scenario('uso incorreto, clique duplo, PIX e atualização ao vivo no dashboard', async () => {
    await post('/test/seed');
    const client = await createPage(browser);
    await toSummary(client.page);
    await client.page.getByRole('button', { name: /Finalizar —/ }).click();
    assert.equal((await state()).pedidos.length, 0, 'Formulário incompleto criou pedido');
    await fillPix(client.page);
    await confirmOrder(client.page, true);
    const orderId = await waitOrder(client.page);
    let s = await state();
    assert.equal(s.pedidos.length, 1);
    assert.equal(s.payments.length, 1);
    assert.equal(s.calls.filter(c => c.method === 'POST' && c.path === '/payments').length, 1);
    assert.equal(s.pedidos[0].nome_destinatario, 'Nome digitado no checkout');
    assert.equal(s.pedidos[0].status, 1);
    assert.equal(s.pedidos[0].pix_confirmado, false);

    const operator = await createPage(browser, '/dashboard');
    await operator.page.getByRole('region', { name: 'Pedidos aguardando confirmação do PIX', exact: true }).getByText(`Pedido #${orderId}`, { exact: false }).waitFor({ timeout: 15000 });
    assert.match(await operator.page.locator('body').innerText(), /Aguardando PIX/);
    await post('/test/confirm', { paymentId: s.payments[0].id, repetitions: 5 });
    await client.page.getByRole('heading', { name: 'Status do pedido' }).waitFor({ timeout: 15000 });
    await operator.page.getByRole('region', { name: 'Aguardando pedidos', exact: true }).getByText(`Pedido #${orderId}`, { exact: false }).waitFor();
    assert.equal(await operator.page.getByRole('region', { name: 'Pedidos aguardando confirmação do PIX', exact: true }).count(), 0);
    s = await state();
    assert.equal(s.pedidos[0].status, 2);
    assert.equal(s.pedidos[0].pix_status, 'RECEIVED');
    assert.equal(s.pagamentos_asaas.length, 1);
    assert.equal(s.eventos_asaas.length, 1, 'Webhook duplicado não foi deduplicado');
    assert.equal(s.notifications, 1, 'Confirmação duplicada gerou mensagem duplicada');
    assert.deepEqual(client.pageErrors, []);
    assert.deepEqual(operator.pageErrors, []);
    await operator.page.screenshot({ path: 'functions/test/fluxoPix/artifacts/dashboard-pix-confirmado.png', fullPage: true });
    evidence.push({ scenario: 'clique duplo e confirmação no dashboard', orderId, paymentId: s.payments[0].id });
    await client.context.close(); await operator.context.close();
  });

  await scenario('sem internet antes do envio e retomada pelo mesmo carrinho', async () => {
    await post('/test/seed');
    const client = await createPage(browser);
    await toSummary(client.page); await fillPix(client.page, 'Cliente offline');
    await client.page.getByRole('button', { name: /Finalizar —/ }).click();
    const confirm = client.page.getByRole('button', { name: 'Confirmar pedido', exact: true });
    await confirm.waitFor();
    await client.context.setOffline(true);
    await confirm.click();
    const erroOffline = client.page.locator('p.text-red-600');
    await erroOffline.waitFor({ timeout: 15000 });
    assert.ok((await erroOffline.innerText()).trim(), 'Falha de rede não exibiu motivo ao cliente');
    assert.match(await erroOffline.innerText(), /sem conexão.*recuperar esta tentativa/);
    assert.doesNotMatch(await erroOffline.innerText(), /internal/);
    evidence.push({ scenario: 'sem internet', mensagemExibida: await erroOffline.innerText() });
    assert.equal((await state()).pedidos.length, 0);
    await client.context.setOffline(false);
    await confirmOrder(client.page);
    await waitOrder(client.page);
    const s = await state();
    assert.equal(s.pedidos.length, 1); assert.equal(s.payments.length, 1);
    await client.context.close();
  });

  await scenario('resposta perdida depois do commit e recuperação após recarregar', async () => {
    await post('/test/seed'); await post('/test/mode', { dropCheckoutResponse: true });
    const client = await createPage(browser);
    await toSummary(client.page); await fillPix(client.page, 'Cliente resposta perdida');
    await confirmOrder(client.page);
    const erroResposta = client.page.locator('p.text-red-600');
    await erroResposta.waitFor({ timeout: 20000 });
    assert.ok((await erroResposta.innerText()).trim(), 'Resposta perdida não exibiu motivo ao cliente');
    assert.match(await erroResposta.innerText(), /mesma tentativa/);
    assert.doesNotMatch(await erroResposta.innerText(), /internal/);
    let s = await state();
    assert.equal(s.pedidos.length, 1); assert.equal(s.payments.length, 1);
    assert.equal(s.calls.filter(c => c.method === 'POST' && c.path === '/payments').length, 1);
    await post('/test/mode', { dropCheckoutResponse: false });
    await client.page.reload({ waitUntil: 'domcontentloaded' });
    await client.page.getByRole('button', { name: 'Continuar' }).click();
    await client.page.getByRole('button', { name: 'Continuar' }).click();
    await client.page.getByRole('heading', { name: 'Resumo do pedido' }).waitFor();
    await fillPix(client.page, 'Cliente resposta perdida');
    await confirmOrder(client.page);
    await waitOrder(client.page);
    s = await state();
    assert.equal(s.pedidos.length, 1); assert.equal(s.payments.length, 1);
    await client.context.close();
  });

  await scenario('Asaas lento mantém feedback e não duplica a cobrança', async () => {
    await post('/test/seed'); await post('/test/mode', { slowCreate: 2500, slowQr: 1500 });
    const client = await createPage(browser);
    await toSummary(client.page); await fillPix(client.page, 'Cliente rede lenta');
    await client.page.getByRole('button', { name: /Finalizar —/ }).click();
    const confirm = client.page.getByRole('button', { name: 'Confirmar pedido', exact: true });
    await confirm.evaluate(button => { button.click(); button.click(); });
    await client.page.getByRole('button', { name: 'Finalizando...' }).waitFor();
    await waitOrder(client.page, 35000);
    const s = await state();
    assert.equal(s.pedidos.length, 1); assert.equal(s.payments.length, 1);
    assert.equal(s.calls.filter(c => c.method === 'POST' && c.path === '/payments').length, 1);
    await client.context.close();
  });

  await scenario('pagamento chega antes do QR e não volta para pendente', async () => {
    await post('/test/seed'); await post('/test/mode', { earlyPayment: true });
    const client = await createPage(browser);
    await toSummary(client.page); await fillPix(client.page, 'Cliente corrida webhook');
    await confirmOrder(client.page); await client.page.waitForURL(/\/pedido\/\d+$/);
    await post('/test/drain');
    await client.page.getByRole('heading', { name: 'Status do pedido' }).waitFor({ timeout: 15000 });
    const s = await state();
    assert.equal(s.pedidos.length, 1); assert.equal(s.payments.length, 1);
    assert.equal(s.pedidos[0].status, 2); assert.equal(s.pedidos[0].pix_status, 'RECEIVED');
    assert.equal(s.pedidos[0].pix_confirmado, true);
    await client.context.close();
  });

  await scenario('webhook perdido é recuperado pela conciliação', async () => {
    await post('/test/seed');
    const client = await createPage(browser);
    await toSummary(client.page); await fillPix(client.page, 'Cliente conciliacao');
    await confirmOrder(client.page); await waitOrder(client.page);
    let s = await state(); assert.equal(s.pedidos[0].status, 1);
    s = await post('/test/reconcile');
    assert.equal(s.pedidos[0].status, 2); assert.equal(s.pedidos[0].pix_confirmado, true);
    await client.context.close();
  });

  await scenario('payload adulterado é recusado sem pedido ou cobrança', async () => {
    const fixture = await post('/test/seed');
    const client = await createPage(browser);
    const attempt = await client.page.evaluate(async data => {
      try {
        await window.__test.call('criarPedido', data);
        return 'aceito';
      } catch (error) { return error.code || error.message; }
    }, payload(fixture.tomorrow, { itens: [{ produtoId: 'bolinha-teste', quantidade: 101 }] }));
    assert.notEqual(attempt, 'aceito');
    const s = await state(); assert.equal(s.pedidos.length, 0); assert.equal(s.payments.length, 0);
    await client.context.close();
  });

  await scenario('delivery valida endereço e inclui frete no PIX e dashboard', async () => {
    await post('/test/seed');
    const client = await createPage(browser);
    await client.page.getByRole('button', { name: /Adicionar Bolinha/ }).click();
    await client.page.getByRole('link', { name: 'Ir para o carrinho' }).click();
    await client.page.getByRole('button', { name: 'Continuar' }).click();
    await client.page.getByRole('button', { name: /Delivery Receber/ }).click();
    await client.page.getByRole('button', { name: 'Continuar' }).click();
    await client.page.getByText('Informe a rua.', { exact: true }).waitFor();
    assert.equal((await state()).pedidos.length, 0);
    await client.page.getByLabel('Rua', { exact: true }).fill('Rua Sintética');
    await client.page.getByLabel('Número', { exact: true }).fill('10');
    await client.page.getByLabel('Bairro', { exact: true }).fill('Bairro Teste');
    await client.page.getByRole('button', { name: 'Continuar' }).click();
    await fillPix(client.page, 'Cliente delivery');
    await client.page.getByRole('button', { name: /Finalizar —.*5,85/ }).waitFor();
    assert.equal(await client.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Checkout tem overflow horizontal no celular');
    await client.page.screenshot({ path: 'functions/test/fluxoPix/artifacts/checkout-delivery-mobile.png', fullPage: true });
    await confirmOrder(client.page); const orderId = await waitOrder(client.page);
    const s = await state();
    assert.equal(s.pedidos[0].valor_taxa, 5); assert.equal(s.pedidos[0].valor_venda, 5.85);
    assert.equal(s.payments[0].value, 5.85);
    const operator = await createPage(browser, '/dashboard');
    await operator.page.getByRole('region', { name: 'Pedidos aguardando confirmação do PIX', exact: true }).getByText(`Pedido #${orderId}`, { exact: false }).waitFor();
    await post('/test/confirm', { paymentId: s.payments[0].id });
    await operator.page.getByRole('region', { name: 'Aguardando pedidos', exact: true }).getByText(`Pedido #${orderId}`, { exact: false }).waitFor();
    assert.deepEqual(client.pageErrors, []);
  });

  await scenario('cliente desconectado durante o pagamento atualiza ao reconectar', async () => {
    await post('/test/seed'); const client = await createPage(browser);
    await toSummary(client.page); await fillPix(client.page); await confirmOrder(client.page); await waitOrder(client.page);
    await client.context.setOffline(true);
    await post('/test/confirm', { paymentId: (await state()).payments[0].id });
    assert.equal((await state()).pedidos[0].pix_confirmado, true);
    await client.context.setOffline(false);
    await client.page.getByRole('heading', { name: 'Status do pedido' }).waitFor({ timeout: 30000 });
  });

  await scenario('valor divergente não confirma pedido nem libera expedição', async () => {
    await post('/test/seed'); const client = await createPage(browser);
    await toSummary(client.page); await fillPix(client.page); await confirmOrder(client.page); await waitOrder(client.page);
    await post('/test/confirm', { paymentId: (await state()).payments[0].id, valueDelta: 10 });
    const s = await state();
    assert.equal(s.pedidos[0].pix_confirmado, false); assert.equal(s.pedidos[0].status, 1);
    assert.ok(s.pendencias.length > 0, 'Divergência não gerou pendência');
  });

  await scenario('resposta do Asaas perdida não cria segunda cobrança', async () => {
    await post('/test/seed'); await post('/test/mode', { lostProviderResponse: true });
    const client = await createPage(browser);
    await toSummary(client.page); await fillPix(client.page); await confirmOrder(client.page); await waitOrder(client.page);
    const s = await state();
    assert.equal(s.pedidos.length, 1); assert.equal(s.payments.length, 1);
    assert.equal(s.calls.filter(c => c.method === 'POST' && c.path === '/payments').length, 1);
  });

  await scenario('50 chamadas simultâneas da mesma tentativa geram um único pedido e PIX', async () => {
    const fixture = await post('/test/seed'); const client = await createPage(browser);
    const data = payload(fixture.tomorrow);
    const responses = await client.page.evaluate(async data => Promise.all(Array.from({ length: 50 }, async () => {
      try { return { ok: true, result: await window.__test.call('criarPedido', data) }; }
      catch (error) { return { ok: false, code: error.code }; }
    })), data);
    assert.ok(responses.some(r => r.ok), 'Nenhuma tentativa recebeu o pedido');
    const s = await state();
    assert.equal(s.pedidos.length, 1); assert.equal(s.payments.length, 1);
    assert.equal(s.calls.filter(c => c.method === 'POST' && c.path === '/payments').length, 1);
    evidence.push({ scenario: '50 chamadas simultâneas', respostas: responses.reduce((acc, r) => { const key = r.ok ? 'sucesso' : r.code; acc[key] = (acc[key] || 0) + 1; return acc; }, {}) });
  });

  await scenario('frete ainda não calculado deve impedir confirmação com total incompleto', async () => {
    await post('/test/seed'); await post('/test/mode', { slowDelivery: 4500 });
    const client = await createPage(browser);
    await toSummary(client.page); await fillPix(client.page, 'Cliente frete lento');
    // Dados pessoais e pagamento já preenchidos; cliente volta e troca retirada por delivery.
    await client.page.getByRole('button', { name: 'Voltar', exact: true }).click();
    await client.page.getByRole('button', { name: /Delivery Receber/ }).click();
    await client.page.getByLabel('Rua', { exact: true }).fill('Rua Sintética');
    await client.page.getByLabel('Número', { exact: true }).fill('10');
    await client.page.getByLabel('Bairro', { exact: true }).fill('Bairro Teste');
    await client.page.getByRole('button', { name: 'Continuar' }).click();
    await fillPix(client.page, 'Cliente frete lento');
    const pendingButton = client.page.getByRole('button', { name: 'Calculando frete...' });
    await pendingButton.waitFor();
    assert.equal(await pendingButton.isDisabled(), true);
    await pendingButton.evaluate(button => button.click());
    const modal = client.page.getByRole('heading', { name: 'Confirmar pedido', exact: true });
    const abriu = await modal.isVisible();
    assert.equal(abriu, false, 'Modal permite confirmar antes do cálculo do frete; total apresentado pode diferir do PIX');
    assert.equal(await client.page.evaluate(() => window.__test.finalizar()), null, 'Função de finalização deveria bloquear frete pendente');
    assert.equal((await state()).pedidos.length, 0);
    await client.page.screenshot({ path: 'functions/test/fluxoPix/artifacts/frete-pendente-corrigido.png', fullPage: true });
    await client.page.getByRole('button', { name: /Finalizar —.*5,85/ }).waitFor();
    await confirmOrder(client.page); await waitOrder(client.page);
    const s = await state();
    assert.equal(s.pedidos[0].valor_venda, 5.85); assert.equal(s.payments[0].value, 5.85);
    evidence.push({ scenario: 'frete pendente', modalAbertoAntesDoCalculo: abriu, valorPedido: s.pedidos[0].valor_venda, valorPix: s.payments[0].value });
  });

  await scenario('frete indisponível bloqueia envio e permite recalcular', async () => {
    await post('/test/seed'); await post('/test/mode', { failDelivery: true });
    const client = await createPage(browser);
    await toSummary(client.page); await fillPix(client.page);
    await client.page.getByRole('button', { name: 'Voltar', exact: true }).click();
    await client.page.getByRole('button', { name: /Delivery Receber/ }).click();
    await client.page.getByLabel('Rua', { exact: true }).fill('Rua Sintética');
    await client.page.getByLabel('Número', { exact: true }).fill('10');
    await client.page.getByLabel('Bairro', { exact: true }).fill('Bairro Teste');
    await client.page.getByRole('button', { name: 'Continuar' }).click();
    await fillPix(client.page);
    const retry = client.page.getByRole('button', { name: 'Calcular frete novamente' });
    await retry.waitFor();
    assert.equal(await client.page.getByRole('button', { name: 'Frete indisponível' }).isDisabled(), true);
    assert.equal(await client.page.evaluate(() => window.__test.finalizar()), null);
    assert.equal((await state()).pedidos.length, 0);
    await post('/test/mode', { failDelivery: false }); await retry.click();
    await client.page.getByRole('button', { name: /Finalizar —.*5,85/ }).waitFor();
    await confirmOrder(client.page); await waitOrder(client.page);
    assert.equal((await state()).payments[0].value, 5.85);
  });

  await scenario('resposta atrasada de bairro anterior não substitui frete atual', async () => {
    await post('/test/seed'); await post('/test/mode', { slowDeliveryByBairro: { 'Bairro Teste': 4000 } });
    const client = await createPage(browser);
    await toSummary(client.page); await fillPix(client.page);
    await client.page.getByRole('button', { name: 'Voltar', exact: true }).click();
    await client.page.getByRole('button', { name: /Delivery Receber/ }).click();
    await client.page.getByLabel('Rua', { exact: true }).fill('Rua Sintética');
    await client.page.getByLabel('Número', { exact: true }).fill('10');
    const pending = client.page.waitForRequest(r => r.url().endsWith('/consultarTaxaEntrega') && r.postDataJSON()?.data?.bairro === 'Bairro Teste');
    const oldResponse = client.page.waitForResponse(r => r.url().endsWith('/consultarTaxaEntrega') && r.request().postDataJSON()?.data?.bairro === 'Bairro Teste');
    await client.page.getByLabel('Bairro', { exact: true }).fill('Bairro Teste'); await pending;
    await client.page.getByLabel('Bairro', { exact: true }).fill('Bairro Distante');
    await client.page.getByRole('button', { name: 'Continuar' }).click();
    await fillPix(client.page);
    await client.page.getByRole('button', { name: /Finalizar —.*9,85/ }).waitFor();
    await oldResponse;
    await client.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await client.page.getByRole('button', { name: /Finalizar —.*9,85/ }).count(), 1);
    await confirmOrder(client.page); await waitOrder(client.page);
    assert.equal((await state()).payments[0].value, 9.85);
  });

  await browser.close();
  const failed = results.filter(r => !r.ok);
  const report = { executedAt: new Date().toISOString(), passed: results.length - failed.length, failed: failed.length, results, evidence };
  fs.writeFileSync(path.join(__dirname, 'artifacts', process.env.E2E_ONLY ? 'resultado-isolado.json' : 'resultado.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (failed.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
