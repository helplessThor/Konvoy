Add-Type -AssemblyName System.Drawing

$srcPath = "C:\Users\Kuntal\.gemini\antigravity-ide\brain\a18d084e-344f-4acd-a553-7aa28af7cf26\konvoy_app_icon_1788781788201.jpg"
$baseDir = "c:\Users\Kuntal\Desktop\Projects\Konvoy\android\app\src\main\res"

$sizes = @{
    "mipmap-mdpi" = 48
    "mipmap-hdpi" = 72
    "mipmap-xhdpi" = 96
    "mipmap-xxhdpi" = 144
    "mipmap-xxxhdpi" = 192
}

$srcImg = [System.Drawing.Image]::FromFile($srcPath)

foreach ($folder in $sizes.Keys) {
    $size = $sizes[$folder]
    $targetDir = Join-Path $baseDir $folder
    
    # 1. Square ic_launcher.png
    $bmpSquare = New-Object System.Drawing.Bitmap $size, $size
    $gSquare = [System.Drawing.Graphics]::FromImage($bmpSquare)
    $gSquare.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $gSquare.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $gSquare.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $gSquare.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $gSquare.DrawImage($srcImg, 0, 0, $size, $size)
    $gSquare.Dispose()
    
    $squarePath = Join-Path $targetDir "ic_launcher.png"
    $bmpSquare.Save($squarePath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmpSquare.Dispose()
    Write-Output "Saved $squarePath ($size x $size)"

    # 2. Round ic_launcher_round.png
    $bmpRound = New-Object System.Drawing.Bitmap $size, $size
    $gRound = [System.Drawing.Graphics]::FromImage($bmpRound)
    $gRound.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $gRound.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $gRound.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $gRound.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddEllipse(0, 0, $size, $size)
    $gRound.SetClip($path)
    $gRound.DrawImage($srcImg, 0, 0, $size, $size)
    $path.Dispose()
    $gRound.Dispose()
    
    $roundPath = Join-Path $targetDir "ic_launcher_round.png"
    $bmpRound.Save($roundPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmpRound.Dispose()
    Write-Output "Saved $roundPath ($size x $size)"
}

$srcImg.Dispose()
Write-Output "All icons generated successfully!"
