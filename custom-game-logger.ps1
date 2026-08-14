<#
LWG Team Tool â€” Custom Game Logger
-----------------------------------
Run this while the League client is open, before/during your custom games.
Leave it running in a PowerShell window â€” it polls the client every few
seconds, and when a CUSTOM game finishes, it grabs the end-of-game stats
for all 10 participants and uploads them to the shared roster's database.

Only ONE person in the lobby needs to run this â€” the end-of-game data
already includes every participant, not just yours.

This talks only to:
  - 127.0.0.1 (your own League client, while it's running)
  - firestore.googleapis.com (the shared database this app already uses)
It does not need your Riot API key and does not touch Riot's cloud API.

NOTE FROM CLAUDE: the League client's local API (LCU) is not officially
documented or guaranteed stable by Riot â€” this script is built from
community knowledge of how it behaves, but I have no way to test it
myself (no League client running in my environment). The first run
should be treated as a test: watch the console output, and if a step
fails or the captured data looks wrong, copy the console output and
report it back so the script can be fixed.
#>

$ErrorActionPreference = "Stop"
$FirestoreBase = "https://firestore.googleapis.com/v1/projects/champ-pool-lwg/databases/(default)/documents"
$PollSeconds = 5

# --- TLS / self-signed cert handling (League's local API uses a self-signed cert) ---
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (-not ("TrustAllCertsPolicy" -as [type])) {
  Add-Type @"
    using System.Net;
    using System.Security.Cryptography.X509Certificates;
    public class TrustAllCertsPolicy : ICertificatePolicy {
      public bool CheckValidationResult(ServicePoint sp, X509Certificate cert, WebRequest req, int problem) {
        return true;
      }
    }
"@
}
[System.Net.ServicePointManager]::CertificatePolicy = New-Object TrustAllCertsPolicy

function Write-Log($msg) {
  Write-Output "[$(Get-Date -Format 'HH:mm:ss')] $msg"
}

function Get-LcuConnection {
  $proc = Get-CimInstance Win32_Process -Filter "Name = 'LeagueClientUx.exe'" -ErrorAction SilentlyContinue
  if (-not $proc) { return $null }

  $cmdLine = $proc.CommandLine
  if ($cmdLine -notmatch '--app-port=(\d+)') { return $null }
  $port = $matches[1]
  if ($cmdLine -notmatch '--remoting-auth-token=([\w-]+)') { return $null }
  $token = $matches[1]

  $authHeader = "Basic " + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("riot:$token"))
  return [PSCustomObject]@{
    Base    = "https://127.0.0.1:$port"
    Headers = @{ Authorization = $authHeader }
  }
}

function Invoke-Lcu($conn, $path) {
  try {
    return Invoke-RestMethod -Uri "$($conn.Base)$path" -Headers $conn.Headers -Method Get
  } catch {
    return $null
  }
}

# The client leaves objective counters out of the payload entirely when they're zero, so a
# missing field means "none taken" rather than "unknown" â€” coerce both to 0 instead of letting
# a null reach Firestore, which would reject the write.
function ConvertTo-FirestoreInt($value) {
  if ($null -eq $value) { return @{ integerValue = "0" } }
  return @{ integerValue = [string][int]$value }
}

function ConvertTo-FirestoreBool($value) {
  return @{ booleanValue = [bool]$value }
}

function Send-CustomGameToFirestore($gameId, $matchData) {
  # Pull the current roster so we can match participants by Riot ID.
  $peopleResp = Invoke-RestMethod -Uri "$FirestoreBase/people"
  $roster = @()
  if ($peopleResp.documents) {
    foreach ($doc in $peopleResp.documents) {
      $id = ($doc.name -split '/')[-1]
      $name = $doc.fields.name.stringValue
      $riotId = $doc.fields.riotId.stringValue
      if ($riotId) {
        $roster += [PSCustomObject]@{ Id = $id; Name = $name; RiotId = $riotId.ToLower() }
      }
    }
  }

  $participantFields = @()
  foreach ($p in $matchData.participants) {
    $identity = $matchData.participantIdentities | Where-Object { $_.participantId -eq $p.participantId }
    $playerInfo = $identity.player
    $riotIdGuess = $null
    if ($playerInfo.gameName -and $playerInfo.tagLine) {
      $riotIdGuess = "$($playerInfo.gameName)#$($playerInfo.tagLine)".ToLower()
    } elseif ($playerInfo.summonerName) {
      $riotIdGuess = $playerInfo.summonerName.ToLower()
    }

    $matchedPerson = $null
    if ($riotIdGuess) {
      $matchedPerson = $roster | Where-Object { $_.RiotId -eq $riotIdGuess } | Select-Object -First 1
    }

    $displayName = if ($playerInfo.gameName -and $playerInfo.tagLine) {
      "$($playerInfo.gameName)#$($playerInfo.tagLine)"
    } else {
      [string]$playerInfo.summonerName
    }

    $participantFields += @{
      mapValue = @{
        fields = @{
          summonerName      = @{ stringValue = $displayName }
          championId        = @{ integerValue = [string]$p.championId }
          kills             = @{ integerValue = [string]$p.stats.kills }
          deaths            = @{ integerValue = [string]$p.stats.deaths }
          assists           = @{ integerValue = [string]$p.stats.assists }
          win               = @{ booleanValue = [bool]$p.stats.win }
          teamId            = @{ integerValue = [string]$p.teamId }
          damageToChampions = ConvertTo-FirestoreInt $p.stats.totalDamageDealtToChampions
          damageTaken       = ConvertTo-FirestoreInt $p.stats.totalDamageTaken
          goldEarned        = ConvertTo-FirestoreInt $p.stats.goldEarned
          cs                = ConvertTo-FirestoreInt ([int]$p.stats.totalMinionsKilled + [int]$p.stats.neutralMinionsKilled)
          visionScore       = ConvertTo-FirestoreInt $p.stats.visionScore
          matchedPersonId   = if ($matchedPerson) { @{ stringValue = $matchedPerson.Id } } else { @{ nullValue = $null } }
          matchedPersonName = if ($matchedPerson) { @{ stringValue = $matchedPerson.Name } } else { @{ nullValue = $null } }
        }
      }
    }
  }

  # Objective control: who took what, per side. The scoreboard already tells you who won â€”
  # this tells you how, which is the half you can actually practise.
  $teamFields = @()
  foreach ($t in $matchData.teams) {
    $teamFields += @{
      mapValue = @{
        fields = @{
          teamId          = ConvertTo-FirestoreInt  $t.teamId
          firstBlood      = ConvertTo-FirestoreBool $t.firstBlood
          firstTower      = ConvertTo-FirestoreBool $t.firstTower
          firstInhibitor  = ConvertTo-FirestoreBool $t.firstInhibitor
          firstBaron      = ConvertTo-FirestoreBool $t.firstBaron
          firstDragon     = ConvertTo-FirestoreBool $t.firstDragon
          firstRiftHerald = ConvertTo-FirestoreBool $t.firstRiftHerald
          towerKills      = ConvertTo-FirestoreInt  $t.towerKills
          inhibitorKills  = ConvertTo-FirestoreInt  $t.inhibitorKills
          baronKills      = ConvertTo-FirestoreInt  $t.baronKills
          dragonKills     = ConvertTo-FirestoreInt  $t.dragonKills
          riftHeraldKills = ConvertTo-FirestoreInt  $t.riftHeraldKills
        }
      }
    }
  }

  $body = @{
    fields = @{
      gameId              = @{ integerValue = [string]$gameId }
      capturedAt          = @{ timestampValue = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
      gameDurationSeconds = @{ integerValue = [string]$matchData.gameDuration }
      participants        = @{ arrayValue = @{ values = $participantFields } }
      teams               = @{ arrayValue = @{ values = $teamFields } }
    }
  } | ConvertTo-Json -Depth 20

  Invoke-RestMethod -Uri "$FirestoreBase/customGames?documentId=$gameId" -Method Post -Body $body -ContentType "application/json" | Out-Null
}

Write-Log "Custom Game Logger starting. Waiting for League client..."

$loggedGameIds = @{}
$lastPhase = $null
$capturedGameId = $null
$capturedQueueId = $null

while ($true) {
  $conn = Get-LcuConnection
  if (-not $conn) {
    Write-Log "League client not detected. Retrying in $PollSeconds s..."
    Start-Sleep -Seconds $PollSeconds
    continue
  }

  $phase = Invoke-Lcu $conn "/lol-gameflow/v1/gameflow-phase"
  if ($null -eq $phase) {
    Start-Sleep -Seconds $PollSeconds
    continue
  }

  if ($phase -ne $lastPhase) {
    Write-Log "Gameflow phase: $phase"
    $lastPhase = $phase
  }

  # Remember the gameId while a game is actually in progress, since it may
  # not be easily available once we reach the end-of-game screen.
  if ($phase -eq "InProgress" -or $phase -eq "ChampSelect") {
    $session = Invoke-Lcu $conn "/lol-gameflow/v1/session"
    if ($session -and $session.gameData -and $session.gameData.gameId) {
      $capturedGameId = $session.gameData.gameId
      $capturedQueueId = $session.gameData.queue.id
    }
  }

  if (($phase -eq "EndOfGame" -or $phase -eq "PreEndOfGame" -or $phase -eq "WaitingForStats") -and $capturedGameId) {
    if ($loggedGameIds.ContainsKey([string]$capturedGameId)) {
      Start-Sleep -Seconds $PollSeconds
      continue
    }

    Write-Log "Game ended (gameId=$capturedGameId, queueId=$capturedQueueId). Checking if it was a custom game..."

    # queueId 0 = custom game. If this isn't 0 skip it (customs-only logging).
    if ($capturedQueueId -ne 0) {
      Write-Log "Not a custom game (queueId=$capturedQueueId) â€” skipping, this is already covered by the Matches/Stats tabs."
      $loggedGameIds[[string]$capturedGameId] = $true
      Start-Sleep -Seconds $PollSeconds
      continue
    }

    $matchData = Invoke-Lcu $conn "/lol-match-history/v1/games/$capturedGameId"
    if (-not $matchData -or -not $matchData.participants) {
      Write-Log "Could not read match history for gameId=$capturedGameId. Raw response:"
      Write-Log ($matchData | ConvertTo-Json -Depth 6 -Compress)
      Write-Log "This likely means the LCU endpoint/field names differ from what this script expects â€” please report this output."
      Start-Sleep -Seconds $PollSeconds
      continue
    }

    try {
      Send-CustomGameToFirestore -gameId $capturedGameId -matchData $matchData
      $loggedGameIds[[string]$capturedGameId] = $true
      Write-Log "Custom game $capturedGameId uploaded successfully."
    } catch {
      Write-Log "Failed to upload custom game: $($_.Exception.Message)"
    }
  }

  Start-Sleep -Seconds $PollSeconds
}
