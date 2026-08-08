$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Package10ELogsCredentialManager {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags; public UInt32 Type; public IntPtr TargetName; public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist;
    public UInt32 AttributeCount; public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("advapi32.dll", SetLastError=true)] public static extern void CredFree(IntPtr buffer);
}
"@

$pointer = [IntPtr]::Zero
if (-not [Package10ELogsCredentialManager]::CredRead("Supabase CLI:supabase", 1, 0, [ref]$pointer)) {
  throw "Supabase CLI credential was not found"
}
try {
  $credential = [Runtime.InteropServices.Marshal]::PtrToStructure(
    $pointer, [type][Package10ELogsCredentialManager+CREDENTIAL]
  )
  $bytes = New-Object byte[] $credential.CredentialBlobSize
  [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $bytes.Length)
  $token = @(
    [Text.Encoding]::UTF8.GetString($bytes).Trim([char]0),
    [Text.Encoding]::Unicode.GetString($bytes).Trim([char]0)
  ) | Where-Object { $_ -match '^(sbp_|sbf_)' } | Select-Object -First 1
  if (-not $token) { throw "Stored Supabase CLI credential has an unexpected format" }

  $sql = @"
select datetime(timestamp) as timestamp, status_code, path, event_message
from edge_logs
cross join unnest(metadata) as metadata
cross join unnest(response) as response
cross join unnest(request) as request
where regexp_contains(path, 'request_publish_activation')
order by timestamp asc
limit 100
"@
  $encoded = [Uri]::EscapeDataString($sql)
  $uri = "https://api.supabase.com/v1/projects/zczgvcsokfafuyognvwx/analytics/endpoints/logs.all?sql=$encoded&iso_timestamp_start=2026-08-08T16%3A10%3A30Z&iso_timestamp_end=2026-08-08T16%3A13%3A30Z"
  Invoke-RestMethod -Method Get -Uri $uri -Headers @{ Authorization = "Bearer $token" } | ConvertTo-Json -Depth 10
} finally {
  if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
  $token = $null
  [Package10ELogsCredentialManager]::CredFree($pointer)
}
