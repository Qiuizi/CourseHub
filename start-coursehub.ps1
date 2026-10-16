# CourseHub 前台启动脚本
Set-Location -LiteralPath $PSScriptRoot
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  CourseHub v0.3.4 前台启动器 (PowerShell)" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "正在通过 npm run dev 启动开发服务与 Electron 窗口..." -ForegroundColor Yellow
Write-Host "(请保持本窗口开启)" -ForegroundColor Gray
Write-Host ""

npm run dev
