param(
    [string]$InstallPath = (Join-Path $env:USERPROFILE '.codex\mcp\econstats'),
    [string]$BunPath = (Join-Path $env:USERPROFILE '.bun\bin\bun.exe')
)
$ErrorActionPreference = 'Stop'
$branch = 'add-abs-structured-revisions'
$installDirectory = (Resolve-Path -LiteralPath $InstallPath).Path
if (-not (Test-Path -LiteralPath $BunPath -PathType Leaf)) { throw 'Bun executable not found.' }
function Invoke-InstallGit {
    param([string[]]$GitArgs)
    $result = & git -C $installDirectory @GitArgs
    if ($LASTEXITCODE -ne 0) { throw 'Git operation failed; installation was stopped.' }
    return $result
}
$origin = (Invoke-InstallGit -GitArgs @('remote','get-url','origin')).Trim()
if ($origin -notmatch '^https://github\.com/incanberra/econstats-mcp(?:\.git)?$') {
    throw 'Installation origin is not the expected HTTPS fork. No update attempted.'
}
$dirty = Invoke-InstallGit -GitArgs @('status','--porcelain','--untracked-files=no')
if ($dirty) { throw 'The installation has tracked local changes. Preserve or commit them before updating.' }
$envPath = Join-Path $installDirectory '.env'
$hadEnv = Test-Path -LiteralPath $envPath -PathType Leaf
$envHashBefore = if ($hadEnv) { (Get-FileHash -LiteralPath $envPath -Algorithm SHA256).Hash } else { $null }
try {
    Invoke-InstallGit -GitArgs @('fetch','origin',"refs/heads/${branch}:refs/remotes/origin/${branch}") | Out-Null
    $remoteCommit = (Invoke-InstallGit -GitArgs @('rev-parse',"refs/remotes/origin/$branch")).Trim()
    & git -C $installDirectory show-ref --verify --quiet "refs/heads/$branch"
    $branchExists = $LASTEXITCODE -eq 0
    if ($branchExists) {
        Invoke-InstallGit -GitArgs @('switch',$branch) | Out-Null
        Invoke-InstallGit -GitArgs @('merge','--ff-only',"refs/remotes/origin/$branch") | Out-Null
    } else {
        Invoke-InstallGit -GitArgs @('switch','--create',$branch,'--track',"origin/$branch") | Out-Null
    }
    $installedCommit = (Invoke-InstallGit -GitArgs @('rev-parse','HEAD')).Trim()
    if ($installedCommit -ne $remoteCommit) { throw 'Installed branch has additional local commits. No reset was attempted.' }
    Push-Location -LiteralPath $installDirectory
    try {
        & $BunPath install --frozen-lockfile --ignore-scripts
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
        & $BunPath run typecheck
        if ($LASTEXITCODE -ne 0) { throw 'Type checking failed.' }
        & $BunPath test
        if ($LASTEXITCODE -ne 0) { throw 'Regression tests failed.' }
    } finally { Pop-Location }

} finally {
    $hasEnvAfter = Test-Path -LiteralPath $envPath -PathType Leaf
    if ($hasEnvAfter -ne $hadEnv) { throw 'Credential-file presence changed; inspect the installation before continuing.' }
    if ($hadEnv -and (Get-FileHash -LiteralPath $envPath -Algorithm SHA256).Hash -ne $envHashBefore) {
        throw 'Credential file changed; inspect the installation before continuing. No credential values were displayed.'
    }
}
Write-Host "Updated EconStats to $installedCommit on $branch. Restart or reconnect Codex to load v3's 31 tools."
