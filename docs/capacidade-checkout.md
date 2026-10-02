# Capacidade regional — mitigação controlada (03–15/09/2026)

## Estado e autorização

**Publicação parcial autorizada e executada.** Em 15/09/2026, as cinco consultas públicas do App Cliente foram publicadas individualmente com CPU fracionada, após medição de capacidade e verificação de cada revisão. `fiscal` permanece apenas preparado; checkout, PIX, webhooks, chat, regras, Hosting e emissão fiscal não foram alterados neste recorte.

O perfil continua opt-in e não é o padrão definitivo da arquitetura. Testes de descritores e o smoke abaixo não substituem os gates de concorrência, latência e custo do novo plano. O restante deste documento separa evidência histórica, configuração publicada e próximos gates.

## Evidências de produção

- Projeto `entregas-781a8`, região `southamerica-east1`.
- Cota `run.googleapis.com/cpu_allocation`: limite efetivo 20000 (20 vCPUs), consultado pelo Service Usage.
- Às 17:41:28 e 17:41:30 de 03/09/2026 (Fortaleza), `criarPedido` recebeu OPTIONS com HTTP 503 e mensagem de excesso recente da cota de CPU. Às 17:41:34, recebeu HTTP 429 por falta de instância disponível. Não eram rejeições da lista de origens CORS.
- Às 17:46, OPTIONS voltou a retornar 204 com a origem do app cliente autorizada.
- A função estava ACTIVE, revisão `criarpedido-00017-deh`, atualização em 23/07/2026; não foi alterada pelo deploy de Fiscal.
- No intervalo auditado 17:35–17:50, nenhuma série de instâncias por serviço/estado ultrapassou uma instância. Às amostras de 17:41 e 17:42, 20 serviços tinham uma instância ativa ou ociosa. Isso aponta disputa entre vários serviços, não dez instâncias de um único consumidor. As amostras de um minuto não capturam todos os picos de inicialização.
- Os serviços consultados usavam 1 CPU por instância e startup CPU boost ligado. Os cinco endpoints leves abaixo estavam entre os serviços acionados na navegação do app.

### Nova reprodução em 14/09/2026

O smoke posterior à migração de runtime acionou várias APIs de forma sequencial e reproduziu a saturação: `criarPedido`, já `ACTIVE` em Node 24 e com 100% do tráfego na revisão `criarpedido-00018-kon`, respondeu `Rate exceeded` em três tentativas inválidas. A configuração efetiva continuava em 1 CPU, 256 MiB, concorrência 80, mínimo 0 e máximo 10; o serviço não estava reconciliando e não apresentava condição de revisão com falha. Após a drenagem das instâncias do rollout, o mesmo endpoint voltou a responder corretamente: OPTIONS 204 com CORS e POST anônimo 401. Isso confirma que trocar o runtime não corrige a disputa regional e que o erro acontece antes de CORS/App Check/handler, embora não tenha deixado o checkout permanentemente indisponível. O perfil fracionado deste documento continua não publicado e requer decisão separada.

### Canário bloqueado pela cota em 14/09/2026

Foi preparado e publicado isoladamente o perfil fracionado para `consultarOrdemCategorias`, a leitura pública da ordem do cardápio. O artefato partiu do snapshot exato da função em produção e alterou somente os recursos: 256 MiB, `gcf_gen1` (aprox. 1/6 de CPU), concorrência 1, mínimo 0 e máximo 4. App Check e o handler não foram alterados.

As duas tentativas de criar a nova revisão (`consultarordemcategorias-00005-puj` e `consultarordemcategorias-00006-yaj`) foram recusadas antes de servir tráfego com `Quota exceeded for total allowable CPU per project per region`. A revisão anterior `consultarordemcategorias-00004-nos` permaneceu pronta, com 100% do tráfego, 1 CPU e concorrência 80; OPTIONS continuou 204 e a chamada anônima sem App Check, 401. Portanto não houve interrupção do App Cliente nem mudança parcial de comportamento.

Uma amostra de métricas indicou pelo menos 14–15 CPUs em instâncias recentes, além de três serviços com instância mínima. Como a cota regional efetiva é 20 vCPUs e as métricas têm atraso, não há folga confiável para uma nova revisão durante operação. Não repetir deploys até escolher uma das alternativas: aumento controlado da cota regional ou janela operacional com capacidade comprovadamente livre. A segunda alternativa pode viabilizar a publicação uma vez, mas não resolve o risco de futuros rollouts.

### Solicitação de cota e publicação controlada em 15/09/2026

A API Cloud Quotas foi habilitada e foi criada a preferência `run_southamerica-east1_cpu-30000`, solicitando 30 vCPUs para `CpuAllocPerProjectRegion`. O Google manteve o valor concedido em 20 vCPUs e informou histórico de uso insuficiente; a preferência terminou sem reconciliação pendente. Não foram abertas solicitações menores repetidas nem houve aumento de custo fixo.

Com 4 vCPUs de folga observada, o canário de `consultarOrdemCategorias` foi repetido e ficou ativo na revisão `consultarordemcategorias-00007-yeb`. Em seguida, sempre uma por vez e com medição entre publicações, entraram:

| Função | Revisão validada |
|---|---|
| `consultarOrdemCategorias` | `consultarordemcategorias-00007-yeb` |
| `consultarConfiguracoesGerais` | `consultarconfiguracoesgerais-00005-ber` |
| `consultarHorarioFuncionamento` | `consultarhorariofuncionamento-00009-fif` |
| `listarBairrosEntrega` | `listarbairrosentrega-00008-jiq` |
| `consultarTaxaEntrega` | `consultartaxaentrega-00011-poy` |

Nas cinco: estado `ACTIVE`, Node 24, CPU efetiva `0.1666`, memória 256 MiB, concorrência 1, mínimo 0, máximo 4, revisão criada igual à pronta e 100% do tráfego na mais nova. O preflight retornou 204 com a origem do App Cliente; a chamada anônima sem App Check foi rejeitada com 401. Depois do lote, o App Cliente real recarregou o catálogo completo sem `warn` ou `error` no console.

A amostra final às 11:39 de Fortaleza estimou 11,833 vCPUs em instâncias recentes, com as cinco consultas em aproximadamente 0,1666 vCPU cada, contra o limite de 20. A amostra anterior ao lote chegou a 16,5 vCPUs. Métricas de instâncias são transitórias e atrasadas: isso é evidência compatível com redução de pressão, não garantia de reserva, custo ou capacidade de pico.

A consulta sanitizada do Cloud Logging entre 11:20 e 11:45 de Fortaleza retornou zero registros HTTP 429/503, `Rate exceeded`, `Quota exceeded` ou `no available instance`. A janela curta fecha o smoke do rollout, mas não substitui a observação de pelo menos 24 horas com tráfego real.

Scripts de auditoria em `.codex-temp/capacity-audit.cjs` e `.codex-temp/checkout-cors-diagnostic.cjs`: consultas de metadados/métricas/logs de infraestrutura; não expõem tokens nem corpos de pedidos. As datas da auditoria estão fixadas; atualizar a janela antes de uma nova análise.

## Alteração versionada e publicação parcial

Perfil opt-in em `functions/src/runtime/capacidade.js`; nenhum novo padrão global.

| Funções | CPU antes → perfil por instância | Máximo antes → perfil | Concorrência antes → perfil |
|---|---|---|---|
| consultarConfiguracoesGerais, consultarOrdemCategorias, consultarHorarioFuncionamento, consultarTaxaEntrega, listarBairrosEntrega | 1 → `gcf_gen1` (1/6 com 256 MiB) | 10 → 4 por função | 80 → 1 por instância |
| fiscal | 1 → `gcf_gen1` (1/6 com 256 MiB) | 3 → 3 | 80 → 1 por instância |

Nos seis endpoints o código contém memória 256 MiB, minInstances explicitamente 0 e nenhuma mudança em URLs, payloads, autenticação, App Check, regras, preços ou dados. O perfil está publicado apenas nas cinco consultas; `fiscal` continua no perfil anterior e incapaz de emitir notas.

Para uma instância de cada um desses seis serviços, a configuração nominal cai de 6 para aproximadamente 1 vCPU. Isso é cálculo de alocação, **não previsão de economia na fatura nem reserva garantida para checkout**. A redução de concorrência pode aumentar espera em picos; é obrigatório medir latência e erros durante rollout.

Preservados: criarPedido, consultarCheckoutPedido, login, PIX/Asaas, todos os webhooks, processamento de mensagens/áudio, reconciliações, SSR e configurações globais. Não desativar o robô ou webhooks para liberar capacidade. Não transferir a falha para o recebimento de mensagens/pagamentos.

## Limites importantes

- Reduzir apenas maxInstances não resolveria o cenário observado: cada serviço já estava usando aproximadamente uma instância.
- CPU fracionada exige concorrência 1 no Firebase. Não habilitar concorrência 80 com esse perfil.
- Não adicionamos minInstances=1 ao checkout: isso introduziria custo fixo e não criaria reserva exclusiva sob cota regional saturada.
- Startup CPU boost permanece ligado nesta proposta (o SDK não foi alterado nem houve patch direto de Cloud Run). Ele e a coexistência temporária de revisões antigas/novas ainda podem elevar o pico de CPU. O ajuste é mitigação, não garantia absoluta.
- A fatura depende de duração e volume; menos CPU pode aumentar duração. Não foi estimado custo total nem aumentado orçamento/cota.
- O menor paralelismo por endpoint precisa de avaliação com tráfego real controlado. Testes locais não medem cold start ou capacidade da plataforma.

## Procedimento executado e próximo canário

O lote público seguiu o procedimento abaixo sem deploy geral. Cada artefato partiu do snapshot exato de produção para não incluir a árvore local futura. `fiscal` deve continuar como canário separado por ser uma API administrativa sensível e não fazer parte da navegação pública; sua publicação exige nova conferência de capacidade, artefato e smoke específico. Nenhuma necessidade de republicar `criarPedido`, Hosting, regras ou índices.

Após cada função:

1. Confirmar estado ACTIVE, CPU fracionada, concorrência 1, min=0, max esperado tanto no serviço como na revisão. Não presumir que o deploy apagou overrides antigos do Cloud Run.
2. Conferir OPTIONS autorizado e rejeição sem autenticação/App Check; usar chamada real de leitura pelo app para validar resposta, sem finalizar pedido.
3. Comparar erros 429/503, inicialização e latência com a linha de base. Critério de parada proposto: qualquer novo erro de cota ou falha funcional, ou piora sustentada importante de latência. Não executar carga artificial em produção.
4. Esperar estabilização/saída das revisões antigas antes da próxima publicação. Não desativar boost ou apagar revisões automaticamente como atalho.
5. Só ao final, pedir ao operador um teste de checkout consciente, com a proteção de idempotência existente. Não criar pedido/cobrança automaticamente para testar infraestrutura.

Se CPU fracionada produzir latência inaceitável, parar e reavaliar: agregação das consultas leves em um endpoint/cache e eventual cota maior são alternativas distintas que exigem análise. Não aumentar cota às cegas.

### Reversão

Reverter apenas o uso do perfil na função afetada e publicar somente ela, restaurando CPU padrão (1), concorrência padrão (80), min anterior (0), max anterior (10 nas consultas ou 3 no fiscal). Validar os valores efetivos após o deploy. Essa reversão restaura capacidade individual, mas também a pressão anterior sobre a cota; não é uma correção para a saturação original. Não apagar documentos, filas ou revisões como parte da reversão.

## Verificação local

`node --test functions/test/*.test.js` inclui testes dos descritores reais do SDK: seis opt-ins exatos, CPU/memória/concorrência/escala esperadas, funções críticas preservadas e emissão fiscal bloqueada. Nenhum handler de produção é invocado pelos testes.

## Referências oficiais

- [Firebase — CPU, concorrência e limites de instâncias](https://firebase.google.com/docs/functions/manage-functions).
- [Cloud Run — cota regional compartilhada e limites](https://docs.cloud.google.com/run/docs/configuring/max-instances-limits).
- [Cloud Run — CPU boost durante a inicialização](https://docs.cloud.google.com/run/docs/configuring/services/cpu).
