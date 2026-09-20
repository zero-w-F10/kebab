<#
  把图标光栅化成 src/icon.png，给 favicon 当位图兜底。

  为什么要这一份：Chromium 系浏览器（Chrome、Edge）不一定肯拿 SVG 当 favicon ——
  地址栏常常直接回退成默认的地球图标，Edge 对图标的挑剔程度比 Chrome 更狠。
  同时给 SVG 与 PNG 两个 link，浏览器挑得着哪个用哪个。

  几何参数与 src/icon.svg 一一对应（同一套 32 网格）：改了那边的图形，这边要跟着改完重跑，

      powershell -ExecutionPolicy Bypass -File tools/render-icon-png.ps1

  只用到 .NET 自带的 System.Drawing，不装任何东西。
#>

Add-Type -AssemblyName System.Drawing

# GDI+ 没有现成的圆角矩形，四个角各画一段圆弧拼出来
function New-RoundRectPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $d = 2 * $r
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-IconBitmap([int]$size) {
  $bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $canvas = [System.Drawing.Graphics]::FromImage($bitmap)
  $canvas.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $canvas.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $canvas.Clear([System.Drawing.Color]::Transparent)
  # 一律按 32 网格下笔，尺寸交给变换
  $canvas.ScaleTransform($size / 32.0, $size / 32.0)

  $bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 43, 108, 255))
  $canvas.FillPath($bg, (New-RoundRectPath 0 0 32 32 7))

  # 三根签：竖笔与两条斜臂
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 2.4)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $canvas.DrawLine($pen, 8.5, 7.5, 8.5, 24.5)
  $canvas.DrawLine($pen, 8.5, 16, 23.5, 7)
  $canvas.DrawLine($pen, 8.5, 16, 23.5, 25)

  # 两块肉，顺着斜臂倾斜，落在靠外的位置
  $meat = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  foreach ($spec in @(@(20.2, 8.98, -31.0), @(20.2, 23.02, 31.0))) {
    $cx = [float]$spec[0]
    $cy = [float]$spec[1]
    $path = New-RoundRectPath ($cx - 3.2) ($cy - 3.2) 6.4 6.4 1.6
    $turn = New-Object System.Drawing.Drawing2D.Matrix
    $turn.RotateAt([float]$spec[2], (New-Object System.Drawing.PointF($cx, $cy)))
    $path.Transform($turn)
    $canvas.FillPath($meat, $path)
    $path.Dispose()
    $turn.Dispose()
  }

  $canvas.Dispose()
  return $bitmap
}

$out = Join-Path $PSScriptRoot "..\src\icon.png"
$bitmap = New-IconBitmap 32
$bitmap.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
Write-Host "已写出 $([System.IO.Path]::GetFullPath($out))"
