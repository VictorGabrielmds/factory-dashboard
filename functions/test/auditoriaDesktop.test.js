const test = require('node:test');
const assert = require('node:assert/strict');
const { analisarDesktop } = require('../../scripts/lib/auditoria-desktop.cjs');
const pacote = ['RoboImpressaoDelivery.exe', 'RoboImpressaoDelivery.deps.json', 'RoboImpressaoDelivery.runtimeconfig.json'];
const fonte = (conteudo) => [{ nome: 'Teste.cs', conteudo }];

test('desktop: identifica credencial Google e acesso direto sem mostrar o conteúdo', () => {
  const r = analisarDesktop(fonte('GOOGLE_APPLICATION_CREDENTIALS\nFirestoreDb.Create("demo");\n_db.Collection("pedidos");'), pacote);
  assert.equal(r.bloqueiosEstaticos, 3);
  assert.equal(r.achados[0].linha, 1);
  assert.equal(JSON.stringify(r).includes('FirestoreDb.Create'), false);
});
test('desktop: chave compartilhada e material privado são bloqueados com saída sanitizada', () => {
  const r = analisarDesktop(fonte('PANEL_API_KEY = "segredo-ficticio";\n"private_key": "outro-segredo-ficticio"'), pacote);
  assert.equal(r.bloqueiosEstaticos, 2);
  assert.equal(JSON.stringify(r).includes('segredo-ficticio'), false);
});
test('desktop: identifica dependência de SDK servidor mesmo sem chamada na fonte', () => {
  const r = analisarDesktop(fonte('<PackageReference Include="Google.Cloud.Firestore" Version="4.3.0" />'), pacote);
  assert.equal(r.achados[0].codigo, 'SDK_SERVIDOR_FIRESTORE_NO_DESKTOP');
});
test('desktop: JSON desconhecido e credenciais no ZIP não passam na triagem', () => {
  const r = analisarDesktop(fonte('class Cliente {}'), [...pacote, 'sub/pessoa.json', 'sub\\credencial.pem', '.env']);
  assert.equal(r.bloqueiosEstaticos, 3);
});
test('desktop: histórico e logs nunca devem ser distribuídos no pacote', () => {
  const r = analisarDesktop(fonte('class Cliente {}'), [...pacote, 'pedidos_recentes.json', 'logs/robo.log']);
  assert.equal(r.bloqueiosEstaticos, 2);
  assert.ok(r.achados.every((a) => a.codigo === 'DADOS_LOCAIS_NO_PACOTE'));
});
test('desktop: ausência de padrões não vira aprovação de produção', () => {
  const r = analisarDesktop(fonte('class Cliente {}'), pacote);
  assert.equal(r.bloqueiosEstaticos, 0);
  assert.equal(r.aprovacaoAutomatica, false);
});
test('desktop: inventário ausente ou parcial falha fechado', () => {
  assert.throws(() => analisarDesktop([], pacote), /INVENTARIO_INCOMPLETO/);
  assert.throws(() => analisarDesktop(fonte('class Cliente {}'), []), /INVENTARIO_INCOMPLETO/);
});
