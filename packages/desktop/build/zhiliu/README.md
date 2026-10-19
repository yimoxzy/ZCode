# 织流品牌资产

本目录复用织流 SaaS 项目 `desktop/assets/` 已有的青色织流标志，不覆盖 `build/` 中的 ZCode 上游素材。

来源：`F:/agent/zhiliu/release-candidate-20261018/desktop/assets/`，复制日期：2026-10-19。

| 源文件    | SHA256                                                             |
| --------- | ------------------------------------------------------------------ |
| icon.svg  | `0b5838d4b4dbbffa250934acf7e80ff7c2c6c37dba705770dcb831a188526734` |
| icon.png  | `9f6e781cc0fcece5272dd5da309c3220ccffc236c4923c6a554eee4e8254d498` |
| icon.ico  | `767dc857a4fd46088f733baaf51f4d1402a8eea55b7f2b0c90797895e86b0298` |
| icon.icns | `3ec8f5e6c81388dbd6788e1ae102fa97098303f6e4bef570e02f4124cfad17de` |

`icon_windows.png`、`icon_installer.png` 直接复制同一原 PNG；安装器 ICO/ICNS 直接复制同一原格式。`icons/` 中的 16、24、32、48、64、128、256、512、1024px PNG 由原 1024px PNG 使用 Pillow LANCZOS 等比例缩放生成。

仅在 `ZHILIU_DESKTOP=1` 时用于应用及安装资源。原上游许可、第三方署名及保留资源继续存在；本目录不宣称拥有上游代码版权。
