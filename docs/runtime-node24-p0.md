# Release Node 24 — P0

Preparação validada em 10/09/2026. Publicação controlada executada em 14/09/2026.

## Resultado

As **36 Cloud Functions ativas do codebase padrão** estão em `nodejs24`, no estado `ACTIVE`, com a revisão mais nova pronta e 100% do tráfego. Nenhuma função ativa esperada ficou ausente ou em Node 20 e os vínculos de segredos das cinco entradas críticas conferidas permaneceram corretos.

Isso conclui a troca de runtime, mas **não conclui P0 nem o período de observação operacional desta release**. O smoke pós-publicação encontrou dois problemas reais e permitiu tratá-los de forma controlada:

- `pedidos` estava saudável, porém sem `roles/run.invoker` para `allUsers`; a chamada do dashboard parava antes do CORS com HTTP 403. Após autorização explícita, a permissão foi restaurada exclusivamente nesse serviço. O preflight retornou 204 com a origem do painel e o POST anônimo chegou ao handler, mas foi rejeitado com 401 por falta de sessão, como esperado.
- `criarPedido` está saudável e com tráfego integral na revisão nova, mas três probes inválidos receberam HTTP 503 `Rate exceeded` enquanto as instâncias do rollout ainda ocupavam a cota regional compartilhada de 20 vCPUs. Após a drenagem, o preflight retornou 204 com a origem correta e o POST anônimo retornou 401 pelo próprio handler. O checkout não ficou quebrado pela migração, mas o risco de capacidade já documentado foi reproduzido.

Existe ainda `processarNotificacaoCancelamentoCriada`, função legada em estado `FAILED` e `nodejs20`. Ela não pertence ao conjunto ativo nem recebe tráfego. Sua remoção não faz parte desta release e exige decisão própria.

## Escopo publicado

- Foram baixados os nove snapshots exatos que atendiam as 36 funções ativas em produção.
- Somente o runtime desses snapshots foi alterado para Node 24; a publicação ocorreu por canário e lotes pequenos.
- Alterações locais ainda não liberadas — inclusive novos endpoints de impressão — não entraram nos artefatos.
- Firestore Rules, Storage Rules, índices, Hosting, SSR do App Cliente e emissão fiscal não foram publicados nem alterados por esta release.
- Duas funções que falharam inicialmente por cota regional foram repetidas isoladamente e ficaram ativas. Nenhum deploy global foi usado.
- O build Linux revelou que o lockfile gerado no Windows não materializava `picomatch@4.0.7` para uma dependência de desenvolvimento. A versão foi fixada explicitamente, sem alteração de código executado, e a instalação pelo lockfile passou.

Como os artefatos usaram snapshots de produção e a árvore local contém trabalho futuro, o verificador completo de fingerprint contra a árvore atual continuará apontando divergência de código por desenho. Isso não significa que o runtime ficou parcial; impede apenas usar a árvore local inteira como rollback cego.

## Evidências locais

- Manifesto, lockfile, workflow do backend e verificador operacional exigem Node 24.
- Firebase CLI 15.29.0 reconhece `nodejs24` como GA.
- Testes unitários: **165 aprovados**, sem falhas, ignorados ou pendentes.
- Testes de regras/integração: **16 cenários aprovados** no Emulator Suite antes da publicação.
- Lint do backend: **54 arquivos aprovados**.
- Instalação limpa de produção: Firebase Admin/Functions carregados e FFmpeg executado.
- `npm ci --include=dev --dry-run` passou com o lockfile portátil corrigido.
- Auditoria pública: **196 arquivos**, zero bloqueios.
- Dependências de produção: zero alertas altos ou críticos; permanecem dez moderados herdados. Não foi usado `npm audit fix --force`.

## Evidências de produção

Consulta pós-publicação em 14/09/2026:

- Cloud Functions: 36 esperadas, 36 encontradas, 36 em `nodejs24`, todas `ACTIVE`.
- Cloud Run: 36 serviços encontrados; `latestReadyRevision` igual a `latestCreatedRevision` e 100% do tráfego na revisão mais nova em todos.
- Segredos conferidos em `webhookWhatsApp`, `webhookPedidos`, `webhookPedidosBackup`, `webhookAsaas` e `criarPedido`: zero divergências de chaves vinculadas.
- Antes do smoke de capacidade: zero logs de nível `ERROR` nas revisões atuais na janela de uma hora.
- Smoke seguro, sem credenciais válidas e sem efeitos externos: 16 de 20 verificações passaram na primeira rodada. Após a drenagem do rollout e a correção autorizada de IAM, as quatro verificações restantes passaram em repetições isoladas. Resultado final: **20/20 comportamentos esperados**, sem pedido, cobrança, mensagem ou cancelamento real.

Evidência detalhada: [publicação Node 24 de 14/09/2026](publicacao-node24-2026-09-14.md).

## Gate operacional restante

1. Observar erros 429/503, cold starts e tráfego real por pelo menos 24 horas; o probe de `criarPedido` já voltou ao comportamento correto após a drenagem.
2. Continuar observando a mitigação fracionada publicada em 15/09 nas cinco consultas públicas. Todas ficaram ativas, com 0,1666 CPU, concorrência 1, mínimo 0, máximo 4 e smoke seguro; o App Cliente recarregou o catálogo sem erros de console. A solicitação de 30 vCPUs foi negada e o limite permanece 20.
3. Não declarar P0 concluído apenas pela troca do runtime.

Referências: [runtimes suportados do Cloud Run functions](https://cloud.google.com/functions/docs/runtime-support) e [notas de versão do Cloud Run functions](https://cloud.google.com/functions/docs/release-notes).
