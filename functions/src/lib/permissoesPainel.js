// ============================================================================
// PERMISSÕES DO PAINEL
//
// Papel diz qual é a função principal da pessoa; capacidade diz qual ação ela
// pode executar. A distinção evita espalhar `papel === "gestor"` pelos
// endpoints e permite uma exceção explícita, por exemplo, dar a alguém do
// atendimento apenas a capacidade de conferir fiscal.
//
// A migração é deliberadamente em duas fases:
// - staff antigo (sem papel) continua operando para não parar a loja;
// - um staff com `permissoesEstritas: true` passa a ser realmente bloqueado
//   pelo conjunto de capacidades abaixo.
//
// Nunca usar dados enviados pelo navegador para montar este objeto: ele vem
// exclusivamente de staff/{uid}, lido pelo backend depois de validar o token.
// ============================================================================

const CAPACIDADES_POR_PAPEL = Object.freeze({
  gestor: ["*"],
  atendimento: [
    "chat.ler", "chat.atender", "pedidos.ler", "pedidos.operar",
    "clientes.consultar", "rotas.operar",
  ],
  cozinha: ["pedidos.ler", "cozinha.operar"],
  motoboy: ["entregas.atribuidas.ler", "entregas.atribuidas.atualizar"],
  fiscal: ["fiscal.preparar", "fiscal.emitir", "fiscal.cancelar"],
  operador: [
    "chat.ler", "chat.atender", "pedidos.ler", "pedidos.operar",
    "clientes.consultar", "rotas.operar", "cozinha.operar",
  ],
  // Só existe enquanto todos os documentos de staff não receberam papel. O
  // plano de migração deve eliminar este caso antes de ativar modo estrito.
  operador_legado: ["*"],
});

// Esta é a lista fechada de exceções que um gestor pode conceder no campo
// `permissoes` de um documento staff. Ela é propositalmente diferente dos
// curingas internos dos papéis `gestor` e `operador_legado`: um `"*"`
// gravado por engano (ou por uma integração comprometida) nunca pode virar
// acesso total.
const CAPACIDADES_EXPLICITAS_PERMITIDAS = Object.freeze([
  "chat.ler",
  "chat.atender",
  "pedidos.ler",
  "pedidos.operar",
  "pedidos.cancelar",
  "clientes.consultar",
  "clientes.bloquear",
  "rotas.operar",
  "cozinha.operar",
  "entregas.atribuidas.ler",
  "entregas.atribuidas.atualizar",
  "fiscal.preparar",
  "fiscal.emitir",
  "fiscal.cancelar",
  "financeiro.confirmar_pix",
  // Parear ou revogar um computador de impressão entrega uma identidade que
  // opera fora do navegador. É separado de pedidos e cozinha.
  "impressao.parear",
]);

const PAPEIS_CONFIGURAVEIS = Object.freeze(
  Object.keys(CAPACIDADES_POR_PAPEL).filter((papel) => papel !== "operador_legado")
);

function listaTexto(valor) {
  if (!Array.isArray(valor)) return [];
  return [...new Set(valor
    .filter((item) => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0 && item.length <= 100)
  )];
}

function staffTemConfiguracaoDePermissao(staff = {}) {
  return ["papel", "papeis", "permissoes", "permissoesEstritas"]
    .some((campo) => Object.hasOwn(staff, campo));
}

function normalizarPapeis(staff = {}) {
  const vindosDaLista = listaTexto(staff.papeis);
  const papelPrincipal = typeof staff.papel === "string"
    ? staff.papel.trim().toLowerCase()
    : "";
  const papeis = [...new Set([
    ...vindosDaLista,
    ...(papelPrincipal ? [papelPrincipal] : []),
  ])].filter((papel) => PAPEIS_CONFIGURAVEIS.includes(papel));

  if (papeis.length > 0) return papeis;

  // Compatibilidade só vale para documentos realmente antigos, que ainda não
  // têm campo algum de permissão. Um papel digitado errado não pode se tornar
  // administrador por acidente, especialmente em modo estrito.
  return staffTemConfiguracaoDePermissao(staff) ? [] : ["operador_legado"];
}

function capacidadesDoStaff(staff = {}) {
  const papeis = normalizarPapeis(staff);
  const porPapel = papeis.flatMap((papel) => CAPACIDADES_POR_PAPEL[papel]);
  const excecoesPermitidas = listaTexto(staff.permissoes)
    .filter((capacidade) => CAPACIDADES_EXPLICITAS_PERMITIDAS.includes(capacidade));
  return [...new Set([...porPapel, ...excecoesPermitidas])];
}

function montarOperadorPainel({ usuario, staff }) {
  const papeis = normalizarPapeis(staff);
  return {
    uid: usuario.uid,
    email: usuario.email ? String(usuario.email) : null,
    nome: usuario.name ? String(usuario.name) : null,
    // Mantém `papel` por compatibilidade com as auditorias atuais. `papeis`
    // suporta a composição descrita no plano técnico.
    papel: papeis[0] || "sem_papel",
    papeis,
    capacidades: capacidadesDoStaff(staff),
    permissoesEstritas: staff.permissoesEstritas === true,
  };
}

function temCapacidade(operador, capacidade) {
  if (!operador || typeof capacidade !== "string" || !capacidade) return false;
  const capacidades = Array.isArray(operador.capacidades) ? operador.capacidades : [];
  return capacidades.includes("*") || capacidades.includes(capacidade);
}

/**
 * Avalia a capacidade sem tomar o papel da pessoa pelo payload HTTP. Enquanto
 * a migração não está estrita, a ação prossegue mas retorna `observacao` para
 * a auditoria revelar quem ainda precisa receber um papel bem definido.
 */
function avaliarCapacidade(operador, capacidade) {
  const permitidaPorPerfil = temCapacidade(operador, capacidade);
  if (permitidaPorPerfil) {
    return { autorizada: true, modo: "permitida", capacidade, permitidaPorPerfil: true };
  }
  if (!operador?.permissoesEstritas) {
    return { autorizada: true, modo: "observacao", capacidade, permitidaPorPerfil: false };
  }
  return { autorizada: false, modo: "negada", capacidade, permitidaPorPerfil: false };
}

function exigirCapacidadePainel(res, operador, capacidade) {
  const decisao = avaliarCapacidade(operador, capacidade);
  if (!decisao.autorizada) {
    res.status(403).json({
      error: "Seu acesso não permite executar esta ação.",
      codigo: "ACAO_NAO_AUTORIZADA",
    });
    return null;
  }
  return decisao;
}

/**
 * Ações sem equivalente no legado não podem herdar o "libera enquanto
 * observamos". Parear uma máquina cria uma identidade fora do navegador;
 * portanto exige gestor ou uma permissão concedida de modo explícito.
 */
function exigirCapacidadeCriticaPainel(res, operador, capacidade) {
  const vindoDoLegado = operador?.papeis?.includes("operador_legado");
  const permitido = !vindoDoLegado && temCapacidade(operador, capacidade);
  if (!permitido) {
    res.status(403).json({ error: "Seu acesso não permite executar esta ação.", codigo: "ACAO_NAO_AUTORIZADA" });
    return null;
  }
  return { autorizada: true, modo: "permitida", capacidade, permitidaPorPerfil: true };
}

module.exports = {
  CAPACIDADES_POR_PAPEL,
  CAPACIDADES_EXPLICITAS_PERMITIDAS,
  PAPEIS_CONFIGURAVEIS,
  staffTemConfiguracaoDePermissao,
  normalizarPapeis,
  capacidadesDoStaff,
  montarOperadorPainel,
  temCapacidade,
  avaliarCapacidade,
  exigirCapacidadePainel,
  exigirCapacidadeCriticaPainel,
};
