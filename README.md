# 图像清晰增强与语义分割（Swin2SR + SAM 2）

一个纯前端页面，支持：
- 图像清晰增强（Swin2SR，无 Token 时本地锐化回退）
- 图像语义分割（SAM 2，支持交互式点击选取；无 Token 时本地分割回退）
- 在交互式分割模式下，“下载结果”导出掩码覆盖的原图部分为透明 PNG（`segment_object.png`）；无掩码或默认模式下导出当前结果（`result.png`）。

## 使用方法
1. 打开页面，选择图片。
2. 选择处理模式：清晰增强或语义分割。
3. 勾选“交互式分割”，点击图片添加正/负样本（按住 Alt 为负样本）。
4. 点击“下载结果”导出。

## 开发与预览
- 启动本地预览：`python -m http.server 8081`（或使用 PowerShell HttpListener）。
- 部署生产版：`powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -Port 9094`
- 生产预览地址：`http://127.0.0.1:9094/`

## 文件结构
```
app.js       # 主逻辑：处理、分割、交互与下载
index.html   # 页面结构
style.css    # 页面样式
zoom.js      # 放大预览相关交互
deploy.ps1   # 生产部署脚本：复制到 dist 并启动静态服务器
```

## 许可证
未声明许可，按仓库使用约定。若需要，我们可补充常用开源许可（MIT/Apache-2.0）。