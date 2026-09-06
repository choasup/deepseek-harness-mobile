#ifndef DSH_NODE_RUNTIME_H
#define DSH_NODE_RUNTIME_H

#ifdef __cplusplus
extern "C" {
#endif

/// 启动设备内的 Node，阻塞直到它退出。**要在自己的线程上调**。
///
/// argv 的语义与命令行 node 完全一致（argv[0] 是 "node"）。
/// 返回值是 Node 的退出码。
int dsh_node_start(int argc, char *argv[]);

#ifdef __cplusplus
}
#endif

#endif
