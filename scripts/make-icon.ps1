param(
  [string]$Assets = (Join-Path $PSScriptRoot '..\desktop\assets')
)

Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$size = 1024
$assetsPath = [System.IO.Path]::GetFullPath($Assets)
[System.IO.Directory]::CreateDirectory($assetsPath) | Out-Null

function New-RoundedPath {
  param([single]$X, [single]$Y, [single]$Width, [single]$Height, [single]$Radius)
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $diameter = $Radius * 2
  $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
  $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
  $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function Add-RoundedRect {
  param(
    [System.Drawing.Drawing2D.GraphicsPath]$Path,
    [single]$X,
    [single]$Y,
    [single]$Width,
    [single]$Height,
    [single]$Radius
  )
  $diameter = $Radius * 2
  $Path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
  $Path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
  $Path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
  $Path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
  $Path.CloseFigure()
}

$bitmap = [System.Drawing.Bitmap]::new(
  $size,
  $size,
  [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$graphics.Clear([System.Drawing.Color]::Transparent)

# Rounded tile with a deep blue secure-shell gradient.
$tileRect = [System.Drawing.RectangleF]::new(32, 32, 960, 960)
$tilePath = New-RoundedPath 32 32 960 960 220
$tileBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
  $tileRect,
  [System.Drawing.Color]::FromArgb(255, 5, 13, 25),
  [System.Drawing.Color]::FromArgb(255, 13, 56, 95),
  45.0
)
$tileBlend = [System.Drawing.Drawing2D.ColorBlend]::new(3)
$tileBlend.Colors = @(
  [System.Drawing.Color]::FromArgb(255, 5, 13, 25),
  [System.Drawing.Color]::FromArgb(255, 9, 30, 54),
  [System.Drawing.Color]::FromArgb(255, 18, 70, 116)
)
$tileBlend.Positions = @(0.0, 0.52, 1.0)
$tileBrush.InterpolationColors = $tileBlend
$graphics.FillPath($tileBrush, $tilePath)

# Soft blue glow behind the monogram.
$glowPath = [System.Drawing.Drawing2D.GraphicsPath]::new()
$glowPath.AddEllipse(120, 100, 784, 650)
$glowBrush = [System.Drawing.Drawing2D.PathGradientBrush]::new($glowPath)
$glowBrush.CenterPoint = [System.Drawing.PointF]::new(512, 430)
$glowBrush.CenterColor = [System.Drawing.Color]::FromArgb(115, 35, 132, 220)
$glowBrush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 35, 132, 220))
$graphics.FillPath($glowBrush, $glowPath)

# Faint terminal grid / connection rings.
$ringPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(22, 96, 190, 255), 2)
$graphics.DrawEllipse($ringPen, 164, 164, 696, 696)
$ringPen2 = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(15, 96, 190, 255), 2)
$graphics.DrawEllipse($ringPen2, 112, 112, 800, 800)

# Subtle border highlight.
$borderPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(120, 92, 190, 255), 5)
$graphics.DrawPath($borderPen, $tilePath)

# H monogram: two solid stems and a cyan crossbar.
$stemPath = [System.Drawing.Drawing2D.GraphicsPath]::new()
Add-RoundedRect $stemPath 236 220 150 520 70
Add-RoundedRect $stemPath 638 220 150 520 70
$crossPath = New-RoundedPath 350 410 324 142 58

$shadowPath = [System.Drawing.Drawing2D.GraphicsPath]::new()
$shadowPath.AddPath($stemPath, $false)
$shadowPath.AddPath($crossPath, $false)
$shadowBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(85, 0, 0, 0))
$graphics.TranslateTransform(0, 16)
$graphics.FillPath($shadowBrush, $shadowPath)
$graphics.ResetTransform()

$stemRect = [System.Drawing.RectangleF]::new(236, 220, 552, 520)
$stemBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
  $stemRect,
  [System.Drawing.Color]::FromArgb(255, 255, 255, 255),
  [System.Drawing.Color]::FromArgb(255, 197, 232, 255),
  90.0
)
$graphics.FillPath($stemBrush, $stemPath)

$crossRect = [System.Drawing.RectangleF]::new(350, 410, 324, 142)
$crossBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
  $crossRect,
  [System.Drawing.Color]::FromArgb(255, 137, 232, 255),
  [System.Drawing.Color]::FromArgb(255, 38, 137, 255),
  0.0
)
$graphics.FillPath($crossBrush, $crossPath)

# SSH lock + label plate.
$platePath = New-RoundedPath 282 790 460 118 59
$plateBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(238, 5, 18, 33))
$graphics.FillPath($plateBrush, $platePath)
$platePen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(150, 80, 196, 255), 3)
$graphics.DrawPath($platePen, $platePath)

$lockColor = [System.Drawing.Color]::FromArgb(255, 102, 220, 255)
$lockPen = [System.Drawing.Pen]::new($lockColor, 9)
$lockPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$lockPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$graphics.DrawArc($lockPen, 338, 818, 38, 47, 180, 180)
$graphics.DrawLine($lockPen, 338, 842, 338, 852)
$graphics.DrawLine($lockPen, 376, 842, 376, 852)
$lockBody = New-RoundedPath 326 844 62 46 10
$lockBrush = [System.Drawing.SolidBrush]::new($lockColor)
$graphics.FillPath($lockBrush, $lockBody)
$keyBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 7, 28, 48))
$graphics.FillEllipse($keyBrush, 352, 858, 10, 10)
$graphics.FillRectangle($keyBrush, 355, 865, 4, 12)

$sshFont = [System.Drawing.Font]::new(
  'Segoe UI',
  68,
  [System.Drawing.FontStyle]::Bold,
  [System.Drawing.GraphicsUnit]::Pixel
)
$sshBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 234, 249, 255))
$letters = @('S', 'S', 'H')
$letterWidths = @()
foreach ($letter in $letters) {
  $letterWidths += $graphics.MeasureString($letter, $sshFont).Width
}
$letterGap = 7
$textWidth = ($letterWidths | Measure-Object -Sum).Sum + ($letterGap * 2)
$textX = 430 + ((250 - $textWidth) / 2)
$textY = 800
foreach ($index in 0..2) {
  $graphics.DrawString($letters[$index], $sshFont, $sshBrush, $textX, $textY)
  $textX += $letterWidths[$index] + $letterGap
}

# Save the master PNG.
$pngPath = Join-Path $assetsPath 'icon.png'
$bitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)

# Build a multi-resolution PNG-compressed ICO for Windows.
$icoSizes = @(16, 24, 32, 48, 64, 128, 256)
$pngData = @()
foreach ($icoSize in $icoSizes) {
  $resized = [System.Drawing.Bitmap]::new(
    $icoSize,
    $icoSize,
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
  )
  $resizeGraphics = [System.Drawing.Graphics]::FromImage($resized)
  $resizeGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $resizeGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $resizeGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $resizeGraphics.DrawImage($bitmap, 0, 0, $icoSize, $icoSize)
  $stream = [System.IO.MemoryStream]::new()
  $resized.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngData += ,$stream.ToArray()
  $stream.Dispose()
  $resizeGraphics.Dispose()
  $resized.Dispose()
}

$icoPath = Join-Path $assetsPath 'icon.ico'
$file = [System.IO.File]::Create($icoPath)
$writer = [System.IO.BinaryWriter]::new($file)
$writer.Write([uint16]0)
$writer.Write([uint16]1)
$writer.Write([uint16]$icoSizes.Count)
$offset = 6 + (16 * $icoSizes.Count)
for ($index = 0; $index -lt $icoSizes.Count; $index++) {
  $icoSize = $icoSizes[$index]
  $bytes = $pngData[$index]
  $dimension = if ($icoSize -ge 256) { 0 } else { $icoSize }
  $writer.Write([byte]$dimension)
  $writer.Write([byte]$dimension)
  $writer.Write([byte]0)
  $writer.Write([byte]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]32)
  $writer.Write([uint32]$bytes.Length)
  $writer.Write([uint32]$offset)
  $offset += $bytes.Length
}
foreach ($bytes in $pngData) {
  $writer.Write($bytes)
}
$writer.Flush()
$writer.Dispose()
$file.Dispose()

$graphics.Dispose()
$bitmap.Dispose()
$ringPen.Dispose()
$ringPen2.Dispose()
$borderPen.Dispose()
$tileBrush.Dispose()
$tilePath.Dispose()
$glowPath.Dispose()
$glowBrush.Dispose()
$stemPath.Dispose()
$crossPath.Dispose()
$shadowPath.Dispose()
$shadowBrush.Dispose()
$stemBrush.Dispose()
$crossBrush.Dispose()
$platePath.Dispose()
$plateBrush.Dispose()
$platePen.Dispose()
$lockPen.Dispose()
$lockBrush.Dispose()
$lockBody.Dispose()
$keyBrush.Dispose()
$sshFont.Dispose()
$sshBrush.Dispose()

Write-Output "icon.png: $pngPath"
Write-Output "icon.ico: $icoPath"
