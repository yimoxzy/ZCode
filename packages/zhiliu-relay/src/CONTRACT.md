# 织流薄relay

原V2 HTTP/WS schema来自shared；SaaS内省是唯一身份来源。只拥有设备、token、连接与角色owner，不持有任务、消息历史或Agent。scope=user+space，设备绑定native device*id。rc*、单次token与service secret不得落日志。先校验scope再替换owner，旧close按实例清理。单实例内存目录，重启由现有client重注册。完整合同与部署边界见specs/zhiliu-relay.md。
