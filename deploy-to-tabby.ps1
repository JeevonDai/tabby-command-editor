#Requires -Version 5.1
<#
.SYNOPSIS
    将 tabby-command-editor 构建产物同步到当前用户的 Tabby 插件目录。

.DESCRIPTION
    默认目标路径：
      %APPDATA%\tabby\plugins\node_modules\tabby-command-editor
    即：
      C:\Users\<当前用户名>\AppData\Roaming\tabby\plugins\node_modules\tabby-command-editor

.PARAMETER Build
    部署前先执行 npm run build。

.PARAMETER SourcePath
    源码根目录，需包含 dist、typings 等。默认为本脚本所在目录。

.PARAMETER TargetPath
    Tabby 插件安装目录。默认根据当前用户自动解析。

.PARAMETER Items
    要同步的条目，默认同步 dist、typings、package.json。

.EXAMPLE
    .\deploy-to-tabby.ps1

.EXAMPLE
    .\deploy-to-tabby.ps1 -Build

.EXAMPLE
    .\deploy-to-tabby.ps1 -TargetPath "D:\tabby\plugins\node_modules\tabby-command-editor"
#>
[CmdletBinding()]
param(
    [switch]$Build,
    [string]$SourcePath,
    [string]$TargetPath,
    [string[]]$Items = @('dist', 'typings', 'package.json')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

if ([string]::IsNullOrWhiteSpace($SourcePath)) {
    $SourcePath = $PSScriptRoot
}

function Write-Step {
    param([string]$Message)
    Write-Host "=> $Message" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Message)
    Write-Host "OK $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host "!! $Message" -ForegroundColor Yellow
}

function Resolve-TabbyPluginPath {
    if (-not [string]::IsNullOrWhiteSpace($TargetPath)) {
        return [System.IO.Path]::GetFullPath($TargetPath)
    }

    if (-not $env:APPDATA) {
        throw '环境变量 APPDATA 未设置，无法解析 Tabby 插件路径。请使用 -TargetPath 手动指定。'
    }

    return [System.IO.Path]::GetFullPath(
        (Join-Path $env:APPDATA 'tabby\plugins\node_modules\tabby-command-editor')
    )
}

function Invoke-ProjectBuild {
    param([string]$Root)

    $packageJson = Join-Path $Root 'package.json'
    if (-not (Test-Path -LiteralPath $packageJson)) {
        throw "未找到 package.json：$packageJson"
    }

    Push-Location -LiteralPath $Root
    try {
        if (Get-Command npm -ErrorAction SilentlyContinue) {
            Write-Step '执行 npm run build ...'
            & npm run build
        }
        elseif (Get-Command yarn -ErrorAction SilentlyContinue) {
            Write-Step '执行 yarn build ...'
            & yarn build
        }
        else {
            throw '未找到 npm 或 yarn，请先安装 Node.js，或去掉 -Build 参数手动构建。'
        }

        if ($LASTEXITCODE -ne 0) {
            throw "构建失败，退出码：$LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

function Sync-ItemToTarget {
    param(
        [string]$SourceRoot,
        [string]$DestinationRoot,
        [string]$ItemName
    )

    $source = Join-Path $SourceRoot $ItemName
    if (-not (Test-Path -LiteralPath $source)) {
        Write-Warn "跳过不存在的源项：$source"
        return
    }

    $destination = Join-Path $DestinationRoot $ItemName
    $destinationParent = Split-Path -Parent $destination
    if ($destinationParent -and -not (Test-Path -LiteralPath $destinationParent)) {
        New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
    }

    if ((Get-Item -LiteralPath $source).PSIsContainer) {
        if (-not (Test-Path -LiteralPath $destination)) {
            New-Item -ItemType Directory -Path $destination -Force | Out-Null
        }

        # /E 复制子目录（含空目录），/MIR 镜像同步，/NFL /NDL 减少冗余输出
        $robocopyArgs = @(
            $source,
            $destination,
            '/MIR',
            '/NFL',
            '/NDL',
            '/NJH',
            '/NJS',
            '/nc',
            '/ns',
            '/np'
        )
        & robocopy @robocopyArgs | Out-Null

        # robocopy 退出码 0-7 均表示成功或仅警告
        if ($LASTEXITCODE -gt 7) {
            throw "同步目录失败：$source -> $destination（robocopy 退出码 $LASTEXITCODE）"
        }
    }
    else {
        Copy-Item -LiteralPath $source -Destination $destination -Force
    }

    Write-Ok "已同步 $ItemName"
}

$sourceRoot = [System.IO.Path]::GetFullPath($SourcePath)
$targetRoot = Resolve-TabbyPluginPath
$userName = $env:USERNAME

Write-Host ''
Write-Host 'tabby-command-editor -> Tabby 插件部署' -ForegroundColor White
Write-Host "当前用户 : $userName"
Write-Host "源目录   : $sourceRoot"
Write-Host "目标目录 : $targetRoot"
Write-Host ''

if (-not (Test-Path -LiteralPath $targetRoot)) {
    throw @"
目标目录不存在：
  $targetRoot

请先在 Tabby 中安装插件，或手动创建该目录后重试。
也可使用 -TargetPath 指定其他路径。
"@
}

if ($Build) {
    Invoke-ProjectBuild -Root $sourceRoot
}

$distPath = Join-Path $sourceRoot 'dist'
if ($Items -contains 'dist' -and -not (Test-Path -LiteralPath $distPath)) {
    throw @"
未找到构建产物目录：
  $distPath

请先执行构建：
  npm run build
或带上 -Build 参数：
  .\deploy-to-tabby.ps1 -Build
"@
}

Write-Step '开始同步文件 ...'
foreach ($item in $Items) {
    Sync-ItemToTarget -SourceRoot $sourceRoot -DestinationRoot $targetRoot -ItemName $item
}

Write-Host ''
Write-Ok '部署完成。请重启 Tabby 或重新加载插件以使更改生效。'
Write-Host ''
