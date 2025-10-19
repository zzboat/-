param(
  [int]$Port = 9093
)

$ErrorActionPreference = 'Stop'
$root = Get-Location
$dist = Join-Path $root 'dist'

Write-Host "[deploy] 构建产物到: $dist" -ForegroundColor Cyan
if (Test-Path $dist) {
  try { Remove-Item -Recurse -Force $dist } catch { Write-Warning "无法清理 dist：$_" }
}
New-Item -ItemType Directory -Path $dist | Out-Null

# 复制静态文件（按需扩展）
$files = @('index.html','style.css','app.js','zoom.js')
foreach ($f in $files) {
  if (Test-Path (Join-Path $root $f)) {
    Copy-Item -Force (Join-Path $root $f) $dist
  } else {
    Write-Warning "缺少文件：$f"
  }
}

# 可选：复制 assets 目录（如存在）
$assetsDir = Join-Path $root 'assets'
if (Test-Path $assetsDir) {
  Copy-Item -Recurse -Force $assetsDir $dist
}

Add-Type -AssemblyName System.Net
$listener = New-Object System.Net.HttpListener
$prefix = "http://127.0.0.1:$Port/"
if (-not $listener.Prefixes.Contains($prefix)) { $listener.Prefixes.Add($prefix) }
$listener.Start()
Write-Host "[deploy] 生产服务器已启动: $prefix" -ForegroundColor Green
Write-Host "[deploy] 根目录: $dist" -ForegroundColor Green
Write-Host "[deploy] 按 Ctrl+C 停止服务器" -ForegroundColor Yellow

# MIME 类型映射
$mimeMap = @{ 
  '.html' = 'text/html'; '.htm' = 'text/html';
  '.css'  = 'text/css';
  '.js'   = 'application/javascript';
  '.json' = 'application/json';
  '.png'  = 'image/png'; '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'; '.gif' = 'image/gif'; '.svg' = 'image/svg+xml';
  '.ico'  = 'image/x-icon';
}

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response

    $path = $req.Url.AbsolutePath.TrimStart('/')
    if ([string]::IsNullOrWhiteSpace($path)) { $path = 'index.html' }
    $full = Join-Path $dist $path

    if (Test-Path $full -PathType Leaf) {
      $ext = [IO.Path]::GetExtension($full).ToLowerInvariant()
      $res.ContentType = $mimeMap[$ext]
      if (-not $res.ContentType) { $res.ContentType = 'application/octet-stream' }
      $bytes = [IO.File]::ReadAllBytes($full)
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $res.StatusCode = 404
      $msg = "Not Found"
      $bytes = [Text.Encoding]::UTF8.GetBytes($msg)
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    }
  } catch {
    Write-Warning "请求处理错误：$_"
  } finally {
    if ($res -and $res.OutputStream) { try { $res.OutputStream.Close() } catch { } }
    if ($res) { try { $res.Close() } catch { } }
  }
}