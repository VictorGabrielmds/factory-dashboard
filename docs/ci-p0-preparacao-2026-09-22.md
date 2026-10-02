# CI remoto do P0 — publicado e verificado em 22/09/2026

## Estado

O workflow em `.github/workflows/verificacao.yml` foi publicado e executado com sucesso em dois destinos, após o usuário autorizar explicitamente ambos:

| Repositório | Visibilidade e branch | Execução | Resultado |
|---|---|---|---|
| [factory-dashboard](https://github.com/VictorGabrielmds/factory-dashboard) | Público, `codex/p0-ci-verificacao` | [Verificação #35784747807](https://github.com/VictorGabrielmds/factory-dashboard/actions/runs/35784747807) | Painel e backend concluídos com sucesso |
| [factory-dashboard-interno](https://github.com/VictorGabrielmds/factory-dashboard-interno) | Privado, `main` | [Verificação #35785095082](https://github.com/VictorGabrielmds/factory-dashboard-interno/actions/runs/35785095082) | Painel e backend concluídos com sucesso |

Ambos executaram o commit `087ac42b0b0ed22dd3ac6211f999bbdec90a9bc1`. A branch `main` do repositório público continua com apenas `README.md`; o código publicado nela está na branch `codex/p0-ci-verificacao`. O repositório privado é a cópia com `main` pronta para futuras verificações. Como o código também foi enviado ao repositório público, a cópia privada não retira sua exposição pública.

A cópia local de publicação está em `.codex-temp/ci-publish`, na branch `codex/p0-ci-verificacao`. Ela partiu da `main` pública e contém 230 arquivos necessários aos jobs de painel e backend. A pasta é temporária, ignorada pelo Git; o checkout principal não teve seus arquivos preparados para commit.

## Escopo do workflow

- Painel: Node 20, instalação limpa, lint, testes do detector de exposição, auditoria real de exposição e build.
- Backend: Node 24, Java 21, instalação limpa, lint, 165 testes unitários e 16 cenários com Firestore/Storage emulados num projeto `demo-*`.
- A permissão do workflow é `contents: read`; não usa segredos, credenciais de produção ou comandos de deploy.

O pacote isolado não inclui `docs/`, `.env`, credenciais, caches locais, `node_modules` nem artefatos de build. A auditoria de exposição do pacote inspecionou 186 arquivos de aplicação e encontrou zero bloqueios. A triagem é por padrões e não prova ausência de todo dado sensível.

## Verificações locais

- Lint do painel: passou com três avisos preexistentes, sem erros.
- Testes do detector de exposição: 4/4.
- Backend: 165/165 testes unitários e 16/16 cenários do emulador.
- Build do painel: TypeScript e Vite geraram os arquivos; depois disso, o Node 24 no Windows encerrou com uma falha interna (`UV_HANDLE_CLOSING`) e código 1. Os dois jobs remotos de painel usaram Node 20 em Linux e concluíram com sucesso.
- Auditoria do pacote: 186 arquivos verificados, zero bloqueios.

## Limites e próximo gate

A execução remota do CI está comprovada para este commit. Ainda faltam proteção de branch, testes de UI/E2E, carga e o gate CI-03 completo de comparação do artefato em produção com o testado. Nenhum deploy de aplicação ou migração de dados foi feito por estes workflows.
