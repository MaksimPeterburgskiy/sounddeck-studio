# Generates build/icon.ico — multi-size icon (16..256) with PNG-compressed entries.
# Design: violet-indigo gradient rounded square with white equalizer bars.
Add-Type -AssemblyName System.Drawing

function New-IconPng([int]$s) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    # Rounded-square background with taskbar-friendly transparent padding.
    $m = [float]($s * 0.08)
    $w = [float]($s - 2 * $m)
    $r = [float]($w * 0.24)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($m, $m, $r * 2, $r * 2, 180, 90)
    $path.AddArc($m + $w - $r * 2, $m, $r * 2, $r * 2, 270, 90)
    $path.AddArc($m + $w - $r * 2, $m + $w - $r * 2, $r * 2, $r * 2, 0, 90)
    $path.AddArc($m, $m + $w - $r * 2, $r * 2, $r * 2, 90, 90)
    $path.CloseFigure()

    $c1 = [System.Drawing.Color]::FromArgb(255, 139, 92, 246)   # violet
    $c2 = [System.Drawing.Color]::FromArgb(255, 67, 56, 202)    # indigo
    $p1 = [System.Drawing.PointF]::new($m, $m)
    $p2 = [System.Drawing.PointF]::new($m + $w, $m + $w)
    $brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new($p1, $p2, $c1, $c2)
    $g.FillPath($brush, $path)

    # Equalizer bars
    $heights = @(0.32, 0.56, 0.80, 0.52, 0.30)
    $bw = [float]($w * 0.105)
    $gap = [float]($w * 0.062)
    $total = $heights.Count * $bw + ($heights.Count - 1) * $gap
    $x = [float](($s - $total) / 2)
    $cy = [float]($s / 2)
    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    foreach ($h in $heights) {
        $bh = [float]($w * 0.72 * $h)
        $bp = New-Object System.Drawing.Drawing2D.GraphicsPath
        $br = [float]($bw / 2)
        $top = [float]($cy - $bh / 2)
        $bp.AddArc($x, $top, $bw, $bw, 180, 180)
        $bp.AddArc($x, $top + $bh - $bw, $bw, $bw, 0, 180)
        $bp.CloseFigure()
        $g.FillPath($white, $bp)
        $x += $bw + $gap
    }

    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    return $ms.ToArray()
}

$sizes = 16, 24, 32, 48, 64, 128, 256
$images = @()
foreach ($s in $sizes) { $images += ,([byte[]](New-IconPng $s)) }

$out = New-Object System.IO.MemoryStream
$bw2 = New-Object System.IO.BinaryWriter($out)
$bw2.Write([uint16]0); $bw2.Write([uint16]1); $bw2.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]
    $bw2.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
    $bw2.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
    $bw2.Write([byte]0); $bw2.Write([byte]0)
    $bw2.Write([uint16]1); $bw2.Write([uint16]32)
    $bw2.Write([uint32]$images[$i].Length)
    $bw2.Write([uint32]$offset)
    $offset += $images[$i].Length
}
foreach ($img in $images) { $bw2.Write([byte[]]$img) }
[System.IO.File]::WriteAllBytes("$PSScriptRoot\icon.ico", $out.ToArray())
Write-Host "Wrote $PSScriptRoot\icon.ico ($($out.Length) bytes)"
