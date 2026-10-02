# Plano técnico — sistema próprio da Fábrica

Versão 1 — atualizada em 09/09/2026. Plano com implementação parcial; somente os recortes com evidência abaixo estão entregues.

## 1. Escopo e decisões

O destino é operar sem InstaDelivery. A migração mantém a operação existente enquanto cada dependência é substituída e verificada. Novas regras de negócio não dependerão do formato ou da disponibilidade do InstaDelivery.

Premissas confirmadas pelo usuário:

- Dois operadores em computadores, com terceiro acesso ocasional no celular.
- Aproximadamente 200 pedidos/dia, chegando a 600 em datas especiais; navegação, chat e checkout concorrentes.
- R$ 200/mês apenas de infraestrutura. Meta de projeto: operação normal até R$ 140 e margem de R$ 60. Não é estimativa de fatura validada nem teto automático de cobrança.
- WhatsApp, tarifas de pagamento, Eficiência Fiscal e assinatura do InstaDelivery durante a transição são custos separados.
- Segurança, confirmação correta e recuperação de falhas têm prioridade sobre automações secundárias.

A etapa documental inicial não autorizava publicação. Posteriormente, o usuário autorizou publicar o recorte de P0 e, em 09/09/2026, autorizou explicitamente o papel de leitura por regras para o agente gerenciado do Storage. A publicação foi conferida nessa data: APIs administrativas do recorte exigem sessão Firebase da equipe e não mantêm a chave compartilhada vinculada; regras e permissão do Storage foram publicadas. Isso não conclui P0 nem autoriza aumento de cota, emissão fiscal, cobrança, envio de mensagens de teste ou migração de dados. Evidências: [publicação P0](C:/Users/vgmds/factory-dashboard/docs/publicacao-p0-2026-09-09.md).

Decisão de segurança do plano: cada operador terá conta individual, sem senha compartilhada. Isso é requisito a implementar, não descrição confirmada dos acessos atuais.

Complemento obrigatório: [plano de testes automatizados](C:/Users/vgmds/factory-dashboard/docs/plano-testes-arquitetura.md). IDs de testes deste documento se referem a ele.

Decisão de sequência em 22/09/2026: o usuário adiou o fechamento de proteção de branch/CI-03, a revisão ampla da exposição de dados do app cliente e a organização das contas/permissões da equipe. Esses itens continuam pendentes em P0. O próximo trabalho planejado é a preparação local de P1, conforme o [plano de ações do modelo próprio de pedidos](plano-acoes-p1.md), começando pelo inventário, contrato e adaptadores sem ativar novas escritas. Publicação e migração operacional mantêm os critérios de segurança e compatibilidade deste plano; P0 não foi declarado concluído.

Prioridade posterior na mesma data: o usuário pediu antecipar a emissão de notas. A preparação fiscal passa à frente da migração ampla de P1, conforme o [plano fiscal prioritário](plano-acoes-fiscal-prioritario.md). O adaptador atual permite desenvolver essa frente com pedidos existentes; ativação exige os requisitos mínimos de consistência, autorização e recuperação, FIS-01 a FIS-04 e conferência da publicação. O usuário informou que ainda não confirmou com a EF o uso independente da conta e a homologação. Emissão continua desabilitada, sem promessa de disponibilidade absoluta.

## 2. Estado observado e riscos prioritários

Revisão local e verificação direcionada de produção em 09/09/2026. A conferência cobriu seis funções, suas revisões/tráfego, regras Firestore/Storage, o papel do agente do Storage e o índice do Hosting. Não é auditoria integral do projeto.

| Área | Evidência | Decisão |
| --- | --- | --- |
| API administrativa | `chat`, `conversas`, `clientes`, `configuracoes` e `pendencias` publicados com sessão Firebase revogável + staff; chave antiga desvinculada. Rejeição sem sessão/token inválido e CORS conferidos nos dois endereços das APIs | Inventariar consumidores restantes antes de revogar o segredo antigo; ampliar autorização por papel e demais superfícies; testar operação autenticada completa |
| Firestore | Regras publicadas rejeitam staff inativo e bloqueiam cancelamento/reabertura/exclusão direta de pedidos; preservam criação avulsa restrita e atualizações operacionais legadas. Cliente ainda lê seu documento inteiro | Autorizar por ação/campo; demais comandos críticos via backend; projeções mínimas para leitura |
| Storage | Regras publicadas exigem equipe ativa para mídia privada/uploads; catálogo permanece público. Papel de consulta Firestore do agente gerenciado aplicado com autorização explícita | Revisar ACLs e URLs antigas com tokens de download; regras não invalidam automaticamente esses links |
| Fiscal | API fiscal já verifica staff ativo e revogação; emissão permanece bloqueada | Reutilizar padrão de autenticação, acrescentar permissões específicas; emissão depende da etapa fiscal |
| Pedidos | `src/types/Pedido.ts` e checkout mantêm estrutura herdada do InstaDelivery | Introduzir modelo interno versionado e adaptadores, preservando IDs e vínculos anteriores |
| Checkout/PIX | Há helpers de idempotência, transações, persistência e reconciliação | Preservar proteções e provar integração concorrente, não substituir por simples retry |
| Corrida de PIX | O recorte local P2 preserva `RECEIVED`/estorno quando o webhook chega antes da persistência do QR; há regressões unitárias | Validar em homologação com o provedor e garantir que nenhuma publicação reintroduza regressão. Não é comprovação de ocorrência ou correção publicada em produção |
| Outbox do chat | `functions/src/triggers/outbox.js` usa estado `enviando` como trava sem expiração; algumas falhas deixam resultado incerto | Lease recuperável, reconciliação e estado inconclusivo; não reenviar cegamente |
| Notificação de cancelamento | Fila/worker publicados na entrega anterior; processador Meta atualizado nesta entrega. Emulador comprova job único, disputa do worker, callback de falha antes/depois do ID e pendência sem reenvio | Acompanhar eventos reais sem disparar mensagens de teste. Aceite não é entrega; timeout/5xx continua inconclusivo |
| Capacidade | Incidente de 03/09: cota regional compartilhada de 20 vCPUs; em 15/09 o pedido de 30 vCPUs foi negado e as cinco consultas públicas entraram em CPU fracionada, individualmente verificadas | Observar latência/429/503; manter perfil opt-in e medir antes de consolidar consultas ou expandir o rollout |
| Qualidade | 175 testes unitários e 16 cenários no Emulator Suite aprovados localmente; em 22/09 o workflow de painel e backend executou com sucesso no GitHub público e privado para o recorte então existente. O verificador operacional de publicação é um recorte de CI-03 | Evoluir lint e proteger a branch; publicar o novo recorte no CI quando houver release; completar CI-03, contratos, E2E e carga |

Detalhes do incidente e do ajuste: [capacidade](C:/Users/vgmds/factory-dashboard/docs/capacidade-checkout.md). Em 14/09 o canário fracionado foi bloqueado duas vezes pela cota e a revisão anterior permaneceu em tráfego. Em 15/09, com folga medida, o canário e as outras quatro consultas públicas foram publicados e verificados; a amostra final estimou 11,833/20 vCPUs em instâncias recentes. O perfil fracionado continua opt-in e não é ainda o padrão definitivo da arquitetura.

Atualização de qualidade em 22/09: a [verificação remota do CI](ci-p0-preparacao-2026-09-22.md) passou em ambos os repositórios para o mesmo commit; isso comprova execução dos jobs de código e emulador, sem concluir CI-03 nem P0.

Atualização fiscal em 23/09: operação única de homologação, snapshot/hash imutáveis, detecção de pedido/vínculo alterado, evento auditável, negação direta por regras e capacidades críticas de emissão/cancelamento foram implementados localmente. Um contrato sintético e sem rede passou a montar/validar pré-venda e autorização com centavos e referências exatos, bloqueando taxas não definidas e dados tributários inventados. Envio permanece bloqueado. Validação: 60 testes fiscais, 175 unitários totais, lint de 56 arquivos e 16 cenários no emulador. Contrato independente e homologação da EF continuam pendentes; ver [plano fiscal prioritário](plano-acoes-fiscal-prioritario.md).

O app cliente está em `C:/Users/vgmds/fabrica-app-cliente` (Next.js, com serviço SSR já identificado na auditoria anterior). Não assumir que todo o app é estático nem apagar SSR para economizar. O repositório/versão efetiva do desktop em uso no outro PC precisa ser identificado na etapa P0; ele não foi auditado integralmente aqui.

Atualização P0 de 09/09: [inventário do desktop](C:/Users/vgmds/factory-dashboard/docs/inventario-desktop-p0.md) localizou fonte/pacote 1.2.3 em C# e demonstrou acesso direto ao Firestore por credencial Google, não pela chave do painel. O usuário confirmou a versão 1.2.3 na loja; hashes do binário instalado e IAM efetivo continuam pendentes. Foi adicionada triagem local de fontes/pacote com sete testes; total unitário agora 131 aprovados. Nenhuma credencial foi revogada ou nova versão do robô instalada nesta auditoria.

## 3. Arquitetura-alvo

### 3.1 Organização do código e execução

Manter Firebase/Google Cloud e Firestore. Backend modular com regras compartilhadas e poucos serviços, separados quando precisarem de isolamento de recursos ou credenciais. Sem Kubernetes, Redis, segundo banco principal ou implantação multirregional nesta fase.

| Unidade lógica | Responsabilidade | Limite de confiança/capacidade |
| --- | --- | --- |
| Web/CDN e catálogo | Páginas, imagens e projeção pública versionada do cardápio; SSR apenas onde necessário | Nunca servir resposta privada em cache público; invalidar catálogo após alteração |
| API do núcleo | Checkout, consultas autorizadas e comandos da operação; prévia de entrega/agenda agregada | Identidade + autorização + validação; não aguardar chat, impressão ou fiscal para persistir pedido |
| Entrada de integrações | Autenticar Meta/Asaas/InstaDelivery, validar formato, registrar inbox durável, responder | Sem transcodificar mídia nem processar todo o fluxo no webhook; cada provedor mantém sua validação própria |
| Worker de pagamentos | Criar/consultar cobranças, aplicar eventos e reconciliar | Fila e conta de serviço próprias; credenciais financeiras não vão ao navegador nem ao worker de chat |
| Worker de comunicação | Envio, recebimento processado, mídia e notificações | Concorrência entre conversas; sequência controlada dentro da conversa; respeitar limites do provedor |
| Worker fiscal/auxiliares | Fiscal isolado por permissão; tarefas não urgentes limitadas | Segredo fiscal apenas no componente autorizado; relatórios não disputam sem limite com pagamentos |
| Agente desktop | Consumir trabalhos de impressão e comunicar estado | Identidade de dispositivo revogável, sem chave de administrador do Firebase ou do painel |

Unidades são limites de arquitetura, não obrigação de criar uma função por ação. A divisão física e valores de CPU/concorrência serão fixados por medição em P4. Configuração publicada fica versionada, com verificação de drift de recursos, IAM, regras e índices. Não mudar o projeto/região atual apenas para contornar cota.

### 3.2 Persistência e efeitos externos

Fluxo: requisição autenticada → validações → transação de pedido + idempotência + eventos de saída → confirmação de recebimento → despacho durável → filas → processadores → estados/projeções.

- Firestore é a fonte de verdade. A fila transporta trabalho, não é o único registro de que ele existe.
- Publicar uma tarefa e escrever no Firestore não é uma transação única: usar outbox transacional, nomes determinísticos e um varredor de recuperação. Falha antes/depois do enqueue deve ser segura.
- Consumidores são idempotentes. Cada efeito tem chave estável, estado, tentativas, `nextAttemptAt`, lease, identificador de execução e referência do provedor quando conhecida.
- Lease expirado permite recuperação; token de execução/fencing impede worker antigo de confirmar sobre execução mais nova. Isso sozinho não impede efeito duplicado num provedor: o adaptador também precisa de idempotência ou reconciliação.
- Cloud Tasks pode repetir e reordenar entregas. Backoff, limite de concorrência e tentativas são por fila. Registro próprio de falhas/pendências e varredor detectam tarefas esgotadas ou ausentes; não depender de uma suposta dead-letter queue automática.
- Após tentativas esgotadas, conservar a pendência e alertar. Não apagar trabalho financeiro inconclusivo por TTL.
- Chamadas externas ficam fora das transações do Firestore, que podem executar novamente. Nunca emitir cobrança, mensagem ou nota de dentro do callback transacional.
- Timeout de uma escrita externa é resultado desconhecido, não prova de fracasso. Consultar por referência exata; se não houver contrato seguro de consulta/idempotência, exigir conferência, sem repetição cega.

## 4. Modelo interno e invariantes

### 4.1 Contrato versionado

Modelo V2, sem forçar conversão imediata de todo o histórico:

- `schemaVersion`, `workflowVersion`, `revision`, identificador interno estável e número de exibição separado.
- `origin`: app, pdv ou instadelivery; referência externa com provedor + estabelecimento + ID. Mapeamento inequívoco e verificado por transação.
- Identidade do proprietário/sessão e snapshot dos dados informados na compra. Nome digitado no checkout não é substituído pelo nome encontrado por telefone.
- Itens como objetos (produto, nome, quantidade, unidade, preço em centavos, total), não arrays paralelos como contrato novo.
- Totais em centavos: subtotal, desconto, frete, adicionais e total. Política de arredondamento única no servidor e testada; taxas legais/comerciais não são inventadas nesta migração.
- `createdAt` e `scheduledAt` como instantes, com data operacional derivada em `America/Fortaleza`. Horários e limites de agendamento são validados no backend.
- Tipo de atendimento explícito: delivery ou retirada. Status operacional separado de pagamento e fiscal.
- Estado operacional: recebido → aceito → em preparo → pronto → em entrega (delivery) → concluído; retirada pode ir de pronto a concluído. Cancelamento tem comando próprio e efeitos financeiros separados.
- Pagamento: criação pendente, aguardando, confirmado, falha definitiva, inconclusivo e estados de estorno; manter valores recebidos/estornados e IDs. Evento antigo não reverte um estorno válido.
- Fiscal: não preparado, pendente, em processamento, autorizado, rejeitado, inconclusivo, cancelado; sem inferir autorização pelo pagamento.
- Auditoria append-only para o operador: ação, ator, instante, revisão e correlação. Cliente não altera nem apaga auditoria; acesso administrativo à nuvem também deve ser auditável.

Transições permitidas são uma tabela de domínio, não números de status do parceiro. Recebido não significa pago; pago não significa entregue ou fiscalmente autorizado.

Entrada obrigatória de P1/P2: registrar e validar com o responsável pela loja a matriz meio de pagamento × momento de aceitar/preparar × cancelamento/estorno × permissão de exceção. Partir do comportamento atual explicitamente inventariado; não inventar aprovação manual/automática durante a migração. Checkout local hoje aceita PIX, débito e crédito; dinheiro não será acrescentado por este plano. Testes de transição usam essa mesma matriz como resultado esperado. Definir também se existe capacidade/estoque limitado por horário e a política de liberação da reserva; sem limite de negócio confirmado, não introduzir contadores que recusem vendas.

### 4.2 Invariantes de aceite

1. Confirmar recebimento somente depois da gravação durável. Cache local/offline não é confirmação do servidor.
2. Mesma chave de tentativa + mesma sessão + mesmo conteúdo → mesmo pedido; conteúdo/dono diferente → rejeição. Tentativas legitimamente novas do mesmo cliente continuam permitidas.
3. Preço, disponibilidade, bloqueio, cupom e agenda vêm do servidor. Se houver limite de capacidade/estoque, reserva e consumo são transacionais e liberados de forma idempotente; não criar um estoque fictício onde o negócio não o usa.
4. Todos os comandos críticos verificam versão esperada; dois operadores não despacham o mesmo pedido para viagens diferentes nem sobrescrevem alterações silenciosamente.
5. Pedido confirmado tem trabalho pendente rastreável ou conclusão. Estado `processando` indefinido é incidente.
6. PIX próprio exige cobrança e pedido exatos, conta correta e valor consistente. Nome, telefone, data ou valor semelhantes nunca autorizam vínculo automático no fluxo novo.
7. Vigência da cobrança acompanha a regra de agendamento capturada na compra e o contrato real do Asaas. Alterar a configuração depois não invalida silenciosamente cobranças abertas. Pagamento tardio permanece conciliável e, se houver conflito operacional, vira pendência visível.
8. Chat/fiscal/desktop indisponíveis não apagam o pedido. Liberação para produção obedece à política de pagamento do negócio.
9. Pedidos criados ontem e agendados para hoje entram na operação/rotas de hoje; criados hoje para depois aparecem no acompanhamento de hoje com marcação de agendamento, sem despacho antecipado implícito.

## 5. Matriz de acesso e proteção de dados

Permissões são capacidades explícitas. Um operador pode acumular perfis, mas nunca recebê-los por autoedição no navegador. Backend usa Admin SDK, portanto deve aplicar autorização própria; regras do Firestore não protegem operações feitas pelo Admin SDK.

Implementação de transição já preparada no backend: `staff/{uid}` aceita `papel` ou `papeis`, `permissoes` adicionais e `permissoesEstritas`. Os valores só são lidos do documento de equipe pelo servidor, nunca do pedido HTTP. Uma conta sem papel continua como `operador_legado` temporariamente para não parar a loja; esse valor é interno — tentativas explícitas de gravar `operador_legado` ou `"*"` em permissões não concedem acesso. Antes de marcar uma conta como estrita, o gestor precisa escolher os papéis dela e testar suas telas; até lá, uma capacidade ausente é registrada na auditoria como `observacao`, não bloqueia a operação. A primeira aplicação é nos comandos de bloquear/liberar cliente, confirmar PIX manualmente e cancelar pedido. A auditoria registra ator, papéis, capacidade e decisão. Não ativar `permissoesEstritas` globalmente nem em uma conta em produção sem esse cadastro e o teste de acesso.

Contas de serviço distintas separam segredos e invocação; não presumir isolamento automático por coleção via IAM no mesmo Firestore. Escopos de negócio, chamadas internas e campos continuam validados pelo backend e pelos testes. Qualquer necessidade futura de isolamento mais forte exige desenho e custo explícitos.

| Identidade | Leitura permitida | Comandos permitidos | Negado por padrão |
| --- | --- | --- | --- |
| Visitante sem sessão | Catálogo e informações públicas | Iniciar sessão limitada/identificação | Pedidos, cadastros e arquivos privados |
| Cliente/visitante com sessão | Projeção dos próprios pedidos e seus dados autorizados | Criar pedido; solicitar alteração dentro da política | Pedido de terceiro, custo/fiscal interno, marcar pago, definir preço/status |
| Atendimento | Pedidos e conversas necessários à operação | Aceitar, preparar/despachar conforme função, atender e solicitar cancelamento | Gerir acessos, confirmar PIX por conta própria, emitir nota sem permissão |
| Cozinha | Itens, observações operacionais e horários | Alterar preparo autorizado | CPF, conversa, credenciais e financeiro completo |
| Motoboy, caso receba acesso | Somente entregas atribuídas e contato/endereço necessários | Atualizar sua entrega conforme política | Outras entregas, chat geral, financeiro da loja |
| Gestor | Gestão e auditoria autorizadas | Configurações, usuários e ações sensíveis específicas | Ignorar validações financeiras ou apagar trilha de auditoria |
| Fiscal | Dados necessários à emissão | Conferir/emitir/cancelar conforme capacidade explícita | Alterar pagamento ou operar outras áreas apenas por ser fiscal |
| Desktop | Trabalhos e recibos atribuídos ao dispositivo | Reivindicar trabalho, registrar resultado/saúde | Listar clientes/conversas, modificar valores, usar credenciais administrativas |
| Serviços internos | Dados necessários ao componente | Comandos internos definidos | Endpoint interno anônimo e segredo de outro componente |

Controles obrigatórios:

- Identidade individual, staff ativo, revogação, MFA de gestor e autorização por recurso/ação. Desativação verificada em operações críticas; não depender só de claims antigos.
- Migrar chave compartilhada com inventário de dashboard/desktop/consumidores. Não manter fallback inseguro como solução permanente; rollback não pode reabrir a vulnerabilidade.
- Sessão de visitante não prova posse do telefone. Não mostrar cadastro/histórico/endereço anterior antes de verificação; não confiar em UID, dono ou role enviados no corpo.
- Projeções separadas para cliente/cozinha; ocultar campos na UI não restringe leitura do documento completo. Projeções são derivadas e reconstruíveis, com revisão para detectar atraso.
- Catálogo público em cache; respostas privadas `no-store`. Arquivos privados protegidos, URLs de duração limitada quando necessárias, sem tokens duradouros públicos de mídia; revisar permissões do bucket e links antigos.
- Auth, App Check e rate limits por identidade/dispositivo/IP como camadas complementares. Nem CORS, App Check, ID difícil de adivinhar ou inspeção bloqueada são autorização.
- Webhooks usam assinatura/token do provedor, validação de conta/loja e deduplicação; não exigir App Check de integrações legítimas. Internos usam IAM/OIDC com audiência correta.
- HTTPS, validação de tamanho/schema, proteção contra XSS e upload malicioso, restrição de destinos de download de mídia (SSRF), limites de mídia e tentativas de OTP/cupom. Cookies, se adotados, exigem proteção CSRF.
- Segredos no Secret Manager, acesso mínimo por serviço, sem chaves administrativas no desktop/cliente/CI. Valores de `VITE_*`/`NEXT_PUBLIC_*` são públicos; a chave de identificação Firebase não equivale ao segredo administrativo do painel.
- Logs/alertas/artefatos de teste sem tokens, CPF, conversa ou endereço completo. Minimizar retenção e acesso ao cache offline; no celular, não manter dados sensíveis persistentemente por padrão. Logout/troca de usuário não pode reutilizar o cache de outra conta.

## 6. Capacidade, custo e objetivos verificáveis

### 6.1 Medição e orçamento

P0 levanta fatura por serviço/SKU, instâncias mínimas, leituras/listeners, SSR, saída de imagens/mídia, logs, backups, builds e armazenamento de artefatos. Custos de homologação, restauração e testes em nuvem entram nos R$ 200, não são escondidos fora da estimativa.

Simular mês com dias efetivamente abertos: `200 × dias normais + 600 × dias especiais`; acrescentar sessões sem compra, mensagens por conversa, reconexões, reprocessamentos e retenção. Medir também o cenário temporário de coexistência de versões. Não projetar a conta apenas pelo número de pedidos.

Alertas propostos: realizado em R$ 100/150/180 e previsão acima de R$ 200. Orçamento de nuvem não corta gastos automaticamente; não desligar checkout/PIX ao atingir valor. Excesso previsto bloqueia expansão e exige revisão/decisão, sem apagar ou abandonar pedidos.

Sem novos custos fixos antes de cotação. Poucas consultas agregadas, catálogo versionado em cache, índices, paginação e subscriptions limitadas. Não consultar todo o histórico de um cliente dentro de cada novo checkout; usar agregados consistentes ou cálculo assíncrono quando não crítico.

Dimensionar soma de CPU/memória das unidades, SSR, triggers, startup boost e coexistência de revisões; limites de instâncias não são reserva de cota nem teto financeiro rígido. Definir valores concretos somente após teste. Separar filas protege prioridades, mas não cria isolamento de cota por si só.

### 6.2 Metas iniciais, não SLA comprovado

| Indicador | Meta de aceite inicial | Condição/medição |
| --- | --- | --- |
| Consistência | Zero duplicatas indevidas, confirmação falsa, acessos indevidos ou perdas de pedidos confirmados nos testes | Conferência automática do banco e dos registros do provedor simulado; não apenas códigos HTTP |
| Persistência de checkout | p95 até 3 s, p99 até 8 s | API de registro durável, incluindo cold starts; tempo do Asaas/QR separado |
| Webhook persistido | p95 até 2 s, p99 até 5 s | Da entrada válida ao ACK após gravação; teste sob carga |
| Atualização operacional | p95 até 5 s | Do commit à exibição no dashboard conectado; avisar desconexão/atraso |
| Confirmação PIX por evento | p95 até 30 s após evento válido recebido | Backend/fornecedor disponíveis; monitorar tempo bancário separadamente |
| Recuperação por consulta | Iniciar reconciliação em até 5 min após pendência detectável | Consulta disponível; backlog e orçamento da API controlados |
| Disponibilidade interna | Objetivo inicial de 99,9% em janela móvel de 30 dias | Tentativas legítimas no ingresso; 429 de capacidade, 5xx e timeout contam como falha. Rejeições de dados/autorização não contam como sucesso nem falha de infraestrutura |
| Corrupção/exclusão acidental | Meta RPO até 5 min e RTO até 60 min, a demonstrar | Exige PITR, acesso ao projeto/região e ensaio de restauração. Não é garantia para desastre regional |

O indicador de disponibilidade ainda não tem baseline; não anunciar esse percentual como resultado atual. Manter separadamente sucesso final do checkout, disponibilidade de Asaas/Meta/EF e tempo de recuperação. Falhas de parceiros não podem ser escondidas do relatório ponta a ponta.

Homologação: 3 sessões de operadores, 100 clientes navegando, rajada de 50 checkouts independentes e 20 conversas ativas. Perfil detalhado, limites de segurança e ensaios estão no plano de testes. São hipóteses de carga a validar, não capacidade já garantida.

## 7. Migração por etapas e gates

P0 tem um recorte implementado e publicado; P2 tem duas regressões locais preparadas. As demais entregas continuam pendentes. Nenhuma etapa inteira deve ser tratada como concluída sem os respectivos gates.

| Etapa | Entregas e ordem | Gate obrigatório | Reversão segura |
| --- | --- | --- | --- |
| P0 — Baseline e contenção | Inventariar consumidores, produção/versões, acessos e custos; conferir vulnerabilidades locais em configuração publicada; montar harness seguro e CI; corrigir auth/regras prioritárias; programar release independente de runtime antes do descomissionamento | SEC-01 a SEC-08 e CI-01/02/03; login de cliente jamais concede staff; credenciais do browser desativadas após migração coordenada | Versão anterior já corrigida de segurança; não restaurar chave compartilhada/regras abertas |
| P1 — Domínio próprio | Modelo V2, adaptador V1/InstaDelivery, IDs externos, estados/revisões e consultas por agenda; novas escritas pelo backend | ORD-01 a ORD-08, MIG-01/02; leitura consistente em dashboard, cliente, cozinha e desktop compatível | Leitores compatíveis V1/V2; interromper novas ativações, preservar novos dados |
| P2 — Recepção e pagamentos | Checkout curto/durável, inbox/outbox, filas, leases, recuperação e vínculo exato de PIX | CHK-01 a CHK-05, PAY-01 a PAY-07, JOB-01 a JOB-04; falhas injetadas sem efeitos indevidos | Suspender consumidor novo por coorte/efeito, transferir ownership de forma auditada; nenhuma recriação de cobrança |
| P3 — Operação independente | Chat resiliente, três sessões, cozinha/retirada/rotas, impressão durável e fechamento | CHAT-01 a CHAT-04, OPS-01 a OPS-04 e E2E-01/02; computador reiniciado não perde trabalhos | Fila e registros preservados; desktop anterior só se compatível, sem reimpressão automática indiscriminada |
| P4 — Capacidade e recuperação | Otimizar consultas/recursos, carga, índices reais, backup/PITR, restauração, custos e runtime suportado | PERF-01 a PERF-04, DR-01/02 e CI-03; projeção normal ≤ R$ 140 e mês de pico ≤ R$ 200, ou revisão explícita | Voltar artefato/configuração medidos, mantendo correções de segurança e folga de cota |
| P5 — Fiscal direto | Contrato EF independente, mapeamentos conferidos, emissão/consulta/cancelamento/contingência e reconciliação | FIS-01 a FIS-04 e validação contábil/provedor; nenhum resultado incerto repetido às cegas | Suspender emissão automática; preservar referências/XML e consultar situação, nunca reemitir histórico |
| P6 — Transferência e corte | Migrar tráfego por coortes/canais, observar, exportar/conferir histórico, encerrar dependências e credenciais | MIG-03 a MIG-05 e checklist abaixo; decisão final do responsável pela loja | Parar expansão para novos pedidos; concluir os já aceitos no sistema proprietário, sem duplicá-los no parceiro |

As correções de segurança não esperam todas as fases ficarem prontas. A prioridade de 22/09 antecipa a preparação de P5 usando o adaptador atual e implementando os requisitos mínimos de P1/P2 necessários à emissão; não exige terminar todas as entregas dessas etapas antes de desenvolver fiscal. Os gates fiscais permanecem obrigatórios e o cancelamento do InstaDelivery depende deles. Não mudar runtime, modelo, permissões e fluxo financeiro num único deploy.

**Situação de P0 em 09/09/2026:** o painel envia token Firebase; APIs migradas exigem token não revogado e `staff/{uid}` existente e não inativo. A conferência identificou e corrigiu publicação parcial da entrega anterior. `secrets: []` explícito remove vínculos legados que a omissão preservava na plataforma. As regras protegem cancelamento, pedidos cancelados e exclusão; a exceção de criação avulsa restrita do motoboy permanece. O cancelamento do App Cliente em status 1/2 é transacional/idempotente e grava auditoria + job; retorno Meta distingue aceite, entrega/leitura e falha. Testes: 124 unitários e 11 cenários em emulador. A verificação operacional das seis funções, revisões, regras, papel Storage, Hosting e probes negativos passou às 16:43 de Fortaleza. Nenhuma mensagem/pedido/cobrança foi criada para esse smoke. A execução remota do CI, os demais gates de P0 e a revogação do segredo antigo continuam pendentes; nenhum segredo foi apagado.

**Primeiro recorte local de P2 em 04/09/2026:** a conclusão do QR PIX deixou de gravar `PENDING` sobre um `RECEIVED` ou estorno já persistido pelo webhook. A transação acrescenta o QR e preserva o estado financeiro/reagendamento existente; dois testes cobrem QR tardio e inicialização normal. Ainda falta o teste de integração com transações/rede e a validação em homologação antes de qualquer publicação.

**Segundo recorte de P2, publicado em 28/09/2026:** o receptor InstaDelivery passou a confirmar recebimento somente após gravar uma inbox durável e idempotente; gatilho e varredor processam/recuperam o pedido sem depender da duração do HTTP. Pedidos próprios PIX em status 1 ficam visíveis numa área separada e a confirmação exata promove 1 → 2 na mesma transação, sem promover pedidos legados nem reabrir cancelamentos. Pedidos novos recebem `data_operacional`, e consultas combinam criação, operação aberta e data agendada para não ocultar vendas feitas em outro dia. A inbox foi negada pelas regras ao navegador, equipe e desktop. Evidência: 181 unitários, 16 cenários no Emulator Suite, lint e build aprovados; oito funções `ACTIVE` em Node 24, probes 401/204 e Hosting idêntico ao build. Nenhum pedido/pagamento/mensagem real foi criado na verificação. Processamento concorrente, tráfego real e homologação/carga ainda precisam de acompanhamento antes de declarar P2 concluída. Ver [evidência da publicação](C:/Users/vgmds/factory-dashboard/docs/publicacao-p2-2026-09-28.md).

CI-03 é obrigatório em todo deploy desde P0, não apenas em P4. P4 faz a aferição completa de capacidade; toda publicação anterior de fluxo financeiro também precisa dos testes críticos correspondentes, incluindo carga concorrente mínima antes de ampliar tráfego. Prioridades de teste T0/T1 não são fases P0–P6.

### 7.1 Compatibilidade e dono do processamento

- Preservar IDs e referências financeiras já existentes. Novo identificador interno não altera `externalReference` de uma cobrança antiga. Manter aliases pesquisáveis e snapshots de origem.
- Um escritor autoritativo por pedido/efeito e versão de workflow. Registrar quem controla pagamento, notificação, impressão e fiscal durante a convivência. Não basta uma flag global trocada enquanto jobs antigos ainda executam.
- Backfill em lotes limitados, com dry-run, checkpoint, contagem, comparação financeira e execução idempotente. Enriquecer sem apagar os campos necessários a clientes/desktop antigos.
- Importação de histórico não dispara cobrança, nota, mensagem ou impressão. Desligar side effects por política do pipeline de importação, não por convenção de operador.
- Shadow mode compara leituras/decisões, sem efeitos externos. Não duplicar vendas nos dois sistemas para comparar resultados.
- Adaptador legado de pagamentos fica restrito à origem antiga e à drenagem das pendências. O matching aproximado legado não entra no fluxo próprio. Removê-lo só quando todas as obrigações antigas tiverem tratamento definido.
- Logs de depreciação mostram quem ainda usa o contrato antigo; corte baseado em uso observado, não somente busca textual no código.

### 7.2 Condições para cancelar o InstaDelivery

- [ ] Pedido próprio percorre compra, pagamento, produção, entrega/retirada, fechamento e fiscal sem chamadas ao InstaDelivery.
- [ ] Teste automatizado desabilita o adaptador e bloqueia rede para o parceiro, mantendo o E2E próprio verde.
- [ ] Pelo menos 7 dias consecutivos de piloto operacional sem incidentes críticos em aberto, incluindo período movimentado; carga de data especial simulada separadamente. Piloto não prova SLA mensal.
- [ ] Pedidos futuros/agendados, pagamentos tardios, estornos e notas antigas têm responsável, referências e fluxo de acompanhamento; não aguardar apenas o fim do dia.
- [ ] Histórico exportado, contagens/totais e amostras conferidos; acesso posterior/documentação fiscal e retenção definidos com a contabilidade.
- [ ] Links/QRs públicos, domínio, número WhatsApp, templates, cadastros, catálogo, cupons, horários, taxas, impressão e relatórios não dependem mais da conta do parceiro.
- [ ] Contrato e autorização da Eficiência Fiscal continuam válidos fora do InstaDelivery; regras para não emitir duas vezes a mesma venda documentadas.
- [ ] Backup restaurado em ambiente isolado e procedimento de contingência conhecido pela equipe.
- [ ] Consumo projetado cabe no orçamento, com alertas e procedimento de pico.
- [ ] Responsável pela loja autoriza cancelamento; só depois remover tráfego/integrações desnecessárias e revogar credenciais, preservando histórico e obrigações pendentes.

## 8. Observabilidade, recuperação e manutenção

Correlações obrigatórias: `requestId`, `checkoutAttemptId`, `orderId`, `paymentId`, `eventId`, `jobId` e versão. Logs estruturados e sanitizados; pendência no dashboard com motivo e ação segura, sem payload privado bruto.

Alertar: falha de cota/partida, taxa de 5xx/429, checkout sem conclusão, divergência PIX, idade da fila, lease abandonado, projeção atrasada, desktop offline, impressão inconclusiva, backup falho e gasto previsto. Alertas do sistema devem ter canal independente do mesmo WhatsApp/worker em falha.

Playbooks: (1) provedor indisponível; (2) excesso de cota; (3) resposta de cobrança/emissão perdida; (4) credencial comprometida; (5) desktop/rede local indisponível; (6) dado apagado/corrompido. Identificar responsável técnico e operador para cada ação; reprocessamento financeiro exige privilégio e auditoria.

Backups diários e PITR são a proposta, sujeitos à cotação dentro do orçamento. Restauração ocorre em banco/projeto isolado; revisar estados financeiros atuais antes de reativar efeitos, para não replayar pagamentos/notas/mensagens já executados. Arquivos fiscais/mídia e configurações também precisam de política própria; backup do Firestore não os inclui automaticamente. Política de retenção fiscal/privacidade depende de validação contábil/jurídica, não de números arbitrários neste plano.

Sem failover automático multirregional nesta fase. Uma indisponibilidade regional exige contingência explícita; não é resolvida apenas por retries ou backup. Testes não garantem ausência total de falhas.

Runtime: as 36 funções ativas do codebase padrão foram migradas para Node 24 em 14/09/2026 a partir dos snapshots exatos de produção, sem publicar regras, Hosting ou a árvore local futura. Todas ficaram `ACTIVE`, com revisão criada = pronta e 100% do tráfego; vínculos de segredos críticos permaneceram corretos. Manifesto/lockfile, CI do backend e verificador operacional exigem `nodejs24`; **165 unitários**, 16 cenários de regras, lint e instalação limpa foram validados. Uma atualização compatível removeu o alerta alto de `fast-xml-parser`; dez alertas moderados herdados permanecem, sem `npm audit fix --force`. O lockfile agora fixa também `picomatch@4.0.7` para reproduzir o build Linux. `pedidos` perdeu a invocação pública durante a troca, mas o IAM foi restaurado com autorização explícita e a sessão Firebase permaneceu obrigatória. `criarPedido` reproduziu a saturação regional durante o rollout e voltou a responder corretamente após a drenagem. Os 20 comportamentos do smoke passaram em verificações controladas; a observação operacional e a mitigação de capacidade continuam pendentes. A função legada falha `processarNotificacaoCancelamentoCriada` permanece fora do tráfego em Node 20 e não será apagada sem decisão própria. Evidência: [release Node 24](runtime-node24-p0.md).

## 9. Definição de pronto de cada entrega

- Implementação com schema/contrato documentados e compatibilidade avaliada nos três clientes (app, dashboard, desktop).
- Testes unitários, de autorização e integração relevantes verdes; regressão reproduzida por teste antes da correção quando aplicável.
- Nenhum teste crítico ignorado, `todo` ou liberado por retry para esconder intermitência.
- Build, lint efetivo, análise de dependências/segredos e revisão de permissões aprovados.
- IAM/regras/índices/capacidade conferidos no ambiente publicado; emulador não substitui isso.
- Migração/dry-run e rollback ensaiados, sem restaurar vulnerabilidade ou apagar registros de efeitos externos.
- Métricas, alertas, custo e instrução operacional entregues junto da funcionalidade.
- Publicação autorizada, pequena e observada; não usar deploy global como atalho.

Pendências de P0: inventariar consumidores da chave antiga (principalmente a versão do desktop em uso), conferir contas/papéis e reduzir a exposição de documentos/URLs privados. O harness e a execução remota básica do CI já existem; ainda faltam proteção de branch e ampliação da verificação publicada. O upgrade de runtime foi feito em release separado. Após o adiamento solicitado em 22/09, foi preparado o [roteiro local de P1](plano-acoes-p1.md). O pedido posterior do usuário priorizou a [frente fiscal](plano-acoes-fiscal-prioritario.md), começando pelo contrato EF/homologação e pela preparação local dos testes e controles mínimos de emissão. Essa preparação não ativa endpoints novos nem substitui a conferência dessa fronteira antes da publicação.

### Preparação desktop em 09/09/2026

A versão 1.2.3 em uso foi confirmada pelo operador. Auditoria IAM read-only confirmou papéis administrativos amplos na conta referenciada pelo arquivo local; nenhum consumidor identificado como identidade de execução nas listagens de Functions/Cloud Run consultadas, sem concluir que a chave não tem outros consumidores. Não houve revogação.

SEC-04/06/07: base local de identidade exclusiva de dispositivo, consulta de recibo mínimo atribuído, presença isolada, pareamento com código temporário/confirmado/revogável, lifecycle de trabalho com lease exclusiva/resultado conservador e produtor de pedidos próprios condicionado a ativação explícita. Endpoints ainda não publicados; o cliente .NET novo contém pareamento, armazenamento DPAPI e o contrato de lease, mas sem permissão de imprimir. Pareamento exige gestor ou capacidade explícita, sem herdar acesso de staff legado. **P0 não está concluído.** Próximo recorte: integrar a sessão do agente .NET à reivindicação/envio/resultado e validar o gatilho do produtor em homologação antes da migração operacional. Ver [contrato e sequência](acesso-restrito-impressao.md). Suítes atuais: 175 unitários e 16 cenários de emulador aprovados; a evidência histórica do release anterior permanece 165/16.

## 10. Referências técnicas consultadas

- [Firebase — testes de regras](https://firebase.google.com/docs/rules/unit-tests).
- [Firestore Emulator — limitações de transações/índices](https://firebase.google.com/docs/emulator-suite/connect_firestore).
- [Cloud Tasks — duplicação e ausência de ordenação garantida](https://docs.cloud.google.com/tasks/docs/common-pitfalls).
- [Cloud Tasks — limites e retentativas](https://docs.cloud.google.com/tasks/docs/configuring-queues).
- [Cloud Run — capacidade regional compartilhada](https://docs.cloud.google.com/run/docs/configuring/max-instances-limits).
- [Firestore — leitura por documento, não filtragem de campos nas regras](https://firebase.google.com/docs/firestore/security/rules-fields).
- [Google Cloud — orçamento não é corte automático de gasto](https://docs.cloud.google.com/billing/docs/how-to/budgets).
- [Firestore — recuperação pontual](https://docs.cloud.google.com/firestore/native/docs/pitr).
- [Cloud Run functions — runtimes suportados](https://docs.cloud.google.com/functions/docs/runtime-support).
