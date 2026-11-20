Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$sizes = @(16,20,24,32,40,48,64,128,256)
$images = @()
foreach ($size in $sizes) {
  $bitmap = New-Object Drawing.Bitmap $size,$size
  $g = [Drawing.Graphics]::FromImage($bitmap)
  $g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([Drawing.Color]::Transparent)
  $g.ScaleTransform(($size / 64.0),($size / 64.0))
  $shape = New-Object Drawing.Drawing2D.GraphicsPath
  $shape.AddArc(4,4,32,32,180,90); $shape.AddArc(28,4,32,32,270,90)
  $shape.AddArc(28,28,32,32,0,90); $shape.AddArc(4,28,32,32,90,90); $shape.CloseFigure()
  $fill = New-Object Drawing.SolidBrush ([Drawing.ColorTranslator]::FromHtml('#445B86'))
  $g.FillPath($fill,$shape)
  $pen = New-Object Drawing.Pen ([Drawing.ColorTranslator]::FromHtml('#F5F7FC')),3
  $pen.LineJoin = 'Round'; $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
  $book = New-Object Drawing.Drawing2D.GraphicsPath
  $book.AddLine(17,19,27,19); $book.AddBezier(27,19,30,19,32,21,32,23)
  $book.AddLine(32,23,32,47); $book.AddBezier(32,47,32,44,30,42,27,42)
  $book.AddLine(27,42,17,42); $book.CloseFigure()
  $g.DrawPath($pen,$book)
  $book.Reset(); $book.AddLine(47,19,37,19); $book.AddBezier(37,19,34,19,32,21,32,23)
  $book.AddLine(32,23,32,47); $book.AddBezier(32,47,32,44,34,42,37,42)
  $book.AddLine(37,42,47,42); $book.CloseFigure(); $g.DrawPath($pen,$book)
  $pen.Color = [Drawing.ColorTranslator]::FromHtml('#BBCBE7'); $pen.Width = 2
  foreach ($x in @(22,38)) { foreach ($y in @(27,34)) { $g.DrawLine($pen,$x,$y,($x+4),$y) } }
  $ms = New-Object IO.MemoryStream
  $bitmap.Save($ms,[Drawing.Imaging.ImageFormat]::Png)
  $images += ,$ms.ToArray()
  if ($size -eq 256) { $bitmap.Save((Join-Path $root 'build\icon-preview.png')) }
  $ms.Dispose(); $book.Dispose(); $shape.Dispose(); $fill.Dispose(); $pen.Dispose(); $g.Dispose(); $bitmap.Dispose()
}
$writer = New-Object IO.BinaryWriter ([IO.File]::Create((Join-Path $root 'build\icon.ico')))
try {
  $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
  $offset = 6 + 16 * $sizes.Count
  for ($i=0; $i -lt $sizes.Count; $i++) {
    $dimension = if ($sizes[$i] -eq 256) {0} else {$sizes[$i]}
    $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]32)
    $writer.Write([uint32]$images[$i].Length); $writer.Write([uint32]$offset)
    $offset += $images[$i].Length
  }
  foreach ($png in $images) { $writer.Write([byte[]]$png) }
} finally { $writer.Dispose() }
