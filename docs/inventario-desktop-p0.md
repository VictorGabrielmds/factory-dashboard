# P0 — inventário do robô desktop

Inspeção em 09/09/2026. **Código e pacote locais identificados; versão 1.2.3 instalada na loja confirmada pelo usuário.** Os hashes do EXE/DLL no PC da loja ainda não foram conferidos; a confirmação da versão não comprova identidade binária com o pacote local. Nenhum executável iniciado, nenhuma impressão, nenhum acesso a pedidos reais e nenhuma credencial lida, alterada ou revogada nesta rodada.

## Identificação e evidência

- Projeto: `C:/Users/vgmds/source/repos/RoboImpressaoDelivery/RoboImpressaoDelivery`.
- C# / Windows Forms, `net10.0-windows`. Fonte declara versão `1.2.3`; EXE local informa `1.2.3.0`.
- Pacote `RoboImpressaoDelivery-v1.2.3.zip`: 301 entradas. Publicações anteriores 1.1.0 e 1.2.0–1.2.2 também existem; não foram revalidadas nesta rodada.
- 18 arquivos `.cs`/`.csproj` inspecionados pela triagem. Não foi encontrado projeto de testes/workflow nos caminhos pesquisados; isso não comprova ausência em outras cópias do software.
- EXE local sem assinatura digital (`NotSigned`). O instalador remove a marca de download dos arquivos do programa; isso não cria uma assinatura digital.
- Não há manifesto de build que comprove que todos os arquivos fonte inspecionados produziram este binário. Versão igual não é prova dessa correspondência ou da instalação na loja.

SHA-256 dos artefatos locais:

| Artefato | SHA-256 |
| --- | --- |
| ZIP 1.2.3 | `2e3d5c51b5bcacc27abd8e2a52bd6bc049eaa3eb20aade609f838dbc21657d22` |
| EXE publicado 1.2.3 | `5eb26d8d4037087d6bdda1fe47630088e60d2637c1bc7ccfbc84492c90632ebf` |
| DLL publicada 1.2.3 | `418ad7c91732aae9671c64e3331295efe25289990ba6437a134ca46548e0159d` |
| `Form1.cs` | `cb0ecb7b1631837d20525530413ce860bd3c1abba7f72f80bf3ded35f6234bef` |

## Acessos observados

| Superfície | Uso atual | Limite a migrar |
| --- | --- | --- |
| Credencial Google | `Form1.cs:20` fixa caminho de JSON de conta de serviço em `C:/Windows`; linhas 830–831 e 1003–1004 definem ADC e criam `FirestoreDb` | Nenhuma conta de serviço/chave administrativa no dispositivo; identidade de dispositivo revogável |
| `pedidos` | Listener por `status == 2`, consulta por ID, consultas auxiliares e atualização de `impresso` | Receber somente trabalhos atribuídos e dados mínimos da nota; comandos de impressão validados pelo backend |
| `sistema/robo_impressao` | Heartbeat compartilhado com online, horário, impressora, modo e contagem de pendências | Heartbeat por dispositivo, com versão/identificador de build, sem permitir sobrescrever outro dispositivo |
| Impressora de rede | TCP 9100, teste de papel e envio de bytes | Resultado de envio separado de confirmação física; tratar envio parcial como inconclusivo |
| Impressora Windows | Fila local via `winspool.drv` / `WritePrinter` | Aceite no spooler não equivale à saída física do papel |
| Persistência local | `%LOCALAPPDATA%/RoboImpressaoDelivery/config.json`, histórico de até 300 pedidos em `pedidos_recentes.json` e logs em `logs/robo.log` | Revisar retenção, permissões locais e proteção de dados; não enviar esses arquivos no pacote |

Não foi encontrada referência a `PANEL_API_KEY` ou cliente HTTP nos arquivos fonte examinados. **A dependência observada do robô é outra: a credencial Google.** Isso não prova que nenhuma versão antiga ou outro consumidor usa a chave do painel. Não revogar nenhum dos dois mecanismos com base apenas neste inventário.

O SDK de servidor do Firestore usa IAM e não as regras de acesso do navegador. Portanto, restringir `firestore.rules` não limita automaticamente essa credencial. Na triagem inicial, identidade e IAM ainda não estavam confirmados; a auditoria complementar abaixo confirmou os vínculos diretos da conta local. Não presumir papel Owner nem acesso ilimitado. [Documentação oficial](https://firebase.google.com/docs/firestore/security/insecure-rules).

## Riscos adicionais observados no código

1. **Reserva e sucesso confundidos:** `ReservarImpressaoAsync` (`Form1.cs:1662`) grava `impresso = true` antes do envio. Encerramento abrupto entre a reserva e a impressora pode deixar trabalho não executado marcado como impresso; não há lease/estado separado nessa reserva.
2. **Falha da trava permite continuar:** a reserva retorna `null` quando a transação falha; `ImprimirComFeedbackAsync` (`Form1.cs:1885`) interrompe somente em `false`. Assim, o caminho automático pode tentar imprimir sem exclusividade confirmada.
3. **Retentativa após envio inconclusivo:** a rotina tenta novamente após erro do transporte, inclusive possível envio parcial. Existe risco de duplicação de papel; não afirmar que houve duplicação real sem evidência operacional.
4. **Cache/log local:** histórico grava nome, ID, pagamento/status sem criptografia explícita no código; logger inclui mensagem/stack trace de exceções. Não foram lidos arquivos reais de clientes para esta auditoria.

Esses achados entram em SEC-04/06/07 e OPS-01. Não foram corrigidos silenciosamente no robô da loja. A correção de identidade em P0 deve preservar configurações/USB/rede e será entregue com testes; a fila durável completa continua vinculada a P1/P3, sem substituir segurança por marcações otimistas de sucesso.

## Triagem automatizada adicionada

`npm run audit:desktop` no dashboard lê somente fontes `.cs`/`.csproj`, nomes de entradas do ZIP e metadados/hashes do executável local. Não lê JSON de credenciais/configuração/histórico, não extrai ZIP e não inicializa SDK Firebase ou o robô. O subprocesso PowerShell fica oculto e não recebe caminhos por interpolação de comandos.

Execução em `2026-09-09T20:02:19.418Z`: **cinco achados estáticos**, exit code 1 esperado, pois há legado a remover. São referências à credencial/SDK/acesso direto e assinatura ausente; a contagem não representa cinco vulnerabilidades independentes. Nenhum nome de arquivo suspeito de credencial/histórico foi apontado no ZIP analisado. Isso não descarta segredos dentro de binários ou arquivos renomeados.

O resultado nunca dá aprovação automática de produção, mesmo sem achados. Exit 2 indica inventário indisponível. A detecção é heurística e não substitui revisão, análise do binário, IAM ou teste do PC da loja.

Sete testes novos em `functions/test/auditoriaDesktop.test.js` validam detecção, saída sem segredos, pacote com dados locais e inventário incompleto. Suíte total: **131 unitários aprovados**. Os 11 cenários de emulador da publicação anterior permanecem a última evidência de integração; não foram reexecutados nesta auditoria sem mudança de handlers/regras.

## Próxima mudança, sem interromper a operação

1. Versão 1.2.3 confirmada pelo usuário no PC da loja. Ainda conferir hash EXE + DLL; o heartbeat atual não informa versão/build, e o auditor local não inspeciona o PC remoto. O resultado histórico da triagem acima permanece como foi executado, antes dessa confirmação.
2. Identificar a conta de serviço efetivamente instalada e seus consumidores/permissões por metadados, sem compartilhar o arquivo de chave no chat.
3. Implementar e testar uma interface restrita de impressão: dispositivo ativo e revogável, acesso apenas ao próprio trabalho, payload mínimo, tamanho/paginação limitados e recibos que não alterem pagamento ou outros campos do pedido. Não converter o dispositivo em staff para contornar a autorização.
4. Separar reserva, envio, aceite do transporte, falha definitiva e resultado inconclusivo. Bloquear envio quando exclusividade não puder ser confirmada; não repetir automaticamente uma tentativa que pode já ter chegado à impressora.
5. Preparar nova versão com identificação de build e testes usando impressora falsa. Instalar de forma coordenada em horário seguro, validar com o operador e só então revogar a credencial antiga após conferir outros consumidores. Não apagar histórico/configuração durante a atualização.

Nenhum deploy, novo executável, mudança de IAM ou revogação faz parte desta rodada de inventário.

## Auditoria complementar IAM e preparação local — 09/09/2026

Consulta concluída em `2026-09-09T20:54:18.542Z`, pela sessão autenticada da CLI, sem usar a chave do robô para autenticar. O arquivo JSON local foi processado em memória para extrair apenas projeto, e-mail da conta e identificador da chave; nenhum conteúdo de chave privada foi exibido ou copiado. Isso é distinto da triagem inicial, que não abriu o JSON.

- Conta: `firebase-adminsdk-ttnmu@entregas-781a8.iam.gserviceaccount.com`, ativa.
- Chave local encontrada no IAM, não desativada, validade retornada `9999-12-31T23:59:59Z`; identificador reduzido por SHA-256: `9f896020328c`.
- Papéis diretos incondicionais no projeto: `roles/firebase.sdkAdminServiceAgent`, `roles/firebaseappcheck.admin`, `roles/firebaseauth.admin`, `roles/iam.serviceAccountTokenCreator` e `roles/storage.admin`.
- As permissões desses papéis incluem criar/alterar/excluir entidades, gerenciar usuários, administrar objetos do Storage e gerar tokens/assinaturas. São muito mais amplas do que imprimir recibos. Não foi feita análise completa de permissões efetivas considerando deny policies/herança.
- Listagens consultadas não encontraram Cloud Functions nem serviços Cloud Run em `southamerica-east1` usando essa conta como identidade de execução. Isso **não** comprova ausência de consumidores da chave: não cobre outros PCs, arquivos embutidos, outros projetos, todos os recursos/regiões ou uso de chave dentro de uma função com outra identidade de execução.
- A cópia da credencial no PC da loja ainda não foi comparada. **Não revogar nem reduzir os papéis com base somente nesta listagem.**

Reexecução read-only: `npm run audit:desktop:iam`. Requer sessão autorizada da CLI; não roda no CI. O script reporta consultas incompletas sem interpretá-las como ausência de consumidores.

A primeira base de acesso restrito, o pareamento, o ciclo conservador de trabalho e o produtor próprio estão implementados e testados localmente, sem deploy ou alteração operacional do desktop. Contrato, limitações e próximos passos: [acesso restrito à impressão](acesso-restrito-impressao.md). Validação deste recorte: **160 unitários, 16 testes de emulador e lint de 54 arquivos aprovados**. Não houve impressão, emissão fiscal, alteração de IAM ou cadastro de dispositivo em produção.

O projeto desktop recebeu as classes locais de sessão (`SessaoDispositivoStore.cs`), cliente de pareamento (`ClientePareamentoImpressao.cs`) e modal acessível por **Vincular computador** (`Form1.Pareamento.cs`). Elas usam DPAPI por usuário do Windows para o refresh token e HTTP TLS para resgate/confirmação/renovação; não foram ligadas ao listener legado nem publicadas. A compilação Release terminou com zero erros. O restore revelou `SixLabors.ImageSharp 2.1.3` transitivo de `ESCPOS_NET 3.0.0` com advisories de segurança; não atualizar a biblioteca de impressão sem teste físico isolado.

## Reexecução de inventário — 10/09/2026

Foram repetidas duas auditorias somente leitura, sem iniciar o robô, acessar pedidos, alterar IAM ou revelar chave privada.

- A triagem local voltou a encontrar os cinco bloqueios esperados: caminho da credencial, SDK/Admin Firestore e leitura direta de `pedidos` em `Form1.cs`, dependência Firestore no projeto e EXE sem assinatura válida. O pacote local continua em `1.2.3.0`, com os mesmos hashes registrados acima.
- A busca textual fora de artefatos encontrou o uso efetivo da credencial do robô apenas no projeto `RoboImpressaoDelivery/Form1.cs`. Um script de desenvolvimento em `.ja-pizza-stage` cria credencial temporária por sessão de CLI ou recebe caminho de credencial como parâmetro; não há evidência de que ele use a chave do robô, portanto não é classificado como consumidor confirmado.
- A auditoria IAM confirmou novamente a conta local e a chave reduzida `9f896020328c`, ambas ativas, com os cinco papéis administrativos diretos já listados. Functions Gen 1/2, assinaturas push do Pub/Sub e gatilhos Cloud Build foram consultados e não retornaram recursos usando essa identidade.
- A consulta abrangente de Cloud Run, Jobs, Scheduler, Workflows e Compute não pôde ser concluída pela API/permissões da sessão atual. O relatório mantém esses itens como **não consultados**, não como inexistentes. A consulta anterior de Cloud Run em `southamerica-east1` não encontrou serviço usando a conta, mas não cobre outras regiões.

Para concluir a evidência essencial no computador físico, executar o coletor read-only [coletar-evidencia-robo.ps1](../scripts/coletar-evidencia-robo.ps1) **no PC da loja**, apontando para o `RoboImpressaoDelivery.exe` instalado. Ele mostra somente versão, hash, status da assinatura, conta de serviço e impressão reduzida do ID da chave; não envia dados, não acessa Firebase e não exibe chave privada. O resultado deve ser comparado ao pacote local:

- EXE: `5eb26d8d4037087d6bdda1fe47630088e60d2637c1bc7ccfbc84492c90632ebf`
- DLL: `418ad7c91732aae9671c64e3331295efe25289990ba6437a134ca46548e0159d`
- impressão reduzida da chave: `9f896020328c`

Se qualquer valor divergir, interromper a migração/revogação e tratar o binário ou a credencial instalada como consumidor adicional a investigar. Mesmo se todos coincidirem, ainda é necessária a conferência dos recursos não consultados e uma troca coordenada antes de revogar a chave antiga.

## Exposição pública e CI — 10/09/2026

- O repositório remoto `VictorGabrielmds/factory-dashboard` foi consultado somente para leitura. Ele é público, mas o `main` contém somente um `README.md`; não foram encontrados arquivos de código, configuração, fluxo do GitHub Actions ou credencial nessa cópia remota. Isso não é uma aprovação para publicar este diretório: o histórico local e o remoto não têm ancestral comum.
- O workflow local `.github/workflows/verificacao.yml` cobre lint, teste de exposição, build do painel e lint/testes/regras do backend. Como ele ainda não existe no remoto, **CI remoto não está comprovado**. Publicá-lo requer primeiro versionar a baseline correta em uma ramificação limpa, sem enviar o diretório de trabalho inteiro por acidente.
- Foi criada a auditoria `npm run audit:public-exposure`, com quatro testes em `scripts/test/auditoria-exposicao-publica.test.cjs`. Ela examina as superfícies que podem ser publicadas e devolve somente código, arquivo e linha — nunca valores encontrados. Bloqueia chave privada, credencial administrativa, token literal em URL, `Bearer` literal e chave de Geocoding embutida; a identificação pública do Firebase permanece permitida.
- A auditoria encontrou e a revisão local removeu: um token real presente apenas em comentário de webhook e uma chave real de Geocoding usada como fallback num script manual. O webhook não foi alterado; o script de geocodificação agora exige `GOOGLE_MAPS_API_KEY` no ambiente quando for executado. Resultado final: 194 arquivos, zero bloqueios. Nenhum segredo foi exibido, salvo em Secret Manager, publicado, revogado ou usado para chamar API nesta revisão.
- O `.gitignore` passou a bloquear extensões de chave e nomes usuais de contas de serviço. Isso reduz erro futuro de commit, mas não substitui a auditoria nem remove arquivos já versionados no histórico.
