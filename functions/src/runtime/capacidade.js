// Perfis opt-in: nunca aplicar como padrão global. O checkout, autenticação,
// webhooks, reconciliação PIX e processamento de mídia mantêm seus recursos.
// A cota regional é compartilhada: estes limites reduzem disputa, não reservam
// CPU exclusivamente para criarPedido e não garantem disponibilidade absoluta.
const CONSULTA_LEVE = Object.freeze({
  memory: "256MiB",
  cpu: "gcf_gen1", // 1/6 vCPU com 256 MiB, segundo o mapeamento do Firebase.
  concurrency: 1, // CPU fracionada não admite concorrência > 1 por instância.
  minInstances: 0, // não introduzir custo fixo de instância sempre ligada.
  maxInstances: 4,
});

// Mantém o teto de três instâncias já adotado pelo módulo fiscal. Nesta fase
// ele só confere/salva dados e consulta o provedor; não emite documentos.
const PREPARACAO_FISCAL = Object.freeze({ ...CONSULTA_LEVE, maxInstances: 3 });

module.exports = { CONSULTA_LEVE, PREPARACAO_FISCAL };
