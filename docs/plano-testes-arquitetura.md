# Plano de testes automatizados — arquitetura própria

Versão 1 — atualizada em 09/09/2026. Complementa o [plano técnico](C:/Users/vgmds/factory-dashboard/docs/plano-tecnico-arquitetura.md).

Estado: plano com implementação parcial. P0 já tem testes de autorização/capacidade, 16 cenários de regras/integração no Emulator Suite e uma verificação operacional de publicação (recorte CI-03). O recorte P2 adicionou regressões para a corrida de QR PIX/webhook. Em 22/09, o workflow CI teve execução remota bem-sucedida nos repositórios público e privado. Em 23/09, a preparação fiscal idempotente e o contrato sintético sem rede elevaram a suíte local a 175 unitários. Em 28/09, o receptor InstaDelivery com inbox durável, a visibilidade de PIX pendente/pago e a data operacional elevaram a suíte local a 181 unitários, mantendo 16 cenários de emulador. Recursos de homologação continuam pendentes.

## 1. Linha de base verificada

Após a publicação descrita abaixo, a auditoria desktop de 09/09 acrescentou sete testes de triagem estática, totalizando **131 unitários aprovados**. A triagem sinaliza legado sem normalizá-lo como seguro e nunca aprova produção automaticamente. Não são testes do runtime C#/impressora. Ver [inventário e limites](C:/Users/vgmds/factory-dashboard/docs/inventario-desktop-p0.md).

Comando executado no dashboard, sem chamar handlers de produção:

```powershell
& 'C:/Program Files/nodejs/node.exe' --test functions/test/*.test.js
```

Resultado em 09/09/2026: **124 testes unitários, 124 aprovados, zero falhas, zero ignorados e zero TODOs**, além de **11 cenários aprovados no Emulator Suite**. A suíte inclui permissões, cancelamento concorrente, auditoria/job único, disputa de worker, timeout sem reenvio, proteção contra webhook atrasado e callbacks Meta de entrega/leitura/falha. O caso de falha anterior à persistência do ID da mensagem também está coberto. O lint de backend verificou 49 fontes. O build do painel passou na entrega anterior; não houve mudança de UI nesta entrega. Isso não é percentual de cobertura nem prova de capacidade/segurança integral em produção.

| Arquivo existente em `functions/test` | O que verifica | Limite da evidência |
| --- | --- | --- |
| `checkoutConfiavel.test.js` | Hash, dono/conteúdo da tentativa, decisão de lease, resultado persistido, conclusão de QR e preservação de fato financeiro já recebido | Helpers puros; não executa duas transações reais nem o checkout HTTP completo |
| `pixConfiavel.test.js` | Vínculo exato, centavos, eventos/estornos, recuperação e heurística legada restrita ao parceiro | Sem webhook/API Asaas real, concorrência de pagamentos ou indisponibilidade de infraestrutura |
| `webhookPedidos.test.js` | Normalização de datas/status, data operacional e ID estável de inbox que deduplica payload idêntico sem perder mudança real | Não cobre o receptor HTTP, autenticação, gatilho/transação reais ou falha de infraestrutura |
| `agendamentoFritura.test.js` | Datas locais, fuso e mudança de mês/ano | Não cobre agenda/capacidade de todo o checkout |
| `fiscal.test.js` | Modelo, validações, bloqueio de emissão, auth fiscal e serviço com dependências simuladas | Fetch substituído e Firestore em memória, não emulador/EF real; não prova emissão fiscal |
| `capacidade.test.js` | Descritores locais de CPU/concorrência/escala e funções preservadas | Não mede capacidade, latência, configuração efetiva ou cota publicada |
| `segurancaPainel.test.js` | Token ausente/inválido, cliente sem staff, staff inativo/ativo, documento legado e indisponibilidade da autorização | Dependências Firebase simuladas; não substitui regras reais, emulador ou teste do ambiente publicado |
| `permissoesPainel.test.js` | Papéis acumulados, exceções explícitas, migração em observação, negação estrita e compatibilidade de staff legado | Regra pura; os comandos críticos ainda precisam de testes de integração com a API e Firestore em P1 |
| `comandosPedidos.test.js` + `notificacoesPedido.test.js` | Identificador, política de cancelamento, estados do job e classificação conservadora de falhas da Meta | Timeout/5xx/429 não autorizam reenvio; apenas 4xx comprovado é falha definitiva |
| `regrasAcesso.rules.js` | Regras reais + transação Admin no emulador: cancelamento/worker concorrentes, entrega/leitura, falha repetida, callback anterior ao ID e inbox de pedidos inacessível a clientes/staff/desktop | Um status 4, uma auditoria, um job; falha cria uma pendência sem reenvio; chamadas à Meta são substituídas, nunca enviam mensagens reais |
| `verificacaoPublicacao.test.js` | Detector de versão antiga, função ausente/falha, segredo legado, gatilho, hash e contrato dos probes sem efeito | Valida o detector com respostas sintéticas; a execução operacional abaixo confere recursos reais |

O pipeline CI já teve execução remota comprovada para painel e backend. Ainda faltam E2E automatizado de navegador, testes de carga e proteção de branch. O lint do backend verifica a superfície de fontes, mas ainda deve evoluir para regras semânticas/estilo mais amplas. Dashboard e app cliente possuem build/lint, mas seus `package.json` consultados não têm script de testes de UI. O executável efetivo no computador da loja continua pendente de conferência.

## 2. Ferramentas e camadas escolhidas

| Camada | Ferramenta proposta | Execução | Evidência esperada |
| --- | --- | --- | --- |
| Domínio/backend | Manter `node:test`; relógio e adaptadores injetáveis; testes de propriedades onde útil | Toda alteração/PR | Valores, invariantes, estados e classificação de erro |
| UI isolada | Vitest + Testing Library nos componentes críticos | Toda alteração/PR | Estados pendente/erro/sucesso, teclado e ações duplicadas |
| Regras/acesso | Firebase Emulator Suite + `@firebase/rules-unit-testing` | Toda alteração/PR | Permissão permitida e negada por identidade, recurso, ação e campo |
| Integração backend | Auth/Firestore/Storage/Functions emulados; provedores HTTP locais falsos | Toda alteração relevante/PR | Handler real, transações, inbox/outbox, estado persistido e efeitos registrados |
| E2E | Playwright, dois contextos desktop e um mobile isolados | Antes de publicar contratos/fluxos críticos | App → API → banco → dashboard, mais desconexão e recuperação |
| Contratos externos | Fixtures versionadas/sanitizadas + testes contra sandbox autorizado | Fixtures em PR; sandbox antes de release do adaptador | Payloads, assinatura/token, códigos de erro e resposta incerta |
| Carga/infra | k6 e Cloud Monitoring em homologação | Mudanças de recursos/consultas e preparação de pico | Percentis, erros, custo, quotas, backlog e invariantes após execução |
| Desktop | Test runner do projeto identificado + spooler/impressora simulados | Alterações do agente e contratos de impressão | Retomada, exclusividade, fila persistida e resultado inconclusivo |

Não instalar várias ferramentas para testar a mesma camada. As ferramentas são a escolha do plano, ainda não estão configuradas. Playwright aqui é futuro código de teste do projeto; não houve automação de navegador nesta etapa.

Emulador não prova todos os comportamentos de transação, limites e índices compostos do Firestore; estas verificações precisam também de homologação real isolada. App Check, IAM, CORS da plataforma e cotas também exigem testes do ambiente publicado. [Limitações oficiais](https://firebase.google.com/docs/emulator-suite/connect_firestore).

## 3. Segurança do próprio ambiente de testes

Antes de qualquer nova suíte de integração:

1. IDs `demo-*` e hosts loopback para emuladores; abortar se variáveis obrigatórias de emulador estiverem ausentes. Não deixar Admin SDK cair silenciosamente em produção.
2. Bloquear egress para hosts de produção e falhar em requisição HTTP inesperada. Fakes de Asaas/Meta/EF locais, sem segredos reais.
3. Nenhum login/credencial padrão da máquina é necessário à suíte local. Conta de serviço de CI sem acesso à produção; permissões de deploy separadas, temporárias e condicionadas à aprovação.
4. Homologação em projeto distinto a autorizar, com base sintética, e-mail/números de teste, mídia fictícia e orçamento de execução. Allowlist explícita de projeto, conta, tenant e endpoints de sandbox.
5. Emissão fiscal só quando houver ambiente e contrato confirmados pelo provedor. Sem sandbox confirmado, usar fake e manter o teste real/ativação bloqueados — não emitir nota real para deixar o CI verde.
6. Nenhum checkout, PIX ou mensagem real como health check. Testes de efeitos reais exigem autorização específica fora do CI normal.
7. Cada execução usa namespace/seed e limpa apenas seus dados sintéticos em ambiente autorizado; nunca apagar coleção ou bucket de produção.
8. Traces, screenshots, HARs e relatórios usam dados fictícios; sanitizar e limitar retenção/acesso. Não publicar headers, tokens ou payloads de cliente.

## 4. Casos obrigatórios por risco

Legenda: **T0 (crítico)** bloqueia release do fluxo afetado; **T1 (alto)** bloqueia expansão/corte e não pode permanecer pendente na saída do InstaDelivery. Todos abaixo são requisitos a implementar, mesmo quando um helper relacionado já tem teste.

### 4.1 Identidade, autorização e dados

| ID | Prioridade | Cenário | Asserção obrigatória |
| --- | --- | --- | --- |
| SEC-01 | T0 | Anônimo, cliente A/B, visitante, staff ativo/inativo, token expirado/revogado e role ausente | API e regras aplicam matriz; cliente logado não ganha acesso de staff; negação antes de qualquer efeito |
| SEC-02 | T0 | A tenta ler/listar pedido, perfil, mensagem, mídia ou fiscal de B, variando ID e consulta | Sem conteúdo de terceiro, inclusive em erros, paginação e listeners |
| SEC-03 | T0 | Navegador manda preço, dono, role, status pago, campos extras e revisões adulterados | Backend recalcula/nega; escrita direta crítica negada; auditoria/financeiro não podem ser apagados |
| SEC-04 | T0 | Chave administrativa antiga, bundle, mapas, logs e payloads de erro | Chave não autoriza API; scanner não encontra segredos reais; Firebase config pública não é falso positivo de segredo |
| SEC-05 | T0 | Storage: cliente tenta enviar/alterar catálogo e mídia de terceiros; URL privada antiga/expirada | Negado conforme função; sem leitura pública de mídia/fiscal; testar ACL/token de download em homologação além das regras |
| SEC-06 | T0 | Celular/desktop trocam conta ou fazem logout com cache e comandos offline pendentes | Sem dados ou reenvio autorizado como outro usuário; login/revogação reavaliados na sincronização |
| SEC-07 | T0 | Staff desativado; token interno com audiência errada; App Check inválido; URL direta alternativa | Sem bypass por rota/origem; OIDC/IAM publicados verificados; webhook válido usa mecanismo do provedor, não App Check |
| SEC-08 | T0 | Tentativas OTP/cupom/login concorrentes, payload grande, mídia/URL maliciosa e conteúdo XSS | Rate limit consistente entre instâncias; resposta segura; sem SSRF, execução de script ou custo de upload ilimitado |

### 4.2 Pedido, datas e regras comerciais

| ID | Prioridade | Cenário | Asserção obrigatória |
| --- | --- | --- | --- |
| ORD-01 | T0 | Produtos alterados, indisponíveis, preços adulterados e carrinho misto | Total calculado no servidor, centavos exatos e snapshot preservado; sem confiar no cache da vitrine |
| ORD-02 | T0 | Duas compras disputam última utilização de cupom ou vaga limitada | Apenas quantidade permitida aceita; nenhuma reserva vazada; teste real de transação |
| ORD-03 | T0 | Cliente bloqueado, desbloqueado e novo bloqueio concorrente à compra | Política atômica consistente; atualização de bloqueio não pode ser contornada por corpo da requisição |
| ORD-04 | T0 | Mesmo telefone, compras repetidas e nome novo digitado; visitante tenta obter cadastro anterior | Pedidos distintos legítimos entram; nome da compra respeitado; dados antigos só após identidade verificada |
| ORD-05 | T0 | Hoje/amanhã/anteontem, mês/ano, 23:59 e limite de dias de agendamento | Data operacional em Fortaleza; feito ontem para hoje aparece nas rotas de hoje; feito hoje para depois não some nem é despachado inadvertidamente |
| ORD-06 | T0 | Delivery/retirada em todos os estados; finalizar retirada versus sair para entrega | Transições próprias válidas; pagamento e fiscal não são inferidos do status operacional |
| ORD-07 | T0 | Três operadores alteram/selecionam/despacham o mesmo pedido/viagem | Uma atribuição válida; revisão obsoleta recebe conflito claro; sem atualização perdida ou duas viagens donas |
| ORD-08 | T0 | V1, V2, números/strings legados, campos ausentes, cancelamento e projeção atrasada | Compatibilidade explícita e previsível; nenhuma confirmação falsa; versões antigas continuam lendo dados permitidos |

### 4.3 Checkout, pagamentos e fila durável

| ID | Prioridade | Cenário | Asserção obrigatória |
| --- | --- | --- | --- |
| CHK-01 | T0 | 50 chamadas concorrentes da mesma tentativa/sessão/carrinho | Exatamente um pedido e um efeito de criação de cobrança; respostas convergem para o mesmo ID |
| CHK-02 | T0 | Mesma chave com outro dono/conteúdo; 50 chaves legítimas diferentes | Reuso indevido negado; 50 pedidos independentes, sem dedup por telefone/valor |
| CHK-03 | T0 | Commit ocorre, resposta cai; cliente recarrega/reinicia navegador | Mesma tentativa é recuperada; pedido já salvo não é recriado; UI não acusa falha definitiva sem consultar |
| CHK-04 | T0 | Falha antes do commit, na outbox ou depois do commit antes de enfileirar | Atomicidade pedido/outbox; sem confirmação prematura; varredor reenvia trabalho que não chegou à fila |
| CHK-05 | T0 | Lease expira com worker antigo ainda vivo; rede cai durante retomada | Nova execução não gera novo pedido; worker antigo não sobrescreve resultado; token de fencing e reconciliação exercitados |
| PAY-01 | T0 | ID/conta/referência/valor divergentes, mesmo valor e nome em dois pedidos, diferença de um centavo | Nenhum vínculo por semelhança no fluxo próprio; divergência vira pendência sem falso pago |
| PAY-02 | T0 | Asaas cria cobrança, mas resposta some; consulta retorna cobrança, nenhuma ou múltiplas | Recupera a exata; resultado incerto não cria outra cobrança às cegas; múltiplas exigem conferência |
| PAY-03 | T0 | Webhook falso, malformado, duplicado 100 vezes e eventos fora de ordem | Autenticação antes do efeito; persistência antes de ACK; uma aplicação financeira; sem regressão de estado |
| PAY-04 | T0 | Pagamento confirmado sem webhook; webhook antes do vínculo; RECEIVED antes de concluir/persistir QR; webhook e reconciliação juntos | Pendência conciliada quando verificável; uma confirmação; conclusão tardia do checkout não volta para PENDING/não pago nem sobrescreve estorno/cancelamento |
| PAY-05 | T0 | Agendamento D+5 permitido, pagamento tardio, mudança posterior de configuração | Validade contratada preservada; reconciliação não ignora por data de criação; conflitos operacionais ficam visíveis |
| PAY-06 | T0 | Estorno parcial/total, duplicado, em andamento e recebido antigo após estorno | Valores/estados consistentes; nada de voltar a pago integralmente por evento antigo |
| PAY-07 | T0 | 429, timeout, 5xx e indisponibilidade prolongada do Asaas | Backoff limitado; checkout/pedido preservado; retomada controlada; sem avalanche de chamadas ou falso sucesso |
| JOB-01 | T0 | Outbox commit → queda antes do enqueue; enqueue → queda antes de marcar despachado | Efeito não some nem duplica; fila e ledger convergem |
| JOB-02 | T0 | Tarefa duplicada, fora de ordem, lease abandonado e worker encerrado | Idempotência, fencing e sequência quando necessária; estado recuperável |
| JOB-03 | T0 | Tentativas esgotadas, tarefa ausente na fila ou falha permanente | Registro próprio de pendência + alerta; reprocessamento autorizado e auditado; TTL não apaga inconclusivo |
| JOB-04 | T0 | Worker antigo e novo ativos durante rollout/rollback | Ownership por efeito/coorte; um executor financeiro autoritativo; sem replay dos efeitos já concluídos |

### 4.4 Comunicação, operação e fiscal

| ID | Prioridade | Cenário | Asserção obrigatória |
| --- | --- | --- | --- |
| CHAT-01 | T0 | Mensagens de 20 conversas em paralelo e sequência na mesma conversa | Paralelismo entre conversas sem inversão indevida da sequência controlada; nenhuma conversa bloqueia todas |
| CHAT-02 | T0 | Envio com resposta perdida; queda após marcar notificado antes de enviar; queda após envio antes de gravar msgId; worker preso em enviando | Trabalho não some pela marcação antecipada; resultado inconclusivo rastreável; consulta/callback quando disponível; sem reenvio cego para prometer exactly-once |
| CHAT-03 | T0 | Janela de atendimento fecha entre montar e enviar; tentativa manual via requisição externa | Servidor bloqueia mensagem livre; permite só template aplicável; motivo seguro aparece na UI |
| CHAT-04 | T1 | Operador offline/recarrega, três contextos, mídia lenta/falha e reconexão | Mesma bolha correlacionada, estado claro, sem duplicação ou perda silenciosa; mídia não impede texto de outras conversas |
| OPS-01 | T0 | Desktop cai antes/depois de reivindicar trabalho; reinicia em outro PC autorizado | Fila durável retomada; exclusividade e lease; dispositivo revogado não consome trabalhos |
| OPS-02 | T0 | Impressora recebe bytes, mas ACK/status some; operador pede reimpressão | Estado inconclusivo e ação explícita auditada; não afirmar impressão física apenas pelo envio de bytes |
| OPS-03 | T1 | Cozinha/rotas/retiradas usam pedidos de outro dia e fechamento financeiro simultâneo | Totais conciliáveis, visões coerentes e estados independentes; impressão contém horário agendado |
| OPS-04 | T1 | Busca por ID/nome, filtros de datas/origem e grande histórico | Pedido não some por formato/data; paginação/índices sem carregar histórico inteiro; UI distingue offline |
| FIS-01 | T0 | Antes da liberação: tentativa de emitir por UI e HTTP direto | Emissão continua bloqueada no servidor; papel fiscal e vínculo revisado exigidos |
| FIS-02 | T0 | Depois da liberação autorizada: clique duplo e resposta de autorização perdida | Uma nota ou estado inconclusivo consultável; nunca nova emissão por timeout; contrato real EF validado |
| FIS-03 | T0 | Cancelamento, rejeição, contingência, pedido editado durante emissão e recibo sem revisão contábil | Transições e snapshot protegidos; erros acionáveis; sem emitir com dados não conferidos |
| FIS-04 | T0 | Venda antiga já emitida pelo InstaDelivery, migração/backfill e replay | Não reemitir; referências/XML privados e preservados; independente do contrato antigo após corte |

### 4.5 E2E, migração, custo e recuperação

| ID | Prioridade | Cenário | Asserção obrigatória |
| --- | --- | --- | --- |
| E2E-01 | T0 | Cliente compra delivery/retirada e PIX/débito/crédito; dois operadores e mobile acompanham | UI → API real de teste → banco → painel/cozinha → job de impressão → conclusão conforme matriz de pagamento aprovada; ler registros e efeitos, não só toast; não adicionar dinheiro como funcionalidade implícita |
| E2E-02 | T0 | Reload, queda de rede, sessão expirada, provedor lento e concorrência no fluxo completo | Resultado verdadeiro, recuperação e acesso correto em cada contexto; sem cobrança/nota/mensagem real |
| MIG-01 | T0 | ID legado colide com novo, alias/externalReference e webhook repetido de cliente recorrente | Mapeamento inequívoco por provedor/loja/ID; mesmo cliente pode ter vários pedidos; vínculos antigos intactos |
| MIG-02 | T0 | Backfill repetido/interrompido e leitura V1/V2 por clientes antigos | Checkpoint/idempotência; contagem e centavos equivalentes; zero efeitos externos na importação |
| MIG-03 | T0 | InstaDelivery completamente indisponível e egress bloqueado para seu domínio | E2E próprio continua completo; nenhuma consulta implícita ao parceiro para concluir a compra |
| MIG-04 | T0 | Rollback após pedidos V2 e jobs novos em processamento | Dados continuam legíveis; ownership único e sem emissão/cobrança duplicada; sem reabrir regra vulnerável |
| MIG-05 | T1 | Exportação final: agendados futuros, pendências, notas antigas e histórico | Reconciliação de IDs/totais/estados + amostras; obrigações pendentes continuam acessíveis após corte |
| PERF-01 | T1 | Carga normal e 100 navegadores/3 operadores | Latência, listeners, leituras e projeção de custo dentro das metas |
| PERF-02 | T0 | Rajada de 50 checkouts independentes com chat ativo | Sem 429/503 de capacidade no perfil aprovado; metas de latência e todas as invariantes verificadas |
| PERF-03 | T1 | Provedor lento, filas concorrentes, mídia grande, cold start e duas revisões | Pagamentos/ingresso preservados; limites respeitados; backlog drena em tempo medido |
| PERF-04 | T1 | Perfil mensal e consulta a histórico crescente | Projeção normal ≤ R$ 140 e mês com picos ≤ R$ 200, ou redimensionamento aprovado antes de expandir |
| DR-01 | T0 | Corrupção/exclusão sintética e restauração isolada | RPO/RTO medidos, contagem/totais conferidos; sem efeitos replayados após restaurar |
| DR-02 | T1 | Falha de backup/alerta, desktop offline e indisponibilidade regional simulada | Detecção e playbook acionáveis; canal de alerta independente; limites de recuperação documentados |
| CI-01 | T0 | Runner sem emulador, com host/projeto errado ou tentativa de rede externa | Suíte aborta antes de escrita/efeito; nenhum acesso a produção |
| CI-02 | T0 | Teste obrigatório falha, lint não executa, segredo detectado ou contrato incompatível | Pipeline bloqueia; nenhum deploy automático ou green falso |
| CI-03 | T0 | Artefato publicado difere do testado; IAM/regras/índices/runtime divergentes | Verificação detecta drift, bloqueia promoção e preserva evidência/reversão |

## 5. Perfil de carga reproduzível

Executar somente após harness seguro e autorização da homologação/custo. Fixtures com 30 dias de histórico, 6.000 pedidos sintéticos, produtos/agenda realistas e mensagens suficientes para paginação; incluir subconjunto de pedidos agendados e pendências.

1. Baseline: 15 min, três operadores, 20 clientes navegando, 5 checkouts/min, fake PIX com latência explícita de 300 ms.
2. Pico misto: ramp de 5 min até 100 sessões; cada uma consulta/navega a cada 5–10 s. Manter 15 min com 10 checkouts/min e 20 conversas a uma mensagem a cada 10 s por conversa (2 mensagens/s no total).
3. Rajada: 50 checkouts distintos iniciados dentro de 1 s, com pico misto ativo; repetir três vezes com 5 min entre rajadas. Duplicatas da mesma tentativa são teste separado CHK-01, não inflar a contagem de pedidos legítimos.
4. Degradação: latência fake de 5 s, 20% de 429/5xx e indisponibilidade do provedor por 5 min; restabelecer e medir drenagem, sem refazer os efeitos confirmados.
5. Inicialização/deploy: repetir cenário com serviços frios e versão anterior coexistindo em homologação. Medir recursos regionais, não só CPU de uma função.
6. Soak: 2 h em perfil misto moderado com pausas/reconexões; conferir crescimento de memória, leituras, jobs órfãos e custos. Ajustar duração somente com registro explícito, nunca ocultar o teste mais curto.

Parada imediata: qualquer acesso indevido, duplicação financeira, confirmação sem persistência, destino externo inesperado ou orçamento de execução excedido. Falha de cota/latência para expansão; não aumentar carga para “ver até onde quebra” em produção.

Registrar versão/configuração/seed, taxa ofertada e efetiva, chamadas completas (não só VUs), p50/p95/p99, 4xx por causa, 429/5xx/timeouts, cold starts, CPU/memória, idade máxima/p95 da fila, leituras/escritas, egress e quantidade final de pedidos/efeitos. Um teste curto não comprova 99,9% mensal; todos os números de carga são metas propostas, ainda não executadas.

## 6. Pipeline de qualidade e publicação

O workflow `.github/workflows/verificacao.yml` está no código e sua [execução remota de 22/09/2026](ci-p0-preparacao-2026-09-22.md) foi comprovada nos dois repositórios. Proteção de branch continua pendente. Entre repositórios, cada release registra versões do backend, app cliente, dashboard e desktop compatíveis.

- **Todo PR:** instalação por lockfile, lint efetivo, tipos/build, unitários, contratos com fakes, regras e integração em emulador; scanner de segredos/dependências. Runner sem segredos de produção e actions fixadas por revisão.
- **Mudança crítica:** E2E automático; matriz de permissões negativa e testes de concorrência obrigatórios. Mudança de regra/contrato executa as suítes dos consumidores afetados, não apenas do arquivo alterado.
- **Antes de release:** publicar o artefato testado em homologação mediante autorização; verificar IAM/App Check/CORS/índices/recursos reais. Carga para mudanças de capacidade/consulta; restauração para mudanças de schema/backup.
- **Produção:** aprovação explícita, release pequena com smoke read-only, métricas e rollback. Nenhuma carga sintética, compra, emissão ou mensagem real automática. Proteger jobs de deploy de código não confiável e PRs externos.
- **Após incidente:** reproduzir com fixture sanitizada, criar regressão e registrar causa; não corrigir apenas o caso individual.

Gate é resultado de testes obrigatórios, não “cobertura global alta”. Meta auxiliar: ≥ 90% de branches nas novas regras puras de pagamento, idempotência e autorização, sem redução da linha de base medida; não inventar cobertura dos 93 atuais. Usar mutações dirigidas (remover verificação de dono, trocar centavo, ignorar revisão) para provar que os testes críticos falham. Testes obrigatórios com `skip`/`todo` ou falha intermitente impedem aprovação; retries servem para diagnóstico, não para tornar um teste vermelho artificialmente verde.

Artefatos: JUnit/relatório, cobertura, seed, versões, traces sintéticos e métricas. Cada gate P0–P6 liga teste → execução → resultado → responsável pela revisão. Aprovação fiscal do contador/provedor e confirmação física da impressão são evidências complementares; automação não as substitui.

### 6.1 Verificação operacional implementada — recorte CI-03

Na raiz do dashboard, `npm run verify:release` consulta o projeto fixo `entregas-781a8`. Requer uma sessão autorizada da CLI Firebase. A suíte de testes local/CI não precisa dessa sessão e não executa este comando de produção automaticamente.

O verificador confere:

- Código empacotável local versus fingerprint de seis funções: `chat`, `conversas`, `clientes`, `configuracoes`, `pendencias` e `processarEventoMeta`.
- Estado ACTIVE, entrypoint, runtime e vínculos de segredos, recusando a chave administrativa antiga.
- Última revisão criada/pronta e 100% do tráfego na revisão atual; label atualizado não basta depois de um deploy falho.
- Gatilho Firestore de criação em `eventos_meta/{eventoId}` e retentativas do processador Meta.
- Conteúdo integral das regras publicadas de Firestore e Storage; papel específico e incondicional do agente gerenciado do Storage para consultar Firestore.
- Índice HTML servido pelo Hosting versus `dist/index.html` local.
- CORS e rejeição de sessão ausente/token inválido nos endereços `cloudfunctions.net` e `run.app` das cinco APIs administrativas. Todos os POSTs usam uma ação inexistente fixa, sem IDs de pedido ou credenciais reais; não criam pedidos, mensagens ou cobranças.

O processo retorna código 1 se algo divergir ou não puder ser verificado. `--sem-smoke` mantém as consultas de configuração e omite apenas os probes HTTP das APIs. Testes e logs de emulador são excluídos do pacote de funções, evitando drift falso por arquivos que não executam em produção.

Limites: é uma verificação operacional manual, ainda não um gate remoto automático completo. Não audita todos os serviços/IAM/índices/cotas/App Check, arquivos privados por URL com token, assets do painel além do índice, nem comprova operação autenticada de ponta a ponta. Não equivale à conclusão integral de CI-03 ou P0. O fingerprint depende da CLI 15.29.0; mudanças da CLI exigem revisar e testar o algoritmo.

## 7. Sequência de implementação dos testes

Atualização de prioridade em 22/09: o [plano fiscal prioritário](plano-acoes-fiscal-prioritario.md) antecipa a preparação de FIS-01 a FIS-04 e seus testes de autorização/concorrência/recuperação, usando o adaptador atual. Os lotes abaixo mantêm a referência de dependências, mas os testes fiscais não precisam esperar a implementação integral de P1–P4. Contratos reais só serão exercitados no ambiente confirmado com o provedor; esta prioridade não habilita emissão real.

1. **Primeiro lote (P0):** isolamento do harness, CI mínimo, SEC-01/02/03/04/05/07 e regressões das permissões locais identificadas. Corrigir junto as vulnerabilidades que os testes reproduzirem; não publicar testes que apenas documentam acesso indevido como esperado.
2. **Segundo lote (P1/P2):** domínio versionado, transações reais, CHK, PAY, JOB e fixtures legadas; garantir invariantes antes de ativar fluxo novo.
3. **Terceiro lote (P3):** E2E três contextos, chat e agente desktop com impressora falsa; smoke físico autorizado separado.
4. **Quarto lote (P4/P5):** carga, custos, restauração e contratos reais de homologação fiscal. Não liberar emissão se a consulta segura de resultado continuar indefinida.
5. **Último gate (P6):** MIG-03 com parceiro indisponível, backfill/exportação conferidos e rollback ensaiado antes de cancelar a assinatura.

### Evidência local desktop — 09/09/2026

Preparação descrita em [acesso restrito à impressão](acesso-restrito-impressao.md): 12 unitários de identidade/recibo/handler, seis de pareamento, cinco do ciclo de trabalho/lease, quatro do produtor de pedidos próprios e 16 cenários de emulador para transação/isolamento/regras. Total local: **160 unitários aprovados**, lint backend de 54 arquivos. Novos testes usam dados sintéticos; auditoria IAM usa somente leitura e sessão local, fora do CI. Ainda faltam integração do cliente .NET/impressora falsa e validação operacional autorizada. Não declarar OPS-01 ou SEC-04 completos apenas com esta base.

### Evidência e publicação do runtime Node 24 — 10–14/09/2026

A preparação alterou a versão do Node, os gates que a verificam e somente atualizações transitivas compatíveis registradas no lockfile. A suíte passou em Node 24 com **165 unitários**, lint de 54 arquivos e 16 cenários de regras no emulador. Uma instalação limpa de produção carregou Firebase Admin/Functions e executou o FFmpeg; os quatro testes específicos de runtime passaram. O `npm audit --omit=dev --audit-level=high` ficou sem alertas altos ou críticos; restam dez moderados herdados dos SDKs, cuja correção indicada envolve atualização principal e será tratada separadamente. O build Linux revelou a necessidade de fixar `picomatch@4.0.7` como dependência de desenvolvimento para tornar o lockfile portátil; `npm ci --include=dev --dry-run` passou depois da correção.

Em 14/09/2026, os snapshots exatos das 36 funções ativas foram publicados em Node 24 sem incluir a árvore local futura. As 36 ficaram `ACTIVE`, com revisão mais nova pronta e 100% do tráfego; vínculos de segredos críticos não divergiram. O smoke aprovou 16/20 verificações na primeira rodada. Depois da drenagem da cota, `criarPedido` voltou a aprovar CORS e rejeição anônima; após autorização explícita, o IAM de `pedidos` foi restaurado e manteve a rejeição 401 no handler. Resultado consolidado: 20/20 comportamentos esperados sem efeitos externos. A troca de runtime foi concluída, mas a observação operacional, a mitigação de capacidade e P0 continuam abertos. Ver [evidência da release Node 24](runtime-node24-p0.md).

Em 15/09/2026, as cinco consultas públicas do App Cliente foram publicadas individualmente com o perfil fracionado já coberto por `capacidade.test.js`. A verificação publicada confirmou em todas: Node 24, estado ativo, CPU 0,1666, memória 256 MiB, concorrência 1, mínimo 0, máximo 4, revisão pronta igual à criada, 100% do tráfego, CORS 204 para a origem cliente e rejeição 401 sem App Check. O App Cliente real recarregou o catálogo completo sem avisos ou erros no console. A amostra final estimou 11,833/20 vCPUs em instâncias recentes e a janela sanitizada do Cloud Logging do rollout não encontrou 429/503 ou mensagens de cota. Isso comprova configuração e compatibilidade básica, mas não substitui PERF-01 a PERF-04 nem a observação de tráfego por 24 horas.

## 8. Referências

- [Firebase — testes de regras com identidades simuladas](https://firebase.google.com/docs/rules/unit-tests).
- [Firebase — limitações dos emuladores](https://firebase.google.com/docs/emulator-suite/connect_firestore).
- [Cloud Tasks — duplicação e ordenação](https://docs.cloud.google.com/tasks/docs/common-pitfalls).
- [Cloud Tasks — controles de fila e retentativas](https://docs.cloud.google.com/tasks/docs/configuring-queues).

Ferramentas e parâmetros propostos devem ser fixados por versão na implementação; este documento não instala dependências nem configura gatilhos recorrentes.
