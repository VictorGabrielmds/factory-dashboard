const test = require('node:test');
const assert = require('node:assert/strict');
const { analisarExposicaoPublica } = require('../lib/auditoria-exposicao-publica.cjs');

test('exposição pública: detecta chave privada sem vazar seu conteúdo', () => {
  const resultado = analisarExposicaoPublica([{ nome: 'src/config.ts', conteudo: '"private_key": "nao-exibir"' }]);
  assert.equal(resultado.bloqueios, 1);
  assert.deepEqual(resultado.achados, [{ codigo: 'CHAVE_PRIVADA_PUBLICA', arquivo: 'src/config.ts', linha: 1 }]);
  assert.equal(JSON.stringify(resultado).includes('nao-exibir'), false);
});

test('exposição pública: bloqueia token duradouro em URL e Bearer literal', () => {
  const resultado = analisarExposicaoPublica([{ nome: 'docs/integracao.md', conteudo: [
    'https://exemplo.test/hook?token=nao-exibir-123456',
    'Authorization: Bearer nao-exibir-abcdef',
  ].join('\n') }]);
  assert.equal(resultado.bloqueios, 2);
  assert.deepEqual(resultado.achados.map((achado) => achado.codigo).sort(), ['TOKEN_EM_URL_PUBLICA', 'BEARER_LITERAL_PUBLICO'].sort());
  assert.equal(JSON.stringify(resultado).includes('nao-exibir'), false);
});

test('exposição pública: bloqueia chave de Geocoding e aceita identificação Firebase', () => {
  const chaveGoogleMaps = analisarExposicaoPublica([{ nome: 'src/mapa.ts', conteudo: 'const key = "AIzaNaoExpor123456"' }]);
  assert.equal(chaveGoogleMaps.bloqueios, 1);
  assert.equal(chaveGoogleMaps.achados[0].codigo, 'CHAVE_GOOGLE_MAPS_EMBUTIDA');
  const resultado = analisarExposicaoPublica([{ nome: 'src/firebase.ts', conteudo: 'apiKey: "AIzaSyExemploPublico"' }]);
  assert.equal(resultado.bloqueios, 0);
});

test('exposição pública: inventário vazio falha fechado', () => {
  assert.throws(() => analisarExposicaoPublica([]), /INVENTARIO_INCOMPLETO/);
});
