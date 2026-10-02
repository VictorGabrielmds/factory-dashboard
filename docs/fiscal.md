# Fiscal — preparação de pedidos (fase 1)

Prioridade em 22–23/09/2026: a evolução para emissão direta está detalhada no [plano fiscal prioritário](plano-acoes-fiscal-prioritario.md). A versão descrita abaixo continua sem transmitir documentos; o núcleo fiscal agora possui 60 testes locais aprovados. O usuário ainda não confirmou habilitação independente do InstaDelivery e ambiente de homologação com a EF.

## Limite desta versão

A aba **PDV → Fiscal** prepara e registra conferências. **Não cria pré-vendas, não emite, não cancela e não retransmite notas**. A emissão permanece bloqueada no servidor, independentemente dos parâmetros enviados pelo navegador.

Somente pedidos com `origem: app`, `clienteUid` e sem `avulso` entram nessa preparação. Pedidos do InstaDelivery e despesas de motoboys são recusados. Nenhum pedido original é alterado.

**Conferido** significa apenas que as validações locais desta fase passaram. Não significa autorização da SEFAZ, aprovação da contabilidade, confirmação bancária ao vivo ou aprovação definitiva da emissão.

## Credencial e acesso

- Projeto Firebase: `entregas-781a8`, região `southamerica-east1`.
- Secret Manager: `EFICIENCIA_FISCAL_TOKEN`, sem cópia no frontend ou em arquivos de configuração.
- CNPJ fixo no servidor: `11560207000137`.
- A função `fiscal` exige Firebase ID token válido (incluindo verificação de revogação) e documento `staff/{uid}` existente e não explicitamente inativo. A chave pública do painel não concede acesso fiscal.
- `fiscal_produtos`, `fiscal_conferencias` e `fiscal_sistema` são fechadas a acesso direto dos SDKs de cliente. O backend usa Admin SDK após verificar a equipe.
- Nunca registrar token, corpo bruto de erro do provedor ou configuração de requisição. Não usar um comando CLI que imprima o valor do secret em terminal/log.

## Fluxo disponível

1. **Testar conexão** executa somente GET no endpoint documentado de contingências. O retorno expõe apenas o resultado da conexão, não a lista financeira. Limite de 15 segundos, resposta até 1 MiB, sem redirecionamento e sem repetição automática. Testes compartilham uma janela de 30 segundos.
2. **Vínculos de produtos** associa cada produto do app ao código interno de um produto já existente na Eficiência Fiscal. Não há descoberta automática nem criação de produtos via API. O operador confere nome, código e figura tributária com orientação da contabilidade. Alterações removem a marcação de revisão na interface; renomear o produto invalida a conferência anterior.
3. **Conferir pedido** busca pelo ID exato, lê pedido/produtos/vínculos na mesma transação e confere origem, status, quantidades, centavos, soma dos itens, desconto, taxas, total, vínculo e evidências locais de pagamento.
4. **Preparar operação** cria em homologação um registro único por pedido, com snapshot e revisão imutáveis. Ele permanece com envio desabilitado e bloqueios explícitos; não chama a EF.
5. **Últimas conferências** abre o retrato salvo. Para considerar mudanças posteriores, é necessário clicar em **Atualizar conferência**.

Os valores vêm do pedido, não do preço atual do cardápio. Pedido aceito não é comprovante de pagamento. PIX exige os campos locais de confirmação, status `RECEIVED` e identificação da cobrança; antes da emissão futura ainda será necessária revalidação. Dinheiro/cartão permanecem como conferência manual pendente. Estornos e devoluções impedem conferência limpa. CPF do pagador PIX não é copiado para o destinatário fiscal.

## Persistência e concorrência

- Um registro atual por pedido em `fiscal_conferencias/{pedidoId}`.
- A conferência está na versão 2; conferências antigas precisam ser atualizadas antes de preparar uma operação.
- Revisões preservadas em `revisoes/{hash}`; repetir os mesmos dados não cria outra revisão. Isso evita duplicar conferências, **não é ainda uma garantia de idempotência de emissão fiscal**.
- Vínculos têm versão esperada, auditoria de operador/horário e histórico. Edição concorrente retorna conflito, sem sobrescrever silenciosamente.
- O retrato inclui uma referência externa estável prefixada `FDAPP_`, reservada para eventual uso futuro. Não é enviada ao provedor nesta fase.
- Catálogo limitado a 500 produtos, sinalizado pela interface se excedido; histórico inicial de 20 conferências.
- `fiscal_operacoes/{id}` usa ID determinístico por pedido, emitente e ambiente. A repetição da mesma revisão devolve a mesma operação; pedido ou vínculo alterado exige nova conferência.
- O registro preparado guarda snapshot e hashes, cria um evento auditável e declara `envioHabilitado: false`. Somente homologação é aceita nesta etapa.
- Emissão e cancelamento exigem capacidade fiscal explícita. Uma conta `operador_legado` pode continuar a preparação durante a transição, mas não herda ações que transmitiriam ou cancelariam documentos.
- As quatro coleções fiscais são negadas pelos SDKs clientes; acesso passa pelo backend autenticado.
- O contrato sintético da EF é um módulo puro, sem rede: formata centavos, monta pré-venda NFC-e com referência alfanumérica estável e valida a identidade da resposta. Ele não está ligado ao endpoint fiscal ativo.
- O contrato envia apenas `codigo_produto[]` já revisado e omite NCM/EAN/figura tributária de fallback. Taxa de entrega/cartão, item sem divisão unitária exata e PIX não confirmado são bloqueios explícitos, não arredondamentos ou decisões tributárias automáticas.
- A autorização sintética exige uma pré-venda persistida com `codigo_ef`. A validação de XML/DANFE devolve somente tamanho e hashes; armazenamento privado, reconciliação e consulta após timeout ainda não foram implementados.

## Máquina de estados da emissão (02/10/2026, não ligada ao endpoint)

`functions/src/fiscal/emissao.js` coordena pré-venda, autorização e consulta com um provedor injetado. Ainda não existe cliente HTTP real, e as ações de emissão continuam bloqueadas em `servico.js`.

- Estados: `preparada` → `pre_venda_solicitada` → `pre_venda_criada` → `autorizacao_solicitada` → `autorizada`, mais `rejeitada`, `inconclusiva` e `ambiente_divergente`. Cada transição grava um evento numerado em `eventos/`.
- A intenção e um identificador de execução com prazo são gravados antes de cada chamada externa. Clique duplo ou dois operadores recebem `EMISSAO_EM_ANDAMENTO`. Uma execução que expira sem concluir vira `inconclusiva`.
- Uma pré-venda inconclusiva pode ser reenviada com o mesmo `codigo_parceiro`, porque a documentação da EF diz que isso só atualiza a pré-venda. Uma autorização inconclusiva nunca é reenviada: `reconciliar` consulta `GET /venda/{referencia}/xml` com intervalo crescente (30 s até 30 min). Não encontrar o XML mantém a pendência.
- Ambiente: a EF troca homologação/produção no painel, para o CNPJ inteiro, com a mesma URL. `FISCAL_AMBIENTE` aceita só `homologacao` nesta fase. O `tpAmb` do XML precisa ser 2. Se vier 1 ou faltar, a operação vai para `ambiente_divergente` e `fiscal_sistema/emissao` trava novas emissões até conferência humana.
- Somente hashes e tamanhos do XML/DANFE são persistidos; o armazenamento privado dos documentos ainda falta.
- Testes: `functions/test/emissaoFiscal.test.js`, com EF simulada e um double de Firestore que repete transações em conflito.

## Validação local

```powershell
node --test functions/test/*.test.js
& 'C:\Program Files\nodejs\npm.cmd' run build
```

`functions/test/fiscal.test.js` cobre validações, autenticação, sanitização, histórico, conflitos, permissão fiscal explícita e preparação idempotente sem efeito externo. O armazenamento dos testes é um double em memória: não substitui testes do Firestore Emulator ou a verificação de IAM/CORS em ambiente publicado. As regras fiscais também participam da suíte do emulador.

A fixture `.codex-temp/fiscal-preview.html` permite testar a interface isolada com dados fictícios. Não é importada pelo app nem incluída na entrada do build de produção. Não prova integração ponta a ponta com Firebase/EF.

Verificação em 03/09/2026: build de produção aprovado; 83 testes de backend aprovados (50 fiscais); ESLint sem apontamentos nos três arquivos TS/TSX envolvidos. No navegador, com fixture local: carregamento, conferência com pendência, edição/revisão de vínculo, reset da revisão após edição, atualização da conferência, erro de pedido inexistente e navegação por setas entre abas. Layouts claro/escuro verificados em desktop e viewports de 390/320 px, sem transbordamento da página ou erros de runtime capturados. A função também carregou corretamente pelo entrypoint do backend, sem invocação. Não houve teste end-to-end contra uma função publicada, emissão real ou validação das regras no emulador.

Verificação local em 23/09/2026: 60/60 testes fiscais, 175/175 testes unitários do backend, lint de 56 arquivos e 16/16 cenários do Emulator Suite aprovados. Os testes fiscais recentes cobrem capacidade explícita, operação única, alteração após conferência, bloqueio do ambiente de produção e contrato sintético de pré-venda/autorização. Nenhuma chamada de criação/autorização/cancelamento foi enviada à EF.

## Publicação separada, sob autorização

Nenhum deploy é feito como parte desta implementação local. Quando autorizado, revisar primeiro o diff completo das regras (o workspace contém outras mudanças) e publicar somente os alvos necessários:

```powershell
firebase deploy --project entregas-781a8 --only functions:fiscal,firestore:rules,hosting:painel
```

Confirmar acesso do runtime ao secret, autenticação da equipe, negação de acesso por cliente comum, CORS da origem real, gravação/leitura das conferências e teste de conexão sem emissão. Não alterar permissões globais para contornar uma falha de acesso.

## Antes de liberar emissão real

- Revisão contábil das figuras tributárias, produtos, descontos, frete/taxa e dados do destinatário; não presumir NCM, CFOP, CST/CSOSN ou modelo fiscal.
- Confirmar com a Eficiência Fiscal ambiente de homologação, modelo/documento, regras de entrega/retirada e momento de emissão.
- Resolver a consulta de resultado: a listagem de vendas autenticada apresentou timeout; não usá-la como prova de ausência de nota.
- Confirmar identificação inequívoca de uma nota por referência externa, estados retornados, timeout de autorização e idempotência suportada. Timeout não permite tentar autorizar novamente às cegas.
- Implementar máquina de estados, bloqueios transacionais contra alteração/cancelamento do pedido durante emissão, reconciliação, permissões específicas de emissão/cancelamento e trilha de auditoria.
- Validar autorização, rejeição, contingência, recuperação após resposta perdida, cancelamento e armazenamento seguro de XML/documentos antes de ativar produção.
- Definir corte da integração anterior para não emitir duas vezes a mesma venda. Não reemitir automaticamente pedidos históricos.

Documentação fornecida pelo provedor: [API Eficiência Fiscal](https://documenter.getpostman.com/view/39069917/2sBYAq1Dr8).
