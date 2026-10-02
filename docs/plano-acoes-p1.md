# Plano de ações — P1: modelo próprio de pedidos

Data: 22/09/2026. Estado: **planejado; implementação deste roteiro não iniciada**.

Este roteiro detalha a P1 do [plano técnico](plano-tecnico-arquitetura.md), usando os critérios do [plano de testes](plano-testes-arquitetura.md). A preparação local pode avançar sem o computador da loja. Publicação, migração de dados reais e piloto operacional são entregas posteriores com seus próprios critérios.

Atualização de prioridade em 22/09: a pedido do usuário, a emissão fiscal foi antecipada em uma [frente prioritária própria](plano-acoes-fiscal-prioritario.md). Aproveitará o adaptador fiscal dos pedidos atuais e os requisitos mínimos de consistência/recuperação; não depende da conclusão integral deste roteiro. A migração ampla P1 permanece planejada, e seus contratos podem servir à frente fiscal.

## 1. Resultado esperado e limites

O sistema terá uma definição própria de pedido, independente do formato InstaDelivery. Pedidos antigos e novos continuarão reconhecíveis pelos mesmos IDs e referências financeiras; dashboard, app cliente, cozinha e impressão deverão interpretar o mesmo estado.

Premissas mantidas: dois operadores e um terceiro acesso eventual, 200 pedidos/dia com picos de 600, Firebase/Firestore e orçamento de infraestrutura de R$ 200/mês. P1 não cria novos serviços pagos nem afirma que a capacidade ou o custo já foram medidos.

Por decisão do usuário, ficaram adiados: proteção de branch/CI-03 completo, revisão ampla da exposição dos dados do app cliente e organização das contas/permissões da equipe. Eles continuam pendentes no P0. Testes remotos já aprovados não concluem P0 nem liberam automaticamente a ativação de P1. Autorização e dados mínimos continuam requisitos de qualquer caminho novo que vier a ser publicado.

Fora desta entrega: redesenho das telas, substituição do processamento financeiro por novas filas, reconstrução do chat, emissão fiscal, instalação do robô e cancelamento do InstaDelivery. O modelo dará suporte a essas fases, preservando as integrações existentes.

## 2. Evidência inicial do código local

Esta é uma leitura direcionada, não uma auditoria de produção ou inventário completo dos escritores.

| Ponto observado | Consequência para a P1 |
| --- | --- |
| `src/types/Pedido.ts` usa arrays paralelos de itens, valores como número/string e status numéricos herdados | Criar contrato novo sem trocar esse tipo em toda a aplicação de uma vez |
| `functions/src/cliente/pedidos.js` grava o pedido próprio no formato legado, junto da idempotência em transação | Preservar atomicidade, dono da tentativa, nome informado e IDs |
| `montarConclusaoQrPix`, em `functions/src/services/checkoutConfiavel.js`, pode elevar o status operacional a 2 após obter o QR e manter PIX pendente | Status 2 não comprova pagamento; separar recebimento, aceite e liberação para preparo |
| Status 3 aparece como saída para delivery e pronto para retirada; status 5 representa rota | Não mapear apenas pelo número nem presumir que entrega foi concluída |
| Cozinha, `OrdersList` e edição de pedido têm escritas diretas no Firestore | Controle de revisão exige migrar todos os escritores do pedido ativado |
| `src/hooks/usePedidos.ts` consulta por data de criação; rotas têm consulta separada de pedidos aceitos | Modelar data da compra e do atendimento separadamente e testar as duas visões |
| `src/utils/dateUtils.ts` interpreta agendamento sem ano a partir do relógio atual | Adaptador deve usar evidência do registro; não alterar o ano histórico quando a tela é aberta |
| Cancelamento já tem decisão de domínio e transação em `comandosPedidos.js`/`operacoesPedidos.js` | Reaproveitar esse padrão e preservar sua auditoria/notificação idempotente |

## 3. Sequência de entregas

### P1.1 — Mapear o comportamento que precisamos preservar

Ações:

- Listar quem cria, consulta e altera pedidos: checkout, webhook, pagamentos/reconciliação, painel, cozinha, rotas, fechamento, fiscal, impressão e scripts de manutenção.
- Registrar, para cada escritor, campos alterados, origem atendida, autorização, transação e efeitos externos disparados.
- Montar a matriz PIX/débito/crédito × delivery/retirada × aceite/preparo × cancelamento/estorno × exceção. Distinguir comportamento do código e regra aprovada pelo responsável pela loja.
- Criar exemplos sintéticos de pedidos próprios, parceiros e avulsos, incluindo campos ausentes e formatos antigos. Não copiar dados pessoais de produção para fixtures.

Entregáveis propostos: `docs/p1-inventario-pedidos.md`, `docs/p1-matriz-operacional.md` e fixtures versionadas em `functions/test/fixtures/pedidos/`.

Critério de conclusão: cada transição e efeito atual tem um responsável identificado; divergências estão explícitas. A matriz é confirmada antes de ativar regras novas. Contrato e testes independentes dessas decisões podem avançar enquanto isso.

Decisões de negócio ainda necessárias: quando o PIX libera preparo; momento real do recebimento de cartão; quem pode fazer exceções; tratamento de edição após pagamento, cancelamento e estorno; existência de limite de produção por horário. Dinheiro não será acrescentado e nenhum estoque/capacidade fictício será criado.

### P1.2 — Definir e validar o contrato V2

Ações:

- Definir `schemaVersion`, `workflowVersion`, `revision`, ID interno, número de exibição e referências externas por provedor/loja/ID.
- Representar itens como objetos, com ID estável da linha, produto, nome comprado, unidade, quantidade e valores em centavos. Preservar o snapshot da compra quando o catálogo mudar.
- Definir cálculo e arredondamento no servidor. Validar soma de itens, descontos, frete e adicionais; divergências legadas não viram correções financeiras silenciosas.
- Separar estado operacional, pagamento e fiscal, mantendo IDs, valores recebidos/estornados e resultados inconclusivos.
- Definir instantes de criação e agendamento e chaves de dia em `America/Fortaleza`. Capturar a política de agenda aplicada à compra; mudar a configuração depois não reinterpreta pedidos existentes.
- Fixar em uma decisão técnica onde o contrato será persistido, quais campos antigos serão projeções e quais respostas cada cliente recebe. Proposta inicial: preservar `pedidos/{id}` como referência existente, sem uma segunda coleção autoritativa de pedidos. Dados novos internos só entram em documentos inacessíveis ao cliente ou após restringir sua leitura a uma projeção mínima.

Entregáveis propostos: `docs/contrato-pedido-v2.md`, módulo puro em `functions/src/dominio/pedidos/` e tipo V2 para os leitores. Validação de execução fica no servidor; o tipo TypeScript não substitui validação.

Critério de conclusão: schema, exemplos válidos/inválidos e representação de datas/valores documentados; testes verificam centavos, campos desconhecidos, identidade e separação dos três estados. Nenhuma nova dependência de nuvem é necessária.

### P1.3 — Construir os adaptadores e o mapa de identificadores

Ações:

- Converter em memória o contrato antigo do app e do InstaDelivery para uma leitura normalizada; manter o caminho legado quando a origem não puder ser comprovada. Ausência de `origem: app` não basta para classificar todo registro como InstaDelivery.
- Distinguir origem, modalidade e evidência de preparo/rota ao interpretar status. Dados ambíguos carregam motivo de pendência; não recebem confirmação de pagamento ou entrega inventada.
- Preservar IDs atuais, aliases, `pix_pagamento_id` e `externalReference`. Mesmo provedor + loja + ID sempre aponta para o mesmo pedido; colisões são rejeitadas de forma auditável.
- Nome, telefone, valor e data não são chaves de deduplicação. Compras legítimas repetidas do mesmo cliente continuam distintas.
- Tratar datas sem ano, arrays incompletos, totais divergentes e versão desconhecida de modo explícito. Conversão repetida deve produzir o mesmo resultado, independentemente do relógio do computador.

Critério de conclusão: ORD-08 e MIG-01 cobertos com fixtures e transações de mapeamento no emulador. Ler/adaptar não grava dados nem gera cobrança, mensagem, nota ou impressão.

### P1.4 — Centralizar as mudanças de estado e a concorrência

Ações:

- Escrever a tabela de transições de delivery e retirada segundo a matriz de P1.1: aceitar, iniciar preparo, marcar pronto, atribuir/despachar, concluir e cancelar. Incluir edição/reagendamento apenas dentro da política confirmada.
- Cada comando recebe ID de operação e revisão esperada. O servidor valida identidade, recurso, estado, campos e revisão; grava pedido, auditoria e intenção de efeito na mesma transação quando aplicável.
- Repetição do mesmo comando/conteúdo devolve o resultado já registrado. Reutilização com outro conteúdo ou revisão obsoleta gera conflito claro.
- Testar atribuição a viagens: uma viagem não pode tomar pedido já atribuído a outra. Definir atomicidade do conjunto selecionado e mensagem sobre conflitos antes de adaptar a interface.
- Fazer todos os escritores envolvidos respeitarem a mesma versão e regras, inclusive pagamentos, webhooks, cozinha e rotinas administrativas. Uma interface antiga não pode ignorar a revisão de um pedido V2.
- Manter chamadas ao Asaas, Meta, fiscal e impressora fora do callback transacional.

Critério de conclusão: ORD-06/07 e casos aplicáveis de SEC-01/03; dois computadores e uma sessão mobile disputando o mesmo pedido resultam em uma alteração válida ou sequência coerente, sem sobrescrita silenciosa. Nenhum comando local vira endpoint público nesta entrega.

### P1.5 — Adaptar leitura, busca e agenda

Ações:

- Criar seletores comuns que leem V1/V2, começando por testes locais de comparação antes de trocar os leitores.
- Manter as duas necessidades: acompanhar compras feitas hoje, inclusive para outros dias, e operar os pedidos agendados para hoje, mesmo criados dias antes. Unir resultados sem duplicar pedidos.
- Manter as regras da busca: nome e ID; hoje inclui hoje/ontem/anteontem; outra data explicitamente selecionada restringe a busca àquele dia. Registrar qual data é usada em cada consulta.
- Preservar filtros delivery/retirada/todos, retiradas do app cliente e indicação de agendamento fora do dia normal. Rotas não devem despachar antecipadamente pedidos futuros.
- Planejar consultas por dia/estado com limites, paginação, listeners e índices versionados. Evitar trazer todo o histórico para decidir quais pedidos aparecem hoje.
- Adaptar progressivamente dashboard, cozinha, rotas e respostas consumidas pelo app cliente, mantendo dados mínimos por consumidor.

Critério de conclusão: ORD-04/05/08, comparação entre leitores e testes de consulta no emulador; virada de mês/ano, 23:59 e dispositivos com outro fuso produzem a mesma data operacional. Índices e latência reais ficam sujeitos à verificação em homologação antes da ativação.

### P1.6 — Integrar escritas e consumidores com um responsável por efeito

Esta entrega depende do inventário, contrato, adaptadores, comandos e leitores anteriores. A implementação pode ser preparada localmente; ativação exige os critérios de publicação da seção 5.

Ações:

- Escolher primeiro uma coorte explícita de pedidos novos do app cliente. Pedidos antigos e InstaDelivery mantêm o processamento atual até a transição planejada.
- Registrar no pedido a versão de processamento e os responsáveis por pagamento, mensagem, impressão e fiscal. A configuração global decide apenas novas adesões; trabalhos já iniciados mantêm seu responsável.
- Publicar leitores compatíveis antes de habilitar novas escritas. Para pedidos ativados, somente o backend controla o modelo e os campos antigos derivados; atualizações críticas de compatibilidade ocorrem na mesma transação.
- Adaptar cada escritor listado em P1.1 antes de permitir sua atuação em V2. Regras/API impedem alteração direta por cliente antigo nos pedidos ativados. Não manter dois escritores independentes tentando sincronizar estados.
- Preservar idempotência do checkout e vínculo exato do PIX. Se a integração tocar o caminho financeiro, executar os testes CHK/PAY correspondentes, incluindo webhook antes do QR, estorno seguido de evento antigo e resposta perdida.
- Testar os gatilhos existentes: salvar campos de versão, importar ou reconstruir projeção não deve emitir novo recibo, cobrança, nota nem segunda impressão. Uma flag só funciona se todos os consumidores relevantes a respeitarem.
- Validar app cliente, recibo do desktop e fiscal com contratos simulados. Leitura local do desktop não comprova impressão física ou compatibilidade do executável instalado.

Critério de conclusão: leituras/escritas consistentes no emulador e consumidores simulados; efeitos contados e únicos; usuário antigo não contorna revisão. Fila financeira nova e resiliência completa de chat/impressão continuam P2/P3.

### P1.7 — Ensaiar conversão, recuperação e ativação

Ações:

- Criar simulação de conversão com contagens por origem/estado, comparação de centavos, IDs, agenda e pendências. Executar primeiro com dados sintéticos; usar dados reais posteriormente apenas em ambiente/acesso apropriados, sem expô-los no CI.
- Caso seja necessário enriquecer histórico, preparar lotes limitados com checkpoint, repetição idempotente e interrupção segura. Não exigir conversão de todo o histórico para ler pedidos antigos.
- Injetar falha antes/depois do commit, resposta perdida, evento repetido, atualização antiga, reinício e projeção atrasada. Verificar registros persistidos e efeitos externos simulados, além das respostas HTTP.
- Exercitar MIG-02 e reversão MIG-04: interromper adesão de pedidos novos, manter leitura V2 e concluir pedidos/trabalhos já iniciados com seu responsável. Não apagar campos novos ou recriar cobranças para voltar de versão.
- Preparar piloto por canal/coorte com métricas e critérios de parada. Ativar somente após a revisão de publicação e compatibilidade operacional.

Critério de conclusão da preparação: ORD-01 a ORD-08 e MIG-01/02 verdes para o escopo entregue; testes de regressão CHK/PAY e reversão aplicáveis aprovados; limitações registradas. ORD-02 exercita cupom concorrente; capacidade/estoque limitado só será testado como regra de venda se existir política confirmada.

Critério de conclusão da P1: evidência também de homologação/publicação, leituras coerentes nos clientes compatíveis e piloto observado. Uma suíte local verde não conclui a etapa inteira.

## 4. Primeiro pacote de implementação

Começar por **P1.1 + P1.2 + adaptador de leitura de P1.3**. Esse pacote entrega inventário inicial, matriz com dúvidas explicitadas, contrato V2, exemplos sintéticos e normalização pura de pedidos antigos, sem ativar novas escritas.

Os primeiros testes devem provar:

1. Um pedido PIX com QR gerado e status operacional 2 continua sem pagamento confirmado.
2. Status 3 de retirada e delivery não recebe a mesma interpretação automaticamente.
3. Nome digitado na compra permanece no snapshot e dois pedidos do mesmo telefone continuam distintos.
4. Centavos, IDs e referências financeiras não mudam na adaptação.
5. Compra antiga para hoje entra na data operacional correta; compra de hoje para depois permanece no acompanhamento de hoje.
6. Dados insuficientes e datas ambíguas geram diagnóstico explícito, sem estado financeiro inventado.
7. O adaptador pode ser executado repetidamente e não dispara nenhum efeito externo.

Esses testes cobrem recortes de ORD/MIG; não representam aprovação integral dessas famílias. Cada pacote posterior amplia a evidência no mesmo harness.

## 5. Publicação, observação e reversão

Antes de ativar a primeira coorte, retomar os controles P0 adiados que protegem a superfície alterada: identidade/autorização, restrição de dados lidos, testes obrigatórios e verificação CI-03 do artefato, regras, IAM, índices e recursos. Não marcar a revisão ampla de P0 como concluída apenas por conferir o recorte de P1.

Preparar um relatório por release: commit testado, versões compatíveis dos clientes, resultados de teste, configuração da coorte, recursos, plano de reversão e responsáveis pela observação. O CI já existente deve executar os testes adicionados; a publicação usa o mesmo artefato validado.

Observar: conflitos de revisão, pedidos ausentes/duplicados entre visões, divergência financeira, referências não resolvidas, efeitos duplicados, idade da projeção, falhas/latência e leituras/escritas por pedido. Usar IDs de correlação e códigos de motivo, sem payload pessoal em logs. Comparar o custo incremental com o orçamento antes de ampliar o piloto.

Duplicação, confirmação falsa, perda de pedido confirmado, exposição indevida ou conflito de responsável interrompem a expansão e exigem tratamento. O caminho de reversão conserva os pedidos recebidos e seus vínculos; pagamentos ou trabalhos inconclusivos continuam acompanhados.

O PC da loja só é necessário na validação final do consumidor desktop: conferir binário/configuração em uso, compatibilidade do recibo e impressão física coordenada. Desenvolvimento do contrato, emulador, impressora simulada e plano de migração independem desse acesso.

## 6. Relação com as fases seguintes

Depois da P1 comprovada, P2 organiza recepção durável, inbox/outbox, filas, leases e recuperação do PIX sobre esse contrato. P3 completa chat e operação/desktop; P4 mede capacidade, custo e recuperação; P6 realiza a transferência e o corte. A preparação de P5 foi antecipada por prioridade do usuário: o [plano fiscal](plano-acoes-fiscal-prioritario.md) entrega suas dependências mínimas sem exigir que P1–P4 estejam integralmente concluídas, mantendo os gates fiscais e de publicação.

A carga completa de 600 pedidos/dia e a saída definitiva do InstaDelivery continuam sujeitas aos gates dessas fases. Este roteiro define o trabalho seguinte; não publica código, migra histórico ou autoriza efeitos financeiros/fiscais reais.
