# 托管执行边界

Main仅通过私有端口发行/撤销短期授权，Host唯一拥有broker，CLI只得到本机capability。`resolve`按工作区single-flight，`invalidate`同步关准入并等待broker与CLI清理，`dispose`永久关闭。平台profile为只读目录事实，不允许个人供应商覆盖。协议见 `specs/zhiliu-managed-runtime.md`；服务端是模型路由、幂等和计费的唯一权威。
