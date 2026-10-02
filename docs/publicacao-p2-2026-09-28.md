# Publicação P2 — recepção de pedidos e visibilidade PIX — 28/09/2026

Resultado: **publicado e aprovado no recorte verificado** no projeto
`entregas-781a8`, região `southamerica-east1`.

## Recursos publicados

- Regras do Firestore com bloqueio explícito da coleção interna
  `inbox_pedidos_instadelivery`.
- `processarEventoPedidoInsta`: criação em
  `inbox_pedidos_instadelivery/{eventoId}`, com retentativa idempotente.
- `reconciliarInboxPedidos`: varredor programado para recuperar eventos
  recebidos ou com erro transitório.
- `webhookPedidos` e `webhookPedidosBackup`: persistem na inbox antes do ACK,
  preservando as URLs existentes.
- `processarEventoAsaas` e `reconciliarPixAsaas`: promoção transacional do
  pedido próprio pago e proteção contra reabertura concorrente de cancelado.
- `conversas`: confirmação manual usa as mesmas garantias financeiras e
  operacionais.
- `criarPedido`: novos pedidos persistem `data_operacional`.
- Hosting `entregas-781a8-painel`: seção separada `Aguardando PIX` e consultas
  por criação, operação aberta e data operacional.

Todas as oito funções foram lidas como `ACTIVE`, runtime `nodejs24`, sem
instância mínima nova e mantendo `maxInstances: 10`. O gatilho da inbox foi
conferido como `google.cloud.firestore.document.v1.created`, com caminho exato
e `retry: true`.

## Evidências

- 181 testes unitários: aprovados, zero falhas/ignorados/TODOs.
- 16 cenários no Firebase Emulator Suite: aprovados.
- Build de produção e lint do painel: sem erros.
- Lint do backend: 56 fontes verificadas.
- Token propositalmente inválido: HTTP 401 no endereço `cloudfunctions.net`,
  no endereço `run.app` principal e no webhook de backup.
- Preflight de `conversas`: HTTP 204 para a origem do painel, incluindo
  `authorization` e `content-type`.
- Preflight de `criarPedido`: HTTP 204 para a origem do App Cliente, incluindo
  `content-type` e `x-firebase-appcheck`.
- SHA-256 do `index.html` servido pelo Hosting igual ao build local publicado.
- Checagem sanitizada das 100 entradas mais recentes solicitadas para as oito
  funções retornou 19 linhas, zero erros e zero avisos.

## Observação pós-publicação — 29/09/2026

Uma segunda leitura sanitizada, com até 500 entradas das oito funções do
recorte, retornou 15 registros e nenhum erro, aviso ou pendência de inbox. A
amostra não continha recebimento de pedido real; portanto, comprova apenas que
não apareceu falha imediata de execução/configuração no período consultado.
Ela não substitui a observação do primeiro pedido real recebido após o corte.

Nenhum pedido, pagamento, mensagem ou nota fiscal real foi criado nos probes.
Eles verificaram somente rejeição, CORS, configuração e artefato servido.

## Limites e acompanhamento

- A publicação não recupera automaticamente pedidos históricos que nunca
  chegaram a nenhum webhook. A inbox protege eventos recebidos após o corte.
- Ainda é necessário observar pedidos reais e o crescimento/idade da inbox.
  Falha permanente conserva o payload e cria pendência; não confirma PIX por
  semelhança.
- A Firebase CLI informou que há versão mais recente de `firebase-functions`.
  Não houve upgrade nesta publicação para evitar misturar mudança de SDK com
  o recorte financeiro; isso deve ser tratado em release separado com testes.
- Não houve E2E com compra real nesta verificação. O gate de homologação/carga
  do plano técnico continua pendente.
