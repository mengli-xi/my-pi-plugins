# 固定的存储 ABI 1 fixture

src/child-capability-{manifest,registry}.ts 保留旧 target validator 与 pi.child-capability-registry.v1 manager。混合代际测试需要真实旧 register closure，不能用当前 schema 的两个副本替代；因此不要随生产实现更新。小型 package/import shim 让它成为物理隔离、可移植的旧库。
