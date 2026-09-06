#import "NodeRuntime.h"

// 只声明要用的那一个符号，不 #include <node.h>。
//
// node.h 会拖进 V8 的一大堆头文件和它自己的编译期配置（pointer compression、
// sandbox 之类）；这些配置必须与静态库的构建配置逐位一致，否则是 ODR 违规——
// 症状是链接通过、运行时随机崩溃，极难排查。这里要的只是一个入口点，
// 手写声明反而更安全。签名来自 node-22 的 src/node.h:325：
//     NODE_EXTERN int Start(int argc, char* argv[]);
namespace node {
int Start(int argc, char *argv[]);
}  // namespace node

int dsh_node_start(int argc, char *argv[]) {
  return node::Start(argc, argv);
}
