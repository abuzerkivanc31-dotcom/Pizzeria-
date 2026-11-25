# Testserver für das Handy im selben WLAN:  powershell -ExecutionPolicy Bypass -File serve-lan.ps1
# Dann am Handy die ausgegebene Adresse (http://192.168.x.x:8090) öffnen.
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\public"))
$port = 8090
$types = @{".html"="text/html; charset=utf-8";".json"="application/json";".jpg"="image/jpeg";".png"="image/png";".css"="text/css";".js"="text/javascript; charset=utf-8"}
$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any, $port)
$listener.Start()
$ips = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) | Where-Object { $_.AddressFamily -eq "InterNetwork" -and $_.ToString() -notlike "169.254.*" }
foreach ($ip in $ips) { "Am Handy öffnen: http://$($ip):$port" }
while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $stream = $client.GetStream(); $stream.ReadTimeout = 3000
    $buf = New-Object byte[] 8192; $n = $stream.Read($buf, 0, $buf.Length)
    $req = [System.Text.Encoding]::ASCII.GetString($buf, 0, $n)
    $path = ($req -split " ")[1]; if (-not $path) { $client.Close(); continue }
    $path = [Uri]::UnescapeDataString(($path -split "\?")[0]).TrimStart("/"); if ($path -eq "") { $path = "index.html" }
    $file = [System.IO.Path]::GetFullPath((Join-Path $root $path))
    if ($file.StartsWith($root) -and (Test-Path $file -PathType Leaf)) {
      $body = [System.IO.File]::ReadAllBytes($file); $ct = $types[[System.IO.Path]::GetExtension($file)]; if (-not $ct) { $ct = "application/octet-stream" }
      $head = "HTTP/1.1 200 OK`r`nContent-Type: $ct`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
    } else { $body = [System.Text.Encoding]::UTF8.GetBytes("404"); $head = "HTTP/1.1 404 Not Found`r`nContent-Length: 3`r`nConnection: close`r`n`r`n" }
    $hb = [System.Text.Encoding]::ASCII.GetBytes($head); $stream.Write($hb, 0, $hb.Length); $stream.Write($body, 0, $body.Length)
  } catch {} finally { $client.Close() }
}
