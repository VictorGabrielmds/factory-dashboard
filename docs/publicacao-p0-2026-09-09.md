# Publicação P0 — 09/09/2026

Resultado final: **aprovado no recorte verificado**, às `2026-09-09T19:43:12.603Z` (16:43 de Fortaleza). Comando `npm run verify:release` equivalente a `node scripts/verificar-publicacao.cjs`; saída `ok: true`, `smokeExecutado: true`, exit code 0. Projeto `entregas-781a8`, região `southamerica-east1`.

Fingerprint do pacote de fontes: `49d1a68dd08b752d4384d8dd5a7658484ba50fc5`, conforme algoritmo da CLI Firebase 15.29.0. Cada função também teve o fingerprint de ambiente/vínculos de segredos conferido, sem consultar valores dos segredos.

## Recursos conferidos

| Função | Revisão pronta, recebendo 100% do tráfego |
| --- | --- |
| `chat` | `chat-00068-huz` |
| `conversas` | `conversas-00072-koy` |
| `clientes` | `clientes-00004-ciy` |
| `configuracoes` | `configuracoes-00069-liw` |
| `pendencias` | `pendencias-00033-taq` |
| `processarEventoMeta` | `processareventometa-00021-suh` |

Todas ACTIVE, entrypoint/runtime correspondentes e nenhuma com `PANEL_API_KEY` vinculada. Gatilho do processador Meta: criação em `eventos_meta/{eventoId}`, com retentativa. Além disso:

- Regras Firestore e Storage publicadas iguais aos arquivos locais.
- Papel `roles/firebaserules.firestoreServiceAgent` conferido para o agente gerenciado do Storage. Aplicado após autorização explícita do usuário, preservando a política existente e etag. A permissão é `datastore.entities.get`, sem escrita; não foi concedida a usuários ou visitantes. [Referência oficial](https://docs.cloud.google.com/iam/docs/roles-permissions/firebaserules#firebaserules.firestoreServiceAgent).
- Índice servido em `https://entregas-781a8-painel.web.app/` igual ao build local já publicado. Nenhum deploy novo de UI nesta rodada.
- Nas cinco APIs HTTP, tanto `cloudfunctions.net` quanto `run.app`: preflight 204 com origem/Authorization corretos, sem sessão 401 `SESSAO_NECESSARIA`, token inválido 401 `SESSAO_INVALIDA`, mantendo CORS no erro. POST sempre com ação inexistente e sem dados de negócio.

## Testes e ajustes da entrega

- 124 testes unitários aprovados; 11 cenários de regras/integração aprovados no projeto emulado `demo-factory-dashboard`.
- Integração nova: entrega/leitura, callback de falha repetido sem reenvio e falha anterior à persistência do ID da mensagem.
- Backend: 49 arquivos na verificação estática. Lint painel: zero erros e três avisos preexistentes de hooks/Fast Refresh.
- Regressões de publicação: função ausente/falha, versão antiga, revisão não pronta, tráfego antigo, CORS/autenticação incorretos e vínculo de segredo legado. APIs sem segredo agora declaram lista vazia explicitamente.
- Pacote de funções exclui testes, arquivos `.env`, configuração local e logs de emulador; alterações nesses arquivos não mudam a versão do código executável publicado.

## Ocorrências e limites

A auditoria inicial encontrou cinco APIs ainda na versão com chave compartilhada, processador Meta antigo e Storage não publicado. O deploy conjunto teve falhas de quota de CPU em duas funções. As funções foram publicadas individualmente, sem ampliar cotas ou alterar recursos. O verificador também detectou que omitir `secrets` preservava vínculos antigos e que o deploy não interativo não provisionava a permissão Firestore do Storage. Ambos foram corrigidos.

Não foram alterados/deployados checkout, PIX, emissão fiscal ou runtime nesta rodada. Nenhum pedido, pagamento ou mensagem de teste foi criado em produção. O segredo antigo e o recurso falho `processarNotificacaoCancelamentoCriada` não foram apagados.

Esta evidência não conclui P0/CI-03 integralmente: faltam inventário do desktop/consumidores, revogação da chave antiga quando segura, política estrita por operador, auditoria de URLs de download/ACLs e campos privados, demais IAM/índices/cotas/App Check, CI remoto, E2E autenticado e carga. O smoke prova rejeições e configuração; não comprova sozinho o fluxo completo de um operador legítimo ou a entrega real de WhatsApp.
