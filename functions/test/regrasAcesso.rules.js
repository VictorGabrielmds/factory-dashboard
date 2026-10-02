const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const admin = require("firebase-admin");
const { initializeTestEnvironment, assertFails, assertSucceeds } = require("@firebase/rules-unit-testing");
const { doc, deleteDoc, getDoc, setDoc, updateDoc } = require("@firebase/firestore");
const { getBytes, ref, uploadBytes } = require("@firebase/storage");
const { executarCancelamento } = require("../src/services/operacoesPedidos");
const {
  COLECAO_NOTIFICACOES_PEDIDO,
  dadosNotificacaoCancelamento,
  idNotificacaoCancelamento,
} = require("../src/services/notificacoesPedido");
const { processarNotificacaoCancelamento } = require("../src/triggers/notificacoesPedido");
const { tratarStatusMensagem } = require("../src/webhooks/whatsapp");
const { executarConsulta } = require("../src/impressao/consultaRestrita");
const { criarTrabalhoImpressao, executarTrabalhoImpressao, DURACAO_LEASE_MS } = require("../src/impressao/trabalhos");

const projeto = "demo-factory-dashboard";
const regrasFirestore = fs.readFileSync(path.resolve(__dirname, "..", "..", "firestore.rules"), "utf8");
const regrasStorage = fs.readFileSync(path.resolve(__dirname, "..", "..", "storage.rules"), "utf8");

let ambiente;
let appAdmin;
let bancoAdmin;

async function prepararDados() {
  await ambiente.clearFirestore();
  await ambiente.clearStorage();
  await ambiente.withSecurityRulesDisabled(async (contexto) => {
    const banco = contexto.firestore();
    await Promise.all([
      setDoc(doc(banco, "staff", "operador-ativo"), { ativo: true, papel: "operador" }),
      setDoc(doc(banco, "staff", "operador-inativo"), { ativo: false, papel: "operador" }),
      setDoc(doc(banco, "staff", "operador-legado"), { papel: "operador" }),
      setDoc(doc(banco, "pedidos", "pedido-cliente-a"), {
        clienteUid: "cliente-a", total: 1000, status: 2, origem: "app",
        order_id: "pedido-cliente-a", nome_destinatario: "Cliente A",
        telefone_destinatario: "5592999991111",
      }),
      setDoc(doc(banco, "pedidos", "pedido-cliente-b"), {
        clienteUid: "cliente-b", total: 2000, status: 2, origem: "app",
        order_id: "pedido-cliente-b", nome_destinatario: "Cliente B",
        telefone_destinatario: "5592999992222",
      }),
      setDoc(doc(banco, "pedidos", "pedido-cancelado"), {
        clienteUid: "cliente-a", total: 3000, status: 4,
      }),
    ]);
  });
}

test.before(async () => {
  for (const variavel of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST"]) {
    assert.match(process.env[variavel] || "", /^(127\.0\.0\.1|localhost):[0-9]+$/,
      `${variavel} deve apontar para o emulador local antes de qualquer acesso ao banco.`);
  }
  ambiente = await initializeTestEnvironment({
    projectId: projeto,
    firestore: { rules: regrasFirestore },
    storage: { rules: regrasStorage },
  });
  appAdmin = admin.initializeApp({ projectId: projeto });
  bancoAdmin = admin.firestore(appAdmin);
});

test.after(async () => {
  if (ambiente) await ambiente.cleanup();
  if (appAdmin) await appAdmin.delete();
});

test.beforeEach(prepararDados);

test("Firestore: visitante e cliente não ganham acesso administrativo", async () => {
  const visitante = ambiente.unauthenticatedContext().firestore();
  const cliente = ambiente.authenticatedContext("cliente-a").firestore();

  await assertFails(getDoc(doc(visitante, "pedidos", "pedido-cliente-a")));
  await assertSucceeds(getDoc(doc(cliente, "pedidos", "pedido-cliente-a")));
  await assertFails(getDoc(doc(cliente, "pedidos", "pedido-cliente-b")));
  await assertFails(updateDoc(doc(cliente, "pedidos", "pedido-cliente-a"), { status: 2 }));
});

test("Firestore: equipe ativa pode operar; equipe inativa perde leitura e escrita", async () => {
  const ativo = ambiente.authenticatedContext("operador-ativo").firestore();
  const inativo = ambiente.authenticatedContext("operador-inativo").firestore();
  const legado = ambiente.authenticatedContext("operador-legado").firestore();

  await assertSucceeds(getDoc(doc(ativo, "pedidos", "pedido-cliente-a")));
  await assertSucceeds(updateDoc(doc(ativo, "pedidos", "pedido-cliente-a"), { status: 2 }));
  await assertFails(updateDoc(doc(ativo, "pedidos", "pedido-cliente-a"), { status: 4 }));
  await assertSucceeds(getDoc(doc(legado, "pedidos", "pedido-cliente-a")));
  await assertFails(getDoc(doc(inativo, "pedidos", "pedido-cliente-a")));
  await assertFails(updateDoc(doc(inativo, "pedidos", "pedido-cliente-a"), { status: 2 }));
});

test("Firestore: pedido cancelado só pode ser cancelado pelo comando do backend", async () => {
  const ativo = ambiente.authenticatedContext("operador-ativo").firestore();
  const pedidoAtivo = doc(ativo, "pedidos", "pedido-cliente-a");
  const pedidoCancelado = doc(ativo, "pedidos", "pedido-cancelado");

  // Fluxos operacionais que ainda rodam no cliente continuam disponíveis.
  await assertSucceeds(updateDoc(pedidoAtivo, { status: 3 }));
  await assertSucceeds(updateDoc(pedidoAtivo, { status: 5 }));
  await assertSucceeds(updateDoc(pedidoAtivo, { observacaoInterna: "Motoboy avisado" }));

  // O navegador não pode cancelar, reabrir ou editar um pedido já cancelado.
  await assertFails(updateDoc(pedidoAtivo, { status: 4 }));
  await assertFails(updateDoc(pedidoCancelado, { status: 2 }));
  await assertFails(updateDoc(pedidoCancelado, { observacaoInterna: "Tentativa de editar" }));
  await assertFails(deleteDoc(pedidoAtivo));
});

test("Firestore: lançamento avulso mantém a criação permitida e nunca cria cancelado", async () => {
  const ativo = ambiente.authenticatedContext("operador-ativo").firestore();

  await assertSucceeds(setDoc(doc(ativo, "pedidos", "avulso-valido"), {
    avulso: true,
    status: 5,
    order_id: "avulso-valido",
    total: 2500,
  }));
  await assertFails(setDoc(doc(ativo, "pedidos", "avulso-cancelado"), {
    avulso: true,
    status: 4,
    order_id: "avulso-cancelado",
    total: 2500,
  }));
});

test("backend: dois cancelamentos concorrentes geram uma auditoria e um único job", async () => {
  const operador = {
    uid: "operador-ativo",
    email: "operador@fabrica.test",
    nome: "Operador ativo",
    papel: "gestor",
    papeis: ["gestor"],
  };
  const autorizacao = {
    autorizada: true,
    modo: "permitida",
    capacidade: "pedidos.cancelar",
    permitidaPorPerfil: true,
  };
  const cancelar = () => executarCancelamento({
    db: bancoAdmin,
    FieldValue: admin.firestore.FieldValue,
    pedidoId: "pedido-cliente-a",
    operador,
    decisaoPermissao: autorizacao,
  });

  const resultados = await Promise.all([cancelar(), cancelar()]);
  assert.equal(resultados.filter((r) => r.jaCancelado === false).length, 1);
  assert.equal(resultados.filter((r) => r.jaCancelado === true).length, 1);
  assert.equal(resultados.filter((r) => r.notificacaoCriada === true).length, 1);

  const [pedido, jobs, auditorias] = await Promise.all([
    bancoAdmin.collection("pedidos").doc("pedido-cliente-a").get(),
    bancoAdmin.collection(COLECAO_NOTIFICACOES_PEDIDO)
      .where("pedidoId", "==", "pedido-cliente-a").get(),
    bancoAdmin.collection("auditorias_operacao")
      .where("pedidoId", "==", "pedido-cliente-a").get(),
  ]);
  assert.equal(pedido.data().status, 4);
  assert.equal(jobs.size, 1);
  assert.equal(jobs.docs[0].id, idNotificacaoCancelamento("pedido-cliente-a"));
  assert.equal(jobs.docs[0].data().estado, "pendente");
  assert.equal(auditorias.size, 1);
  assert.equal(auditorias.docs[0].data().operador.uid, "operador-ativo");
  assert.deepEqual(auditorias.docs[0].data().autorizacao.papeis, ["gestor"]);
});

test("worker: disputa do mesmo job envia uma vez; timeout vira pendência sem reenvio", async () => {
  const jobRef = bancoAdmin.collection(COLECAO_NOTIFICACOES_PEDIDO)
    .doc(idNotificacaoCancelamento("pedido-cliente-a"));
  await bancoAdmin.collection("pedidos").doc("pedido-cliente-a").set({
    status: 4,
    origem: "app",
    order_id: "pedido-cliente-a",
    nome_destinatario: "Cliente A",
    telefone_destinatario: "5592999991111",
  }, { merge: true });
  await jobRef.set(dadosNotificacaoCancelamento({
    pedidoId: "pedido-cliente-a",
    pedido: {
      order_id: "pedido-cliente-a",
      nome_destinatario: "Cliente A",
      telefone_destinatario: "5592999991111",
    },
    origem: "teste",
    agora: admin.firestore.FieldValue.serverTimestamp(),
  }));

  let envios = 0;
  const enviarAceito = async () => {
    envios += 1;
    return { msgId: "wamid.sucesso" };
  };
  await Promise.all([
    processarNotificacaoCancelamento({
      database: bancoAdmin, FieldValue: admin.firestore.FieldValue,
      notificacaoRef: jobRef, token: "teste", enviarTemplate: enviarAceito, execucaoId: "execucao-a",
    }),
    processarNotificacaoCancelamento({
      database: bancoAdmin, FieldValue: admin.firestore.FieldValue,
      notificacaoRef: jobRef, token: "teste", enviarTemplate: enviarAceito, execucaoId: "execucao-b",
    }),
  ]);
  assert.equal(envios, 1);
  assert.equal((await jobRef.get()).data().estado, "aceito_pela_meta");

  const timeoutRef = bancoAdmin.collection(COLECAO_NOTIFICACOES_PEDIDO).doc("cancelamento_timeout");
  await timeoutRef.set(dadosNotificacaoCancelamento({
    pedidoId: "pedido-cliente-b",
    pedido: {
      order_id: "pedido-cliente-b",
      nome_destinatario: "Cliente B",
      telefone_destinatario: "5592999992222",
    },
    origem: "teste",
    agora: admin.firestore.FieldValue.serverTimestamp(),
  }));
  let tentativasExternas = 0;
  const timeout = async () => {
    tentativasExternas += 1;
    throw new Error("timeout");
  };
  const primeiro = await processarNotificacaoCancelamento({
    database: bancoAdmin, FieldValue: admin.firestore.FieldValue,
    notificacaoRef: timeoutRef, token: "teste", enviarTemplate: timeout, execucaoId: "execucao-timeout",
  });
  const segundo = await processarNotificacaoCancelamento({
    database: bancoAdmin, FieldValue: admin.firestore.FieldValue,
    notificacaoRef: timeoutRef, token: "teste", enviarTemplate: timeout, execucaoId: "execucao-timeout-2",
  });
  assert.equal(primeiro.estado, "incerto");
  assert.equal(segundo.estado, "ignorada");
  assert.equal(tentativasExternas, 1);
  assert.equal((await timeoutRef.get()).data().estado, "incerto");
  assert.equal((await bancoAdmin.collection("pendencias")
    .doc("notificacao_cancelamento_pedido-cliente-b").get()).exists, true);
});

async function prepararNotificacaoParaCallback() {
  const pedidoId = "pedido-cliente-a";
  const pedidoRef = bancoAdmin.collection("pedidos").doc(pedidoId);
  await pedidoRef.set({ status: 4 }, { merge: true });
  const jobRef = bancoAdmin.collection(COLECAO_NOTIFICACOES_PEDIDO)
    .doc(idNotificacaoCancelamento(pedidoId));
  await jobRef.set(dadosNotificacaoCancelamento({
    pedidoId, pedido: (await pedidoRef.get()).data(), origem: "teste",
    agora: admin.firestore.FieldValue.serverTimestamp(),
  }));
  return { pedidoRef, jobRef };
}

test("callback Meta: aceite não significa entrega; delivered e read ficam registrados", async () => {
  const { jobRef } = await prepararNotificacaoParaCallback();
  await processarNotificacaoCancelamento({
    database: bancoAdmin, FieldValue: admin.firestore.FieldValue,
    notificacaoRef: jobRef, token: "teste", execucaoId: "callback-entrega",
    enviarTemplate: async () => ({ msgId: "wamid.entrega-teste" }),
  });
  assert.equal((await jobRef.get()).data().statusMeta, undefined);
  for (const status of ["delivered", "read"]) {
    await tratarStatusMensagem({ id: "wamid.entrega-teste", recipient_id: "5592999991111", status });
    const job = (await jobRef.get()).data();
    assert.equal(job.estado, "aceito_pela_meta");
    assert.equal(job.statusMeta, status);
  }
  assert.equal((await bancoAdmin.collection("pendencias").get()).size, 0);
});

test("callback Meta: falha após aceite atualiza pedido e gera uma única pendência", async () => {
  const { jobRef, pedidoRef } = await prepararNotificacaoParaCallback();
  let envios = 0;
  const executar = () => processarNotificacaoCancelamento({
    database: bancoAdmin, FieldValue: admin.firestore.FieldValue,
    notificacaoRef: jobRef, token: "teste", execucaoId: "callback-falha",
    enviarTemplate: async () => { envios += 1; return { msgId: "wamid.falha-teste" }; },
  });
  await executar();
  const falha = { id: "wamid.falha-teste", recipient_id: "5592999991111", status: "failed",
    errors: [{ code: 131026, title: "Mensagem não entregue (teste)" }] };
  await tratarStatusMensagem(falha);
  await tratarStatusMensagem(falha);
  await executar();
  const job = (await jobRef.get()).data();
  assert.equal(job.estado, "falhou");
  assert.equal(job.statusMeta, "failed");
  assert.equal(job.motivo, falha.errors[0].title);
  const pedido = (await pedidoRef.get()).data();
  assert.equal(pedido.status, 4);
  assert.equal(pedido.notificacao_cancelamento.estado, "falhou");
  assert.equal((await bancoAdmin.collection("pendencias").get()).size, 1);
  assert.equal(envios, 1);
});

test("callback Meta: falha que chega antes do ID não se perde na finalização do worker", async () => {
  const { jobRef, pedidoRef } = await prepararNotificacaoParaCallback();
  const resultado = await processarNotificacaoCancelamento({
    database: bancoAdmin, FieldValue: admin.firestore.FieldValue,
    notificacaoRef: jobRef, token: "teste", execucaoId: "callback-antecipado",
    enviarTemplate: async () => {
      assert.equal((await jobRef.get()).data().metaMensagemId, undefined);
      await tratarStatusMensagem({ id: "wamid.antecipado-teste", recipient_id: "5592999991111", status: "failed",
        errors: [{ code: 131026, title: "Falha antecipada (teste)" }] });
      return { msgId: "wamid.antecipado-teste" };
    },
  });
  assert.equal(resultado.estado, "falhou");
  assert.equal((await jobRef.get()).data().statusMeta, "failed");
  assert.equal((await pedidoRef.get()).data().notificacao_cancelamento.estado, "falhou");
  assert.equal((await bancoAdmin.collection("pendencias").get()).size, 1);
});

const uidImpressora = "imp_dispositivo_teste_01";
async function prepararDispositivo() {
  await bancoAdmin.collection("configuracoes").doc("impressao_api").set({ ativa: true, versao: 1 });
  await bancoAdmin.collection("dispositivos_impressao").doc(uidImpressora).set({
    uid: uidImpressora, ativo: true, tipo: "impressao", credencialVersao: 1,
  });
  await bancoAdmin.collection("trabalhos_impressao").doc("trabalho-a").set({
    dispositivoUid: uidImpressora, credencialVersao: 1, estado: "pendente",
    expiraEm: admin.firestore.Timestamp.fromMillis(Date.now() + 60000),
    recibo: { versao: 1, pedidoId: "pedido-cliente-a", tipo: "retirada", nome: "Cliente teste",
      horarioAgendado: "10/09 às 10:30", pagamento: "PIX", pago: true, totalCentavos: 1000,
      itens: [{ nome: "Bolinha", quantidade: 10 }], cpf: "não retornar", asaasPaymentId: "não retornar" },
  });
}
function consultarComoDispositivo(dados) {
  return executarConsulta({ db: bancoAdmin, FieldValue: admin.firestore.FieldValue,
    identidade: { uid: uidImpressora, credencialVersao: 1 }, dados });
}

test("impressão restrita: lê somente trabalho atribuído, sem alterar pedido nem autorizar impressão", async () => {
  await prepararDispositivo();
  const pedidoAntes = (await bancoAdmin.collection("pedidos").doc("pedido-cliente-a").get()).data();
  const r = await consultarComoDispositivo({ action: "consultarTrabalho", trabalhoId: "trabalho-a" });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.autorizacaoDeImpressao, false);
  assert.equal(JSON.stringify(r.corpo).includes("não retornar"), false);
  assert.deepEqual((await bancoAdmin.collection("pedidos").doc("pedido-cliente-a").get()).data(), pedidoAntes);
  await bancoAdmin.collection("trabalhos_impressao").doc("trabalho-a").update({ dispositivoUid: "imp_dispositivo_teste_02" });
  const outro = await consultarComoDispositivo({ action: "consultarTrabalho", trabalhoId: "trabalho-a" });
  const ausente = await consultarComoDispositivo({ action: "consultarTrabalho", trabalhoId: "inexistente" });
  assert.deepEqual(outro, ausente);
  assert.equal(outro.status, 404);
});

test("impressão restrita: transação revalida desativação, rotação, staff e expiração", async () => {
  await prepararDispositivo();
  const d = bancoAdmin.collection("dispositivos_impressao").doc(uidImpressora);
  const consultar = () => consultarComoDispositivo({ action: "consultarTrabalho", trabalhoId: "trabalho-a" });
  await d.update({ ativo: false });
  assert.equal((await consultar()).status, 403);
  await d.update({ ativo: true, credencialVersao: 2 });
  assert.equal((await consultar()).status, 403);
  await d.update({ credencialVersao: 1 });
  await bancoAdmin.collection("staff").doc(uidImpressora).set({ ativo: true });
  assert.equal((await consultar()).status, 403);
  await bancoAdmin.collection("staff").doc(uidImpressora).delete();
  await bancoAdmin.collection("trabalhos_impressao").doc("trabalho-a").update({ expiraEm: admin.firestore.Timestamp.fromMillis(1) });
  assert.equal((await consultar()).status, 404);
  await bancoAdmin.collection("configuracoes").doc("impressao_api").update({ ativa: false });
  assert.equal((await consultar()).status, 503);
});

test("impressão restrita: presença concorrente grava uma vez sem sobrescrever o robô legado", async () => {
  await prepararDispositivo();
  const legado = bancoAdmin.collection("sistema").doc("robo_impressao");
  await legado.set({ online: true, modo: "legado" });
  const resultados = await Promise.all([1, 2].map(() => consultarComoDispositivo({ action: "registrarPresenca", versaoApp: "1.2.4" })));
  assert.deepEqual(resultados.map((r) => r.status).sort(), [200, 429]);
  assert.deepEqual((await legado.get()).data(), { online: true, modo: "legado" });
  assert.equal((await bancoAdmin.collection("dispositivos_impressao").doc(uidImpressora).get()).data().versaoApp, "1.2.4");
});

test("regras: inbox, impressão e registros fiscais não ficam expostos aos clientes", async () => {
  await prepararDispositivo();
  for (const contexto of [ambiente.authenticatedContext("operador-ativo"), ambiente.authenticatedContext("cliente-a"),
    ambiente.authenticatedContext(uidImpressora, { tipo: "dispositivo_impressao" })]) {
    const banco = contexto.firestore();
    for (const [colecao, id] of [
      ["dispositivos_impressao", uidImpressora],
      ["trabalhos_impressao", "trabalho-a"],
      ["_pareamentos_impressao", "par_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      ["fiscal_produtos", "coxinha"],
      ["fiscal_conferencias", "pedido-cliente-a"],
      ["fiscal_operacoes", "op_teste"],
      ["fiscal_sistema", "conexao"],
      ["inbox_pedidos_instadelivery", "evento_teste"],
    ]) {
      await assertFails(getDoc(doc(banco, colecao, id)));
      await assertFails(setDoc(doc(banco, colecao, id), { ativo: true, estado: "impresso" }));
    }
  }
});

test("impressão restrita: lease é exclusiva, expira como inconclusiva e não mexe no pedido", async () => {
  await prepararDispositivo();
  const agora = Date.now();
  const pedidoRef = bancoAdmin.collection("pedidos").doc("pedido-cliente-a");
  const pedidoAntes = (await pedidoRef.get()).data();
  const criado = await criarTrabalhoImpressao({
    db: bancoAdmin, FieldValue: admin.firestore.FieldValue, Timestamp: admin.firestore.Timestamp,
    pedidoId: "pedido-cliente-a", versaoFonte: "recibo-1", dispositivoUid: uidImpressora,
    credencialVersao: 1, agoraMs: agora,
    recibo: { versao: 1, pedidoId: "pedido-cliente-a", tipo: "retirada", nome: "Cliente teste",
      horarioAgendado: "10/09 às 10:30", pagamento: "PIX", pago: true, totalCentavos: 1000,
      itens: [{ nome: "Bolinha", quantidade: 10 }] },
  });
  const dados = { action: "reivindicarTrabalho", trabalhoId: criado.corpo.trabalhoId,
    leaseId: "lease_11111111111111111111111111111111" };
  const identidade = { uid: uidImpressora, credencialVersao: 1 };
  const primeiro = await executarTrabalhoImpressao({ db: bancoAdmin, FieldValue: admin.firestore.FieldValue,
    Timestamp: admin.firestore.Timestamp, identidade, dados, agoraMs: agora + 1 });
  assert.equal(primeiro.corpo.autorizacaoDeImpressao, true);
  const disputa = await executarTrabalhoImpressao({ db: bancoAdmin, FieldValue: admin.firestore.FieldValue,
    Timestamp: admin.firestore.Timestamp, identidade,
    dados: { ...dados, leaseId: "lease_22222222222222222222222222222222" }, agoraMs: agora + 2 });
  assert.equal(disputa.status, 404);
  const expirado = await executarTrabalhoImpressao({ db: bancoAdmin, FieldValue: admin.firestore.FieldValue,
    Timestamp: admin.firestore.Timestamp, identidade, dados, agoraMs: agora + 1 + DURACAO_LEASE_MS });
  assert.equal(expirado.status, 409);
  assert.equal((await bancoAdmin.collection("trabalhos_impressao").doc(criado.corpo.trabalhoId).get()).data().estado, "inconclusivo");
  assert.deepEqual((await pedidoRef.get()).data(), pedidoAntes);
});

test("Storage: só equipe ativa acessa mídia privada e publica imagens", async () => {
  const ativo = ambiente.authenticatedContext("operador-ativo").storage();
  const inativo = ambiente.authenticatedContext("operador-inativo").storage();
  const cliente = ambiente.authenticatedContext("cliente-a").storage();
  const visitante = ambiente.unauthenticatedContext().storage();
  const imagem = new Uint8Array([137, 80, 78, 71]);

  await assertSucceeds(uploadBytes(ref(ativo, "produtos/casquinha.png"), imagem, { contentType: "image/png" }));
  await assertSucceeds(getBytes(ref(visitante, "produtos/casquinha.png")));
  await assertFails(uploadBytes(ref(cliente, "produtos/nao-autorizado.png"), imagem, { contentType: "image/png" }));
  await assertFails(uploadBytes(ref(inativo, "produtos/inativo.png"), imagem, { contentType: "image/png" }));
  await assertSucceeds(uploadBytes(ref(ativo, "whatsapp_midia/audio.ogg"), imagem, { contentType: "audio/ogg" }));
  await assertSucceeds(getBytes(ref(ativo, "whatsapp_midia/audio.ogg")));
  await assertFails(getBytes(ref(cliente, "whatsapp_midia/audio.ogg")));
  await assertFails(getBytes(ref(inativo, "whatsapp_midia/audio.ogg")));
});

test("Storage: regras de formato e tamanho continuam protegendo o catálogo público", async () => {
  const ativo = ambiente.authenticatedContext("operador-ativo").storage();

  await assertFails(uploadBytes(ref(ativo, "produtos/arquivo.txt"), new Uint8Array([1]), {
    contentType: "text/plain",
  }));
});
