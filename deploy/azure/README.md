# Deploy MedFlow pe Azure (Backend + serviciul AI)

Ghid pentru cine publică MedFlow în Azure Container Apps. Scripturile folosesc doar **Azure CLI**:
pe calculatorul care rulează scripturile **nu e nevoie de Docker**.

## Ce se publică

```
Internet (Frontend / aplicația Android)
   │  https://medflow-backend.<...>.azurecontainerapps.io
   ▼
medflow-backend   (Container App, ingress EXTERN, port 3001)
   ├─► Supabase (extern, rămâne unde e)
   └─► medflow-ai  (Container App, ingress INTERN, port 8091) ──► Gemini
```

- **Serviciul AI e intern:** se poate ajunge la el doar din Backend, nu de pe internet.
- **Serviciul de extragere MedGemma NU se publică.** Are nevoie de GPU, iar Azure for Students nu oferă GPU. Fără el, `POST /cases/{id}/documents` răspunde `503` și nu salvează nimic. Restul funcționează.
- **Resursele create:**
  - grupul de resurse `medflow-rg`;
  - registry-ul de imagini (Azure Container Registry, SKU Basic);
  - mediul Container Apps `medflow-env` (Log Analytics se creează automat odată cu el);
  - cele două aplicații.

## Varianta simplă: totul pe un singur laptop (recomandat)

Pe laptopul unde merg **și Docker Desktop, și Azure CLI**, proprietarul contului Azure se loghează
o dată (`az login`), iar scripturile construiesc imaginile, le urcă și pornesc aplicațiile.

1. **Pregătirea**, o singură dată:
   - instalezi Azure CLI: `winget install --exact --id Microsoft.AzureCLI`;
   - închizi și redeschizi PowerShell;
   - pornești Docker Desktop.
2. **Logarea:** `az login`. Se loghează proprietarul contului (Azure for Students), în fereastra de browser care se deschide.
3. Codul e commis, iar MedFlow-AI și MedFlow-Backend sunt pe branch-ul `Azure-implementation`.
4. **Deploy-ul, întâi AI, apoi Backend:**

```powershell
# din MedFlow-AI
.\deploy\azure\deploy.ps1 -Registry medflowacr48213 -BuildLocally

# din MedFlow-Backend
.\deploy\azure\deploy.ps1 -Registry medflowacr48213 -BuildLocally -CorsOrigin "http://localhost:5173"
```

5. **Verificarea** e la pasul 5 de mai jos.

După deploy, dacă laptopul nu e al proprietarului contului, acesta se poate deloga cu `az logout`.

Pentru o versiune nouă: commit, apoi rulezi din nou cele două comenzi de la punctul 4.

## Varianta cu două calculatoare

Folosești varianta asta dacă pe calculatorul cu contul Azure nu merge Docker.

| Cine | Ce are nevoie | Ce face |
|---|---|---|
| **Colegul cu contul Azure** | Azure CLI, Git, PowerShell. **Fără Docker.** | Creează resursele și pornește aplicațiile, cu scripturile. |
| **Cineva cu Docker funcțional** | Docker Desktop, Git | Construiește cele două imagini și le urcă în registry |

De ce e nevoie și de cineva cu Docker: pe abonamentele Azure for Students, construirea imaginilor direct
în Azure (`az acr build`) e de obicei blocată (eroarea `TasksOperationsNotAllowed`). Dacă la voi merge,
adăugați `-BuildInAzure` la scripturi și nu mai aveți nevoie de Docker deloc.

## Înainte de toate

1. **Codul trebuie să fie commis și împins** pe branch-ul `Azure-implementation`, în MedFlow-AI **și** în MedFlow-Backend. Ambii (colegul și cel cu Docker) iau exact același commit (`git pull`).
   - Eticheta imaginii este commit-ul (`git rev-parse --short HEAD`).
   - Dacă cei doi sunt pe commit-uri diferite, scriptul nu găsește imaginea.
2. **Alegeți un nume pentru registry**: unic în tot Azure, doar litere mici și cifre, de exemplu `medflowacr48213`.
3. **Valorile de care are nevoie colegul.** Scriptul le cere la tastatură; cheile nu apar pe ecran.
   - `GEMINI_API_KEY`: pentru serviciul AI;
   - `SUPABASE_URL` și `SUPABASE_SECRET_KEY`: pentru Backend;
   - adresa Frontend-ului, pentru `-CorsOrigin` (opțional; de exemplu `http://localhost:5173` în timpul testelor).

## Pașii

### Pasul 1: colegul instalează Azure CLI și se loghează

```powershell
winget install Microsoft.AzureCLI
az login
```

Închide și redeschide PowerShell după instalare, ca să fie găsită comanda `az`.

### Pasul 2: colegul creează resursele

Din folderul **MedFlow-AI**:

```powershell
.\deploy\azure\deploy.ps1 -Registry medflowacr48213
```

La prima rulare, scriptul creează grupul, registry-ul și mediul, apoi se oprește cu mesajul
„Imaginea ... nu există în registry”. **E normal:** imaginile nu sunt încă urcate. Colegul ia apoi
datele de acces la registry:

```powershell
az acr credential show --name medflowacr48213
```

și le trimite celui cu Docker **pe un canal privat**, nu într-un chat public sau în Git.

### Pasul 3: cel cu Docker urcă imaginile

În PowerShell, cu `<user>` și `<parola>` din pasul 2:

```powershell
$registry = "medflowacr48213.azurecr.io"
"<parola>" | docker login $registry --username <user> --password-stdin

cd MedFlow-AI
$tag = git rev-parse --short HEAD
docker build -t "$registry/medflow-ai:$tag" .
docker push "$registry/medflow-ai:$tag"

cd ..\MedFlow-Backend
$tag = git rev-parse --short HEAD
docker build -t "$registry/medflow-backend:$tag" .
docker push "$registry/medflow-backend:$tag"
```

### Pasul 4: colegul pornește aplicațiile

Ordinea contează: **întâi AI**, pentru că Backend-ul are nevoie de adresa lui.

```powershell
# din MedFlow-AI
.\deploy\azure\deploy.ps1 -Registry medflowacr48213

# din MedFlow-Backend
.\deploy\azure\deploy.ps1 -Registry medflowacr48213 -CorsOrigin "http://localhost:5173"
```

La final, scriptul Backend afișează adresa publică.

### Pasul 5: verificarea

- `https://<adresa-backend>/health` → `{"status":"ok","service":"medflow-backend"}`
- `https://<adresa-backend>/health/db` → `"database":"connected"` dacă cheile Supabase sunt corecte

Prima cerere poate dura câteva secunde, pentru că aplicațiile pornesc de la 0 copii, ca să consume mai puțin credit.

## O versiune nouă

1. Commit și push.
2. Pasul 3, cu noul commit.
3. Pasul 4.

Scripturile actualizează aplicațiile existente; nu creează altele.

## Costuri și ștergere

- **Registry-ul (SKU Basic)** consumă puțin din creditul Azure for Students în fiecare lună.
- **Aplicațiile** pornesc de la 0 copii, așa că atunci când nu le folosește nimeni consumă foarte puțin.
- **Ștergi totul** cu:

```powershell
az group delete --name medflow-rg
```

## Probleme frecvente

| Mesaj | Cauză și soluție |
|---|---|
| `RequestDisallowedByAzure` / „region is currently not accepting new customers” | Regiunea nu mai primește abonamente noi de student (la noi: `westeurope`, 2026-11-07). Adaugă `-Location swedencentral` (sau `northeurope`, `germanywestcentral`, `polandcentral`) la **ambele** scripturi. |
| `RequestDisallowedByPolicy` | Abonamentul nu permite regiunea. Adaugă `-Location <altă regiune>` (de exemplu `swedencentral`, `northeurope`) la **ambele** scripturi. |
| `TasksOperationsNotAllowed` | `-BuildInAzure` nu e permis pe abonament. Folosiți pasul 3 (Docker). |
| „Imaginea ... nu există în registry” | Imaginea nu e urcată, sau a fost urcată de pe alt commit. Verificați `git rev-parse --short HEAD` la amândoi. |
| `Nu ești logat în Azure CLI` | `az login` |

## Limitări cunoscute (MVP)

- Registry-ul folosește utilizatorul de administrator (admin user), pentru că e cel mai simplu. Mai târziu se poate trece la o identitate gestionată (managed identity).
- Cheile sunt trimise către `az` ca argumente. Pe calculatorul colegului apar foarte scurt în lista de procese.
- Nu există încă rânduri în `profiles`. Utilizatorii noi primesc `403` până li se adaugă profilul manual.
