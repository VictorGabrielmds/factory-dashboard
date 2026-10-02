<#
  Coletor P0 para ser executado NO PC onde o Robô de Impressão está instalado.
  Só leitura: não inicia o robô, não acessa rede/Firebase, não imprime, não
  modifica arquivos e não mostra/copia a chave privada da conta de serviço.

  Exemplo:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\coletar-evidencia-robo.ps1 `
      -CaminhoExe 'C:\Program Files\RoboImpressaoDelivery\RoboImpressaoDelivery.exe'
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$CaminhoExe,

  [string]$CaminhoCredencial = 'C:\Windows\entregas-781a8-firebase-adminsdk-ttnmu-43e1dbeb7b.json'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Get-Artefato([string]$Caminho) {
  if (-not (Test-Path -LiteralPath $Caminho -PathType Leaf)) { return $null }
  $arquivo = Get-Item -LiteralPath $Caminho
  $assinatura = Get-AuthenticodeSignature -LiteralPath $Caminho
  return [ordered]@{
    nome = $arquivo.Name
    versaoArquivo = $arquivo.VersionInfo.FileVersion
    tamanhoBytes = $arquivo.Length
    sha256 = (Get-FileHash -LiteralPath $Caminho -Algorithm SHA256).Hash.ToLowerInvariant()
    assinatura = $assinatura.Status.ToString()
  }
}

function Get-ImpressaoChave([string]$Valor) {
  if ([string]::IsNullOrWhiteSpace($Valor) -or $Valor -notmatch '^[a-f0-9]{40}$') { return $null }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Valor)
  try {
    return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant().Substring(0, 12)
  } finally {
    [Array]::Clear($bytes, 0, $bytes.Length)
    $sha.Dispose()
  }
}

function Get-Credencial([string]$Caminho) {
  if (-not (Test-Path -LiteralPath $Caminho -PathType Leaf)) {
    return [ordered]@{ presente = $false; formatoValido = $false }
  }
  $conteudo = $null
  try {
    $conteudo = Get-Content -LiteralPath $Caminho -Raw -Encoding UTF8
    $json = $conteudo | ConvertFrom-Json
    $projeto = [string]$json.project_id
    $conta = [string]$json.client_email
    $impressao = Get-ImpressaoChave ([string]$json.private_key_id)
    return [ordered]@{
      presente = $true
      formatoValido = ($projeto -eq 'entregas-781a8' -and $conta -match '^[a-z0-9-]+@entregas-781a8\.iam\.gserviceaccount\.com$' -and $null -ne $impressao)
      projeto = $projeto
      contaServico = $conta
      identificadorReduzido = $impressao
    }
  } catch {
    return [ordered]@{ presente = $true; formatoValido = $false; erro = 'METADADOS_NAO_LIDOS' }
  } finally {
    # Não escreve conteúdo da credencial em tela, arquivo ou log.
    Remove-Variable conteudo -ErrorAction SilentlyContinue
  }
}

try {
  $exe = Get-Item -LiteralPath $CaminhoExe
  if ($exe.Extension -ine '.exe') { throw 'CAMINHO_EXE_INVALIDO' }
  $dll = [System.IO.Path]::ChangeExtension($exe.FullName, '.dll')
  [ordered]@{
    coletadoEmUtc = [DateTime]::UtcNow.ToString('o')
    modo = 'somente_leitura_local'
    executavel = Get-Artefato $exe.FullName
    dllAoLadoDoExe = Get-Artefato $dll
    credencial = Get-Credencial $CaminhoCredencial
    limite = 'Nao revela chave privada, nao acessa a rede e nao prova outros PCs/consumidores.'
  } | ConvertTo-Json -Depth 4
} catch {
  [ordered]@{
    modo = 'somente_leitura_local'
    erro = if ($_.Exception.Message -eq 'CAMINHO_EXE_INVALIDO') { 'CAMINHO_EXE_INVALIDO' } else { 'COLETA_INDISPONIVEL' }
  } | ConvertTo-Json -Compress
  exit 1
}
