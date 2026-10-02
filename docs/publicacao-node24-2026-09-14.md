# Publicação controlada do backend em Node 24 — 14/09/2026

## Objetivo e limites

Trocar exclusivamente o runtime das Cloud Functions ativas do codebase padrão, preservando o código e a configuração de cada revisão de produção. A autorização não incluiu regras, Hosting, novos endpoints, impressão, emissão fiscal, aumento de cota ou remoção de funções legadas.

## Método

1. Inventário das funções ativas e download dos nove snapshots de fonte que as atendiam.
2. Cópia isolada de cada snapshot, mudança do runtime para `nodejs24` e instalação reprodutível.
3. Smoke local de importação/exportação, SDK Firebase e FFmpeg.
4. Canário e publicação serial em lotes pequenos, evitando um deploy global da árvore de desenvolvimento.
5. Conferência pelas APIs administrativas de Cloud Functions, Cloud Run, IAM, Secret Manager e Cloud Logging.
6. Probes negativos de CORS/autorização sem token válido e sem criação de pedido, cobrança ou mensagem.

## Resultado da infraestrutura

| Verificação | Resultado |
| --- | --- |
| Funções ativas esperadas | 36/36 encontradas |
| Runtime ativo | 36/36 em `nodejs24` |
| Estado das funções | 36/36 `ACTIVE` |
| Revisão e tráfego Cloud Run | 36/36 com revisão criada = pronta e 100% do tráfego |
| Segredos críticos conferidos | 5/5 sem divergência |
| Erros das revisões atuais antes do smoke | 0 na janela de uma hora |
| Função legada fora do conjunto | `processarNotificacaoCancelamentoCriada`, `FAILED`, Node 20, sem tráfego |

## Intercorrências controladas

- A plataforma recusou duas atualizações durante lotes maiores por saturação da cota regional. Elas foram repetidas uma por vez e concluíram; nenhuma função ativa ficou parcialmente migrada.
- Dois snapshots com ferramentas de desenvolvimento falharam no Cloud Build porque o lockfile vindo do Windows não incluía corretamente a variante Linux de `picomatch@4.0.7`. A dependência foi fixada explicitamente e a instalação completa passou. Não houve mudança no código de negócio.
- O primeiro smoke HTTP aprovou 16 de 20 verificações. `pedidos` não possuía invocador público no serviço e respondia 403 antes do handler; `criarPedido` respondeu `Rate exceeded` por falta de capacidade regional para iniciar uma instância. Após a drenagem do rollout, `criarPedido` voltou ao resultado esperado: OPTIONS 204 e POST anônimo 401, com a origem do App Cliente autorizada. Com autorização explícita, `roles/run.invoker` para `allUsers` foi restaurado somente em `pedidos`; seu OPTIONS passou com 204 e o POST anônimo foi rejeitado pelo handler com 401.

## Situação operacional

A migração de runtime está tecnicamente completa e os **20/20 comportamentos do smoke** foram confirmados sem efeitos externos. O período de observação permanece aberto. O checkout se recuperou após a drenagem, e o IAM de `pedidos` foi corrigido sem remover a autenticação interna. O problema de capacidade já existia em Node 20 e está documentado; esta publicação tornou a repetição visível, mas não autoriza aplicar silenciosamente a mitigação de CPU.

Nenhum resultado desta verificação prova capacidade para 600 pedidos/dia, conclusão de P0 ou segurança absoluta. Esses aceites continuam vinculados aos testes e gates do plano técnico.
