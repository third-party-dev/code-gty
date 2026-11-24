# code-gty shell integration for PowerShell.
if ($env:GTY_SHELL_INTEGRATION -ne '1' -or $Global:__GtyLoaded) { return }
$Global:__GtyLoaded = $true
Remove-Item Env:GTY_SHELL_INTEGRATION -ErrorAction SilentlyContinue

$Global:__GtyOriginalPrompt = $function:Prompt
$Global:__GtyFirstPrompt = $true
$Global:__GtyLastHistoryId = -1

function Global:Prompt() {
    $status = $global:?
    $code = $global:LASTEXITCODE
    $esc = [char]0x1b
    $bel = [char]0x07
    $out = ''
    $last = Get-History -Count 1
    if (-not $Global:__GtyFirstPrompt -and $last -and $last.Id -ne $Global:__GtyLastHistoryId) {
        $exit = if ($status) { 0 } elseif ($code) { $code } else { 1 }
        $out += "$esc]133;D;$exit$bel"
        $Global:__GtyLastHistoryId = $last.Id
    }
    $Global:__GtyFirstPrompt = $false
    $loc = $executionContext.SessionState.Path.CurrentLocation
    if ($loc.Provider.Name -eq 'FileSystem') {
        $path = $loc.ProviderPath -replace '\\', '/'
        if ($path -notmatch '^/') { $path = "/$path" }
        $out += "$esc]7;file://$([System.Net.Dns]::GetHostName())$([uri]::EscapeUriString($path))$bel"
    }
    $out += "$esc]133;A$bel"
    $out += & $Global:__GtyOriginalPrompt
    $out += "$esc]133;B$bel"
    $global:LASTEXITCODE = $code
    return $out
}

if (Get-Module -Name PSReadLine) {
    $Global:__GtyOriginalAccept = (Get-PSReadLineKeyHandler -Chord Enter -ErrorAction SilentlyContinue | Select-Object -First 1)
    Set-PSReadLineKeyHandler -Chord Enter -ScriptBlock {
        [Console]::Write("$([char]0x1b)]133;C$([char]0x07)")
        [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
    }
}
