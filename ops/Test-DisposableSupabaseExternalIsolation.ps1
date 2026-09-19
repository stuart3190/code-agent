param(
  [Parameter(Mandatory = $true)][string]$HostName,
  [int]$IntervalSeconds = 3,
  [int]$DurationSeconds = 30,
  [int]$ConnectTimeoutMilliseconds = 400,
  [string]$OutputPath = "external-probe.jsonl"
)

$ports = 55320..55327
$deadline = [DateTimeOffset]::UtcNow.AddSeconds($DurationSeconds)
$successes = 0
while ([DateTimeOffset]::UtcNow -lt $deadline) {
  foreach ($port in $ports) {
    $client = [System.Net.Sockets.TcpClient]::new()
    $connected = $false
    try {
      $attempt = $client.ConnectAsync($HostName, $port)
      $connected = $attempt.Wait($ConnectTimeoutMilliseconds) -and $client.Connected
    } catch {
      $connected = $false
    } finally {
      $client.Dispose()
    }
    if ($connected) { $successes++ }
    [ordered]@{
      timestamp = [DateTimeOffset]::UtcNow.ToString("o")
      source = "independent-windows-host"
      target = $HostName
      port = $port
      connected = $connected
    } | ConvertTo-Json -Compress | Add-Content -LiteralPath $OutputPath -Encoding utf8
  }
  Start-Sleep -Seconds $IntervalSeconds
}

if ($successes -ne 0) {
  Write-Error "$successes external connection(s) succeeded"
  exit 1
}
Write-Output "0 external connections succeeded; evidence: $OutputPath"
