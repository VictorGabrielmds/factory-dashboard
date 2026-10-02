// ============================================================================
// UTILITÁRIOS PUROS (sem I/O) — fáceis de testar
// ============================================================================

/**
 * Variantes de um número BR (com e sem o 9º dígito),
 * pois a Meta às vezes entrega o wa_id em formato diferente do salvo.
 */
function variantesNumero(numero) {
  const variantes = new Set([numero]);

  if (numero.startsWith("55") && numero.length === 13) {
    const ddd   = numero.slice(2, 4);
    const resto = numero.slice(4);
    if (resto.length === 9 && resto[0] === "9") variantes.add("55" + ddd + resto.slice(1));
  }
  if (numero.startsWith("55") && numero.length === 12) {
    const ddd   = numero.slice(2, 4);
    const resto = numero.slice(4);
    variantes.add("55" + ddd + "9" + resto);
  }
  return variantes;
}

/** Normaliza telefone: só dígitos + DDI 55. Retorna null se inválido. */
function normalizarTelefone(bruto) {
  let tel = String(bruto || "").replace(/\D/g, "");
  if (tel.length === 11 || tel.length === 10) tel = "55" + tel;
  return tel.length >= 12 ? tel : null;
}

/** Garante o 9º dígito em números BR de 12 dígitos (wa_id da Meta). */
function garantirNonoDigito(numero) {
  if (numero.startsWith("55") && numero.length === 12) {
    return numero.slice(0, 4) + "9" + numero.slice(4);
  }
  return numero;
}

/** Janela de preparo com base na data da venda e no agendamento. */
function calcularJanelas(dataVendaStr, agendamentoStr) {
  try {
    const dataVenda = new Date(dataVendaStr.replace(" ", "T"));
    const match = agendamentoStr.match(/Dia (\d{2})\/(\d{2}) - (\d{2}):(\d{2})/);
    if (!match) return null;

    const [, diaStr, mesStr, horaStr, minStr] = match;
    let anoAg = dataVenda.getFullYear();
    const mesAg = parseInt(mesStr, 10) - 1;
    if (dataVenda.getMonth() === 11 && mesAg === 0) anoAg += 1;

    const dataAlvo     = new Date(anoAg, mesAg, parseInt(diaStr, 10), parseInt(horaStr, 10), parseInt(minStr, 10));
    const diffMinutos  = (dataAlvo - dataVenda) / 60000;
    const inicioOffset = diffMinutos > 50 ? -10 : -5;

    return {
      janela_inicio: new Date(dataAlvo.getTime() + inicioOffset * 60000).toISOString(),
      janela_fim:    new Date(dataAlvo.getTime() + 15 * 60000).toISOString(),
    };
  } catch (e) {
    console.error("Erro ao calcular janelas:", e);
    return null;
  }
}

/** Hora atual formatada no fuso de São Paulo. */
function horaAtualSP() {
  return new Date().toLocaleTimeString("pt-BR", {
    hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo",
  });
}

/** Data e hora atuais em SP, formato "AAAA-MM-DD HH:mm:ss" — mesmo formato
 *  usado em data_venda dos pedidos (ordena lexicograficamente como data real). */
function dataHoraAtualSP() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Sao_Paulo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).format(new Date());
}

/**
 * Converte os formatos de data que o InstaDelivery costuma alternar para o
 * formato canônico do painel: "AAAA-MM-DD HH:mm:ss". A conversão é feita
 * apenas por componentes de calendário (sem new Date sobre texto local),
 * para não deslocar o horário do pedido por fuso.
 *
 * Retorna string vazia quando o valor não representa uma data válida. Quem
 * chama decide se preserva o original para auditoria e usa a hora de entrada
 * como fallback.
 */
function normalizarDataVenda(valor) {
  const texto = String(valor ?? "").trim();
  if (!texto) return "";

  let partes = null;
  const iso = texto.match(
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (iso) {
    partes = {
      ano: Number(iso[1]), mes: Number(iso[2]), dia: Number(iso[3]),
      hora: Number(iso[4] ?? 0), minuto: Number(iso[5] ?? 0), segundo: Number(iso[6] ?? 0),
    };
  } else {
    const br = texto.match(
      /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\s*(?:às)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?)?/
    );
    if (br) {
      partes = {
        ano: Number(br[3]), mes: Number(br[2]), dia: Number(br[1]),
        hora: Number(br[4] ?? 0), minuto: Number(br[5] ?? 0), segundo: Number(br[6] ?? 0),
      };
    }
  }

  if (!partes) return "";
  const data = new Date(Date.UTC(
    partes.ano, partes.mes - 1, partes.dia, partes.hora, partes.minuto, partes.segundo
  ));
  if (
    data.getUTCFullYear() !== partes.ano ||
    data.getUTCMonth() !== partes.mes - 1 ||
    data.getUTCDate() !== partes.dia ||
    data.getUTCHours() !== partes.hora ||
    data.getUTCMinutes() !== partes.minuto ||
    data.getUTCSeconds() !== partes.segundo
  ) return "";

  const pad = (numero) => String(numero).padStart(2, "0");
  return `${partes.ano}-${pad(partes.mes)}-${pad(partes.dia)} ${pad(partes.hora)}:${pad(partes.minuto)}:${pad(partes.segundo)}`;
}

/**
 * Data usada para organizar a operação, independente do dia em que a venda
 * foi criada. O InstaDelivery envia o agendamento sem ano; por isso o ano é
 * inferido a partir da data da venda, incluindo a virada dezembro/janeiro.
 */
function dataOperacionalPedido(dataVenda, agendamento) {
  const venda = normalizarDataVenda(dataVenda);
  if (!venda) return "";

  const agendado = String(agendamento || "").match(/Dia\s+(\d{1,2})\/(\d{1,2})/i);
  if (!agendado) return venda.slice(0, 10);

  const [anoVenda, mesVenda] = venda.slice(0, 10).split("-").map(Number);
  const dia = Number(agendado[1]);
  const mes = Number(agendado[2]);
  let ano = anoVenda;
  if (mesVenda === 12 && mes === 1) ano += 1;

  const data = new Date(Date.UTC(ano, mes - 1, dia));
  if (
    data.getUTCFullYear() !== ano ||
    data.getUTCMonth() !== mes - 1 ||
    data.getUTCDate() !== dia
  ) return venda.slice(0, 10);

  return `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

// Verifica se o horário de um agendamento (formato "Dia DD/MM - HH:MM", ver
// formatarAgendamento em services/horario.js) ainda está no futuro — usado
// pra decidir se a mensagem de "saiu para entrega" deve tranquilizar ("chega
// no horário combinado") em vez do texto genérico, quando o motoboy sai numa
// viagem com várias paradas antes do horário marcado pra esta entrega
// específica. "Agora" é derivado do MESMO texto de dataHoraAtualSP() (em vez
// de "new Date()" direto) pra comparar sempre dígitos de parede de SP contra
// dígitos de parede de SP, não importa o fuso horário real do runtime.
function agendamentoAindaNoFuturo(agendamentoTexto) {
  if (!agendamentoTexto) return null;
  const match = String(agendamentoTexto).match(/Dia (\d{2})\/(\d{2}) - (\d{2}):(\d{2})/);
  if (!match) return null;

  const [, diaStr, mesStr, horaStr, minStr] = match;
  const agora = new Date(dataHoraAtualSP().replace(" ", "T"));
  let ano = agora.getFullYear();
  const mes = parseInt(mesStr, 10) - 1;
  if (agora.getMonth() === 11 && mes === 0) ano += 1; // agendamento de janeiro visto em dezembro é ano que vem

  const alvo = new Date(ano, mes, parseInt(diaStr, 10), parseInt(horaStr, 10), parseInt(minStr, 10));
  return { noFuturo: alvo.getTime() > agora.getTime(), horario: `${horaStr}:${minStr}` };
}

/** Extrai lat/lng de "lat,lng" cru ou de um link do Google Maps. */
function extrairLatLng(mediaUrl) {
  const doLink = mediaUrl.match(/query=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (doLink) return [Number(doLink[1]), Number(doLink[2])];
  const partes = mediaUrl.split(",").map(Number);
  if (partes.length === 2 && !partes.some(Number.isNaN)) return partes;
  return [NaN, NaN];
}

/** Sanitiza um valor para ser usado como ID de documento no Firestore. */
function idDocSeguro(valor) {
  return String(valor).replace(/\//g, "_").slice(0, 1400) || `id_${Date.now()}`;
}

const formatarReal = (n) => Number(n || 0).toFixed(2).replace(".", ",");

module.exports = {
  variantesNumero, normalizarTelefone, garantirNonoDigito,
  calcularJanelas, horaAtualSP, dataHoraAtualSP, normalizarDataVenda, dataOperacionalPedido,
  agendamentoAindaNoFuturo,
  extrairLatLng, idDocSeguro, formatarReal,
};
