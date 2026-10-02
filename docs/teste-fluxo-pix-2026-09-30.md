# Ensaio do checkout PIX — 30/09/2026

## Conclusão

**Correções locais verificadas: 15 cenários aprovados às 14:21:06 UTC (11:21 de Fortaleza).** O defeito de total/frete e o feedback técnico `internal`, encontrados no primeiro ensaio, foram corrigidos no App Cliente e retestados. Isso aprova o recorte local, não certifica todo o ambiente de produção. Nenhum deploy, pedido real, cobrança real ou WhatsApp real foi feito neste ensaio.

## Correções e verificação final

- `src/hooks/useFreteCheckout.ts` no App Cliente: prévia vinculada ao tipo/bairro/revisão, bloqueio desde o render anterior ao debounce, descarte de respostas antigas e limite de 15 s para consulta. Erro exibe ação de recalcular; reconexão solicita nova prévia.
- `CarrinhoContext.tsx`: utiliza a prévia isolada e bloqueia também a função de finalização enquanto o frete estiver pendente/com erro. A chave e a recuperação da tentativa anterior foram preservadas.
- `PassoResumo.tsx`: total exibe “Aguardando frete”, botão exibe “Calculando frete...” ou “Frete indisponível” e permanece desabilitado; modal não permite confirmação sem prévia. Há botão para recalcular e alertas acessíveis.
- `src/lib/checkoutFeedback.ts`: rede offline/timeout/erros internos viram instruções de recuperar a mesma tentativa; erros técnicos não são exibidos diretamente. Validações de negócio destinadas ao cliente são preservadas.
- A revisão React/Next.js orientou a separação da consulta em hook, estados derivados pela chave atual, cleanup das consultas/listener e preservação da fronteira cliente/servidor. Não foram adicionadas dependências nem alterada a autoridade do backend para preços.

Resultados finais:

| Verificação | Resultado |
| --- | --- |
| Suíte navegador + handlers + emuladores | **15/15**, sem testes ignorados |
| Frete lento | 0 pedidos antes da prévia; função e botão bloqueados; depois total mostrado/pedido/PIX = 5,85 |
| Erro de frete | Bloqueado até recalcular com sucesso, sem pedido/cobrança durante falha |
| Respostas fora de ordem | Resposta antiga de taxa 5 não sobrescreve taxa 9 do bairro atual; PIX final 9,85 |
| Rede offline/resposta perdida | Texto compreensível e mesma tentativa recuperada; sem duplicação |
| Backend unitário | 182/182 |
| Feedback unitário | 3/3 |
| Lint backend | 56 arquivos aprovados |
| TypeScript/lint App Cliente | Aprovados; lint direcionado aos 5 arquivos alterados |
| Build App Cliente | Next.js 16.2.10, compilação/TypeScript/8 páginas estáticas aprovados |

Evidências: `functions/test/fluxoPix/artifacts/resultado.json`, `frete-pendente-corrigido.png` e `checkout-delivery-mobile.png`. O teste anteriormente vermelho está verde por correção do comportamento, não por remoção do bloqueio esperado.

Comando adicional de teste: `node --test functions/test/fluxoPix/feedback.test.cjs` (Node 24; `APP_CLIENTE_DIR` opcional).

Limite mantido: esta correção não implementa cotação versionada/reconfirmação se o gestor mudar preço/frete no servidor entre uma prévia válida e o commit. Não foi alterada a política de reprecificação do backend.

## Histórico — evidências funcionais iniciais

Execução completa às 13:57:37 UTC: 12 aprovados, zero falhas nos cenários então existentes.

| Cenário | Evidência |
| --- | --- |
| Formulário incompleto e clique duplo | Incompleto não cria pedido; clique duplo cria 1 pedido e 1 cobrança. Nome digitado preservado. |
| Confirmação e dashboard | Card aparece em Aguardando PIX; após pagamento, o mesmo ID aparece em Aguardando pedidos e sai da coluna PIX. |
| Webhook repetido 5 vezes | 1 evento durável, 1 registro financeiro, 1 chamada de notificação simulada. |
| Offline antes do envio | 0 pedidos durante queda; reconexão recupera 1 pedido e 1 PIX. Mensagem inadequada: `internal`. |
| Resposta perdida após commit | Mesmo após recarga e nova finalização: 1 pedido, 1 PIX, 1 POST de criação no provedor. |
| Provedor lento | 2,5 s de criação + 1,5 s de QR, com estado Finalizando e sem duplicação. Não é ensaio de capacidade/cold start em nuvem. |
| Pagamento antes do retorno do QR | Estado RECEIVED e status operacional 2 preservados após conclusão do QR. |
| Webhook perdido | Invocação local do reconciliador confirma o pagamento exato. Não comprova agendamento automático em produção. |
| Payload adulterado | Quantidade 101 rejeitada sem pedido/cobrança. Não é auditoria completa de segurança. |
| Delivery | Endereço incompleto impedido; backend grava frete 5, total/PIX 5,85; card observado antes e depois do pagamento. Total exibido tem a falha abaixo. |
| Pagamento enquanto cliente offline | Backend confirma; tela do cliente passa a Status do pedido após reconexão. |
| Valor divergente | PIX com valor acrescido de 10 não confirma nem promove pedido; gera pendência. |
| Resposta do Asaas perdida | Consulta recupera cobrança exata; não faz um segundo POST de criação. |
| 50 chamadas da mesma tentativa | 50 respostas de sucesso, apenas 1 pedido/PIX/POST. Não equivale a 50 clientes independentes. |

Alguns cenários agrupam múltiplas verificações; a tabela tem mais linhas que os 12 testes.

## Histórico — falha reproduzida antes da correção

Reprodução isolada às 14:00:20 UTC, usando também o handler real de consulta de taxa:

1. Cliente preenche retirada, horário e PIX.
2. Volta, troca para delivery e informa endereço válido.
3. A consulta de frete demora 12 s (simulada no harness).
4. O app permite abrir e confirmar o modal com **R$ 0,85**.
5. Backend corretamente recalcula o frete de R$ 5 e grava/cobra **R$ 5,85**.

Evidência: `functions/test/fluxoPix/artifacts/falha-frete-pendente.png` e resultado JSON local. Teste: `frete ainda não calculado deve impedir confirmação com total incompleto`.

Causa observada no App Cliente:

- `CarrinhoContext.tsx`: estado de carregamento começa somente após o debounce de 600 ms; respostas antigas não são descartadas por bairro/versão.
- `PassoResumo.tsx`: `podeFinalizar` não exige consulta de frete concluída/sem erro para o endereço atual.
- `finalizarPedido` não impede envio com prévia de frete ainda pendente.

Correção proposta na investigação inicial e agora implementada acima: prévia vinculada ao bairro atual, carregamento desde a alteração, descarte de respostas antigas e bloqueio explícito da confirmação enquanto pendente/com erro. Mudanças de preço entre prévia e commit precisam de política de reconfirmação, sem confiar em preço enviado pelo navegador.

## Histórico — feedback de rede antes da correção

Na queda de conexão, `FunctionsError.message` é exibida diretamente, resultando em `internal`. Não houve duplicação ou perda nesse cenário, mas falta orientar que a confirmação ainda é incerta, que a tentativa será recuperada e que o cliente não deve iniciar outra compra. Não afirmar fracasso definitivo quando a resposta pode ter se perdido.

## Correção local já preparada

`functions/src/services/checkoutConfiavel.js`: obter/persistir QR não promove pedido não pago de status 1 para 2. Preserva status operacional existente e fatos financeiros já gravados (inclusive estorno/cancelamento). Comentários do checkout atualizados. Regressão unitária cobre inicialização, QR posterior ao recebimento e preservação de estornos/cancelamento.

182 testes unitários aprovados; lint backend aprovado em 56 arquivos. Não foi publicado. A suíte E2E final de 15 cenários foi reexecutada com a versão local atual; estorno/cancelamento tardio continua coberto especificamente pela regressão unitária.

## Alcance e próximos gates

Harness local: componentes reais via Vite, handlers reais e Auth/Firestore emulados, provedores simulados. Não cobre build Next.js publicado, login OTP/visitante, App Check, IAM/CORS publicado, retomada de navegador totalmente fechado, storage indisponível, todos os tamanhos/layouts, 50 checkouts independentes, falha regional, provedor real ou impressão. O shell global do dashboard não foi montado; screenshots não certificam seu layout completo.

Próximo passo: publicação pequena e autorizada, seguida de verificação da versão publicada e homologação controlada. Publicação e testes que gerem efeitos reais precisam de autorização própria. Estes resultados não comprovam 100% de confiabilidade.
