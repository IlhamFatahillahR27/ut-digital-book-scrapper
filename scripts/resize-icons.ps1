Add-Type -AssemblyName System.Drawing
$srcPath = (Resolve-Path "public\icon_ut.png").Path
$sizes = @(16, 32, 48, 128)

foreach ($size in $sizes) {
    $srcImg = [System.Drawing.Image]::FromFile($srcPath)
    $destBmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($destBmp)
    
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    
    $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $g.DrawImage($srcImg, $rect)
    
    $outPath = Join-Path "public\icons" "icon-$size.png"
    $destBmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    
    $g.Dispose()
    $destBmp.Dispose()
    $srcImg.Dispose()
    Write-Host "Generated $outPath ($size x $size)"
}
