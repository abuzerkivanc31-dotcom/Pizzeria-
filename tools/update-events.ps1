# Liest den Veranstaltungskalender der YAYLA Arena und schreibt events.json.
# Auf Netlify aktualisiert die Funktion netlify/functions/events-refresh.mjs die Termine automatisch.
# Dieses Skript schreibt die Termine von Hand neu (public/events.js und events.json):  powershell -File tools\update-events.ps1

$ErrorActionPreference = "Stop"
$OffenVorBeginnStunden = 4   # der Laden öffnet so viele Stunden vor Veranstaltungsbeginn

$events = @{}
$start = Get-Date -Day 1
for ($k = 0; $k -lt 7; $k++) {
  $m = $start.AddMonths($k)
  $url = "https://yayla-arena.de/veranstaltungskalender/?_m=$($m.Month)&_y=$($m.Year)"
  try { $html = (Invoke-WebRequest $url -UseBasicParsing).Content } catch { Write-Warning "Fehler bei $url"; continue }
  $items = $html -split 'class="archive-list__item"' | Select-Object -Skip 1
  foreach ($it in $items) {
    if ($it -notmatch '(\d{2})\.(\d{2})\.(\d{4})') { continue }
    $date = "$($Matches[3])-$($Matches[2])-$($Matches[1])"
    $slug = if ($it -match 'yayla-arena\.de/event/([^/"]+)/') { $Matches[1] } else { continue }
    $title = if ($it -match 'class="title">\s*([^<]+?)\s*<') { [System.Net.WebUtility]::HtmlDecode($Matches[1]) } else { $slug }
    $sub   = if ($it -match 'class="short-description">\s*([^<]*?)\s*<') { [System.Net.WebUtility]::HtmlDecode($Matches[1]) } else { "" }
    $begin = if ($it -match 'Beginn:\s*(\d{1,2}:\d{2})') { $Matches[1] } elseif ($it -match '(\d{1,2}:\d{2}) Uhr') { $Matches[1] } else { continue }
    $admit = if ($it -match 'Einlass:\s*(\d{1,2}:\d{2})') { $Matches[1] } else { $null }
    $b = [TimeSpan]::Parse($begin)
    $open = $b.Add([TimeSpan]::FromHours(-$OffenVorBeginnStunden))   # Laden öffnet 4 Std. vor Beginn
    if ($open.TotalMinutes -lt 0) { $open = [TimeSpan]::Zero }
    # Schluss ist nicht planbar (oft 2-3 Uhr, bei Konzerten/Wetter früher): wird vom Inhaber auf der Seite gesetzt.
    $events["$date|$slug"] = [ordered]@{
      date = $date; title = $title; subtitle = $sub; start = $begin
      open = ("{0:00}:{1:00}" -f $open.Hours, $open.Minutes)
      url = "https://yayla-arena.de/event/$slug/"
    }
  }
}
$list = $events.Values | Sort-Object { $_.date }, { $_.start }
$json = [ordered]@{ updated = (Get-Date).ToString("s"); events = @($list) } | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot "..\public\events.json"), $json, (New-Object System.Text.UTF8Encoding($false)))
# gleiche Daten als events.js, damit die Seite auch per Doppelklick (ohne Server) funktioniert
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot "..\public\events.js"), "window.EVENTS_DATA = $json;", (New-Object System.Text.UTF8Encoding($false)))
"$(@($list).Count) Events geschrieben."
