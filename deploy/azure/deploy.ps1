<#
  Deploy al Backend-ului MedFlow in Azure Container Apps, cu ingress EXTERN (adresa publica,
  pe care o apeleaza Frontend-ul / aplicatia Android).

  Ruleaza din folderul MedFlow-Backend, DUPA `az login` si DUPA scriptul din MedFlow-AI:
    .\deploy\azure\deploy.ps1 -Registry medflowacr12345 -CorsOrigin "http://localhost:5173"

  Cerinte, cine face ce si cum se urca imaginea: deploy\azure\README.md
#>
param(
  # Acelasi registry ca la scriptul din MedFlow-AI.
  [Parameter(Mandatory = $true)] [string] $Registry,
  # Adresele Frontend-ului care au voie sa apeleze Backend-ul din browser, separate prin virgula.
  [string] $CorsOrigin = "",
  [string] $ResourceGroup = "medflow-rg",
  [string] $Location = "westeurope",
  [string] $Environment = "medflow-env",
  [string] $ImageTag = "",
  [switch] $BuildInAzure,
  # Construieste imaginea cu Docker pe ACEST calculator si o urca in registry (merge si pe Azure for Students).
  [switch] $BuildLocally
)

$AppName = "medflow-backend"
$ImageName = "medflow-backend"
$TargetPort = 3001
$AiAppName = "medflow-ai"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

# Ruleaza o comanda az si se opreste daca az raporteaza o eroare.
# Nu afisam argumentele: pot contine chei secrete.
function Invoke-Az {
  az @args
  if ($LASTEXITCODE -ne 0) { throw "Comanda 'az $($args[0]) $($args[1])' a esuat (cod $LASTEXITCODE). Vezi mesajul de mai sus." }
}

# Intoarce $true daca resursa exista (comanda `az ... show` reuseste).
function Test-Az {
  az @args --only-show-errors -o none 2>$null | Out-Null
  return ($LASTEXITCODE -eq 0)
}

# Citeste o valoare din variabila de mediu cu acelasi nume sau o cere de la tastatura.
# Pentru chei secrete (-Secret) textul tastat nu apare pe ecran.
function Read-Value([string] $Name, [switch] $Secret) {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ($value) { return $value }
  if ($Secret) {
    $secure = Read-Host $Name -AsSecureString
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  }
  return (Read-Host $Name)
}

Write-Host "== 1. Verific contul Azure"
if (-not (Test-Az account show)) { throw "Nu esti logat in Azure CLI. Ruleaza intai: az login" }
Invoke-Az extension add --name containerapp --upgrade --only-show-errors
foreach ($provider in "Microsoft.App", "Microsoft.OperationalInsights", "Microsoft.ContainerRegistry") {
  Invoke-Az provider register --namespace $provider --wait --only-show-errors
}

Write-Host "== 2. Resursele comune (le creeaza doar daca lipsesc; acelasi bloc e si in scriptul AI)"
# Grupul e doar un "dosar" pentru resurse; resursele din el pot fi in alta regiune decat grupul.
# Il cream doar daca lipseste (altfel `group create` cu alta regiune da eroare).
if (-not (Test-Az group show --name $ResourceGroup)) {
  Invoke-Az group create --name $ResourceGroup --location $Location -o none
}
if (-not (Test-Az acr show --name $Registry --resource-group $ResourceGroup)) {
  # --location explicit: altfel registry-ul ia regiunea grupului, care poate fi alta decat $Location.
  Invoke-Az acr create --name $Registry --resource-group $ResourceGroup --location $Location --sku Basic --admin-enabled true -o none
} else {
  Invoke-Az acr update --name $Registry --admin-enabled true -o none
}
if (-not (Test-Az containerapp env show --name $Environment --resource-group $ResourceGroup)) {
  Invoke-Az containerapp env create --name $Environment --resource-group $ResourceGroup --location $Location -o none
}

Write-Host "== 3. Adresa interna a serviciului AI"
if (-not (Test-Az containerapp show --name $AiAppName --resource-group $ResourceGroup)) {
  throw "Aplicatia $AiAppName nu exista. Ruleaza intai deploy\azure\deploy.ps1 din MedFlow-AI."
}
$AiFqdn = az containerapp show --name $AiAppName --resource-group $ResourceGroup --query properties.configuration.ingress.fqdn -o tsv
$AiUrl = "https://$AiFqdn"
Write-Host "AI_URL = $AiUrl"

Write-Host "== 4. Imaginea"
if ($ImageTag -eq "") { $ImageTag = (git -C $RepoRoot rev-parse --short HEAD) }
$RegistryServer = "$Registry.azurecr.io"
$Image = "$RegistryServer/${ImageName}:$ImageTag"
if ($BuildInAzure) {
  Invoke-Az acr build --registry $Registry --image "${ImageName}:$ImageTag" $RepoRoot
}
if ($BuildLocally) {
  # az acr login da Docker-ului dreptul sa urce imagini in registry (Docker Desktop trebuie sa fie pornit).
  Invoke-Az acr login --name $Registry
  docker build -t $Image $RepoRoot
  if ($LASTEXITCODE -ne 0) { throw "docker build a esuat (cod $LASTEXITCODE)." }
  docker push $Image
  if ($LASTEXITCODE -ne 0) { throw "docker push a esuat (cod $LASTEXITCODE)." }
}
if (-not (Test-Az acr repository show --name $Registry --image "${ImageName}:$ImageTag")) {
  Write-Host ""
  Write-Host "Imaginea $Image nu exista in registry."
  Write-Host "Cineva cu Docker functional o urca (vezi deploy\azure\README.md, pasul 'Urcarea imaginii'), apoi rulezi din nou scriptul."
  exit 1
}

Write-Host "== 5. Cheile Supabase (SUPABASE_SECRET_KEY devine secret in Container Apps)"
$SupabaseUrl = Read-Value "SUPABASE_URL"
$SupabaseSecretKey = Read-Value "SUPABASE_SECRET_KEY" -Secret
if (-not $SupabaseUrl -or -not $SupabaseSecretKey) {
  throw "SUPABASE_URL sau SUPABASE_SECRET_KEY lipseste. Ruleaza scriptul intr-o fereastra PowerShell obisnuita si introdu valorile cand sunt cerute."
}

# MEDGEMMA_URL lipseste intentionat: serviciul de extragere are nevoie de GPU, pe care Azure for Students
# nu il ofera. Fara el, POST /cases/{id}/documents raspunde 503 (nimic nu se salveaza), restul merge.
$EnvVars = @(
  "SUPABASE_URL=$SupabaseUrl",
  "SUPABASE_SECRET_KEY=secretref:supabase-secret-key",
  "AI_URL=$AiUrl",
  "CORS_ORIGIN=$CorsOrigin"
)

Write-Host "== 6. Aplicatia $AppName"
$RegistryUser = az acr credential show --name $Registry --query username -o tsv
$RegistryPassword = az acr credential show --name $Registry --query "passwords[0].value" -o tsv
if (-not (Test-Az containerapp show --name $AppName --resource-group $ResourceGroup)) {
  Invoke-Az containerapp create --name $AppName --resource-group $ResourceGroup --environment $Environment `
    --image $Image --registry-server $RegistryServer --registry-username $RegistryUser --registry-password $RegistryPassword `
    --ingress external --target-port $TargetPort --min-replicas 0 --max-replicas 1 `
    --secrets "supabase-secret-key=$SupabaseSecretKey" --env-vars $EnvVars -o none
} else {
  Invoke-Az containerapp secret set --name $AppName --resource-group $ResourceGroup --secrets "supabase-secret-key=$SupabaseSecretKey" -o none
  # --revision-suffix: forteaza mereu o versiune (revizie) NOUA. Altfel, un secret schimbat poate sa nu
  # ajunga in container, iar o revizie actualizata "pe loc" poate ramane blocata (ActivationFailed).
  Invoke-Az containerapp update --name $AppName --resource-group $ResourceGroup --image $Image --set-env-vars $EnvVars `
    --revision-suffix ("v" + (Get-Date -Format "MMddHHmmss")) -o none
}

$Fqdn = az containerapp show --name $AppName --resource-group $ResourceGroup --query properties.configuration.ingress.fqdn -o tsv
Write-Host ""
Write-Host "Gata. Backend-ul e public la: https://$Fqdn"
Write-Host "Verificare:  https://$Fqdn/health   si   https://$Fqdn/health/db"
