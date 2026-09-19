$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectRef = "zczgvcsokfafuyognvwx"
$oldKeyId = "a2dae86d-2da2-49db-8869-44c363765323"
$oldKeySha256 = "364c32a12f17737e1f9786789deafed72a2824c0238dabd69f906f21349e7b9a"
$apiBase = "https://api.supabase.com/v1/projects/$projectRef/api-keys"
$remote = "ubuntu@51.195.136.189"
$remoteInstaller = "/tmp/install-package10e-supabase-secret.mjs"

Add-Type -AssemblyName System.Net.Http

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Package10ECredentialManager {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public IntPtr TargetName;
    public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern void CredFree(IntPtr buffer);
}
"@

function Get-SupabaseAccessToken {
  $pointer = [IntPtr]::Zero
  if (-not [Package10ECredentialManager]::CredRead("Supabase CLI:supabase", 1, 0, [ref]$pointer)) {
    throw "Supabase CLI credential was not found in Windows Credential Manager"
  }
  try {
    $credential = [Runtime.InteropServices.Marshal]::PtrToStructure(
      $pointer,
      [type][Package10ECredentialManager+CREDENTIAL]
    )
    $bytes = New-Object byte[] $credential.CredentialBlobSize
    [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $bytes.Length)
    $candidates = @(
      [Text.Encoding]::UTF8.GetString($bytes).Trim([char]0),
      [Text.Encoding]::Unicode.GetString($bytes).Trim([char]0)
    )
    $token = $candidates | Where-Object { $_ -match '^(sbp_|sbf_)' } | Select-Object -First 1
    if (-not $token) { throw "Stored Supabase CLI credential has an unexpected format" }
    return $token
  } finally {
    [Package10ECredentialManager]::CredFree($pointer)
  }
}

function Get-Sha256([string]$value) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($value)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $hash = $algorithm.ComputeHash($bytes)
    return ([BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
    [Array]::Clear($bytes, 0, $bytes.Length)
  }
}

function Invoke-ManagementApi([string]$method, [string]$uri, $body, [string]$token) {
  $headers = @{ Authorization = "Bearer $token" }
  $parameters = @{ Method = $method; Uri = $uri; Headers = $headers }
  if ($null -ne $body) {
    $parameters.ContentType = "application/json"
    $parameters.Body = ($body | ConvertTo-Json -Depth 8 -Compress)
  }
  Invoke-RestMethod @parameters
}

function Invoke-DataApi([string]$key) {
  $client = [Net.Http.HttpClient]::new()
  try {
    $client.DefaultRequestHeaders.Add("apikey", $key)
    $client.DefaultRequestHeaders.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new("Bearer", $key)
    $client.DefaultRequestHeaders.UserAgent.ParseAdd("thrallo-package10e-rotation/1.0")
    $response = $client.GetAsync("https://$projectRef.supabase.co/rest/v1/projects?select=id&limit=1").GetAwaiter().GetResult()
    return [int]$response.StatusCode
  } finally { $client.Dispose() }
}

function Invoke-RemoteInstaller([string]$key, [string]$expectedHash) {
  $start = [Diagnostics.ProcessStartInfo]::new("ssh")
  $start.Arguments = "-o BatchMode=yes -o ConnectTimeout=10 $remote `"sudo node $remoteInstaller $expectedHash`""
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.UseShellExecute = $false
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  $null = $process.Start()
  $process.StandardInput.WriteLine($key)
  $process.StandardInput.Close()
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) { throw "Remote secret install failed: $stderr" }
  return ($stdout | ConvertFrom-Json)
}

function Get-RemoteCredentialHashes {
  $output = & ssh -o BatchMode=yes -o ConnectTimeout=10 $remote "sudo node $remoteInstaller --hashes"
  if ($LASTEXITCODE -ne 0) { throw "Could not inspect approved remote credential stores" }
  return ($output | ConvertFrom-Json)
}

$accessToken = Get-SupabaseAccessToken
$newKey = $null
$newKeyId = $null
$installed = $false
try {
  $oldMetadata = Invoke-ManagementApi "GET" "$apiBase/$oldKeyId`?reveal=true" $null $accessToken
  if ($oldMetadata.id -ne $oldKeyId -or $oldMetadata.type -ne "secret") {
    throw "The approved incident key identity no longer matches production"
  }
  if ((Get-Sha256 ([string]$oldMetadata.api_key)) -ne $oldKeySha256) {
    throw "The approved incident credential hash no longer matches production"
  }

  $existingKeys = Invoke-ManagementApi "GET" $apiBase $null $accessToken
  $replacementCandidates = @()
  for ($index = 0; $index -lt $existingKeys.Count; $index++) {
    $candidate = $existingKeys[$index]
    if ($candidate.name -eq "thrallo_runtime_20260808") { $replacementCandidates += $candidate }
  }
  if ($replacementCandidates.Count -gt 1) { throw "Multiple Package 10E replacement keys exist" }
  if ($replacementCandidates.Count -eq 1) {
    if ($replacementCandidates[0].type -ne "secret" -or $replacementCandidates[0].id -eq $oldKeyId) {
      throw "The replacement key identity is unsafe (id=$($replacementCandidates[0].id), type=$($replacementCandidates[0].type))"
    }
    $created = Invoke-ManagementApi "GET" "$apiBase/$($replacementCandidates[0].id)?reveal=true" $null $accessToken
  } else {
    $created = Invoke-ManagementApi "POST" "$apiBase`?reveal=true" @{
      type = "secret"
      name = "thrallo_runtime_20260808"
      description = "Rotated Package 10E shell and worker runtime credential"
      secret_jwt_template = @{ role = "service_role" }
    } $accessToken
  }

  $newKey = [string]$created.api_key
  $newKeyId = [string]$created.id
  if (-not $newKey.StartsWith("sb_secret_") -or -not $newKeyId) {
    throw "Supabase returned an invalid replacement credential"
  }

  $newKeyHash = Get-Sha256 $newKey
  $remoteHashes = Get-RemoteCredentialHashes
  $remoteHashValues = @($remoteHashes.hashes | ForEach-Object { $_.hash })
  if ($remoteHashValues.Count -ne 2) { throw "Approved runtime stores did not return two hashes" }
  if (@($remoteHashValues | Where-Object { $_ -eq $oldKeySha256 }).Count -eq 2) {
    $installResult = Invoke-RemoteInstaller $newKey $oldKeySha256
    $installed = $true
    if ($installResult.replacementHash -ne $newKeyHash) {
      throw "Remote replacement hash verification failed"
    }
  } elseif (@($remoteHashValues | Where-Object { $_ -eq $newKeyHash }).Count -eq 2) {
    $installed = $true
    $installResult = [pscustomobject]@{ targets = $remoteHashes.hashes }
  } else {
    throw "Approved runtime stores are in a mixed or unexpected credential state"
  }

  $null = & ssh -o BatchMode=yes $remote "sudo systemctl reset-failed thrallo-build-worker; sudo systemctl start thrallo-shell thrallo-build-worker"
  if ($LASTEXITCODE -ne 0) { throw "Failed to start shell/worker after credential replacement" }

  $newStatusBeforeRevoke = Invoke-DataApi $newKey
  if ($newStatusBeforeRevoke -ne 200) { throw "Replacement credential Data API test failed with HTTP $newStatusBeforeRevoke" }

  $deleted = Invoke-ManagementApi "DELETE" "$apiBase/$oldKeyId`?was_compromised=true&reason=Exposed%20in%20Package%2010E%20diagnostic%20tool%20output" $null $accessToken
  if ($deleted.id -ne $oldKeyId) { throw "Supabase did not confirm revocation of the approved incident key" }

  $oldStatusAfterRevoke = Invoke-DataApi ([string]$oldMetadata.api_key)
  $newStatusAfterRevoke = Invoke-DataApi $newKey
  if ($oldStatusAfterRevoke -ne 401 -or $newStatusAfterRevoke -ne 200) {
    throw "Post-revocation authentication proof failed"
  }

  [ordered]@{
    ok = $true
    projectRef = $projectRef
    oldKeyId = $oldKeyId
    oldKeyHash = $oldKeySha256
    replacementKeyId = $newKeyId
    replacementKeyHash = Get-Sha256 $newKey
    replacementStatusBeforeRevoke = $newStatusBeforeRevoke
    oldStatusAfterRevoke = $oldStatusAfterRevoke
    replacementStatusAfterRevoke = $newStatusAfterRevoke
    installedTargets = $installResult.targets
  } | ConvertTo-Json -Depth 6
} catch {
  if ($newKeyId -and -not $installed) {
    try { $null = Invoke-ManagementApi "DELETE" "$apiBase/$newKeyId`?reason=Package%2010E%20rotation%20failed%20before%20installation" $null $accessToken } catch {}
  }
  throw
} finally {
  $accessToken = $null
  $newKey = $null
}
