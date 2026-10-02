# Checkout PIX — ensaio local isolado

Este harness executa componentes reais de carrinho/pedido/dashboard, handlers de checkout/webhook/conciliação e transações no Firestore Emulator. Somente dados sintéticos. Asaas e Meta são simulados no transporte axios; nunca se cria cobrança ou mensagem real.

## Limites de evidência

- Não é o build Next.js/Hosting de produção: Vite adapta navegação, links, imagens e inicialização Firebase.
- Catálogo de entrada e login são fixtures. Não cobre OTP, App Check, IAM/CORS publicado, SSR/service worker, impressão nem entrega efetiva de WhatsApp.
- O projeto deve ser exatamente `demo-fluxo-pix`. O seed apaga somente os documentos desse projeto no emulador localhost:8085. Não executar com dados que se queira preservar nesse emulador.
- Backend ligado a localhost:5057, sem autenticação nas rotas `/test/*`: nunca publicar este servidor ou expor suas portas.
- As suítes E2E devem rodar em sequência, não em paralelo: compartilham fixtures e estado do provedor simulado.
- O painel é montado sem o shell completo. A comprovação visual refere-se aos cards/colunas e ao checkout; não certifica o layout global/mobile do dashboard.
- Os SDKs React/Firebase são deduplicados com os do app cliente; compatibilidade dos bundles publicados requer verificação separada.

## Como executar

Pré-requisitos: dependências dos dois repositórios e das functions já instaladas, Node 24, Java compatível com Firebase Emulator, Chrome e Playwright disponível. `APP_CLIENTE_DIR` pode indicar outro caminho; padrão é o repositório irmão `fabrica-app-cliente`.

No diretório raiz do dashboard, em terminais separados:

```powershell
# Terminal 1 — sem projeto real e sem credenciais de produção
$env:XDG_CONFIG_HOME = "$PWD/.codex-temp/firebase-config"
$env:CI = 'true'
node functions/node_modules/firebase-tools/lib/bin/firebase.js emulators:start --config firebase.fluxopix.json --project demo-fluxo-pix --only firestore,auth
```

```powershell
# Terminal 2
$env:GCLOUD_PROJECT = 'demo-fluxo-pix'
$env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085'
$env:FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9098'
node functions/test/fluxoPix/servidor.cjs
```

```powershell
# Terminal 3
node node_modules/vite/bin/vite.js --config functions/test/fluxoPix/vite.config.mjs
```

```powershell
# Terminal 4 — indique o pacote Playwright instalado caso não resolva por require
$env:PLAYWRIGHT_MODULE = 'C:/caminho/do/node_modules/playwright'
# Opcional: $env:CHROME_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
node functions/test/fluxoPix/e2e.cjs
```

`E2E_ONLY` filtra pelo trecho do nome de um cenário. Resultados são gravados em `artifacts/resultado.json` (suíte) ou `resultado-isolado.json` (filtro). Screenshots usam somente fixtures. Encerre os três servidores com Ctrl+C ao terminar.

## Situação em 30/09/2026

Na investigação inicial, 12 cenários passaram e um 13º reproduziu a confirmação antes do frete, mostrando R$ 0,85 e gerando PIX de R$ 5,85. Após correção no App Cliente, a execução completa das 14:21 UTC aprovou **15 cenários**, incluindo bloqueio de frete pendente, recuperação de erro e respostas de bairros fora de ordem. Nenhum teste foi ignorado.

O teste offline agora exige orientação compreensível e recuperação da mesma tentativa, sem `internal`. Execute também `node --test functions/test/fluxoPix/feedback.test.cjs` para os 3 testes unitários dessa mensagem. Ver relatório em `docs/teste-fluxo-pix-2026-09-30.md` para evidências e limites. Tudo é local, sem publicação.
