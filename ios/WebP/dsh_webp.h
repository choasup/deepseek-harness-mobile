// libwebp 的最小封装：一次 RGBA → WebP 编码。
//
// ## 为什么 app 里要带一个 WebP 编码器
//
// iOS 的 ImageIO **能读 WebP，但不能写**（`CGImageDestinationCopyTypeIdentifiers()`
// 里没有它）。而 dsh 的附件归一化对**带透明通道**的图只提供 WebP 这一条编码
// 路径——`encodingAttemptsAtSize` 里 `if (hasAlpha) return webp;`，没有退路。
//
// 退回 JPEG 是不行的：上游 `verifyNormalizedImage` 会把编出来的字节重新解码，
// 比对 `detected.mediaType !== image.mediaType`，标着 webp 的 JPEG 必然判负，
// 而报出来的还是那句和真因无关的 "Unsupported or malformed image data"。
//
// 所以把 libwebp 的编码器编进 app。~120 个 C 文件、约 300KB 代码，
// 换掉的是"透明图一张也存不进去"。
#ifndef DSH_WEBP_H
#define DSH_WEBP_H

#include <stddef.h>
#include <stdint.h>

/// 把 RGBA8（或 RGBX8，第四字节忽略）编码成 WebP。
///
/// @param rgba      像素，每行 `stride` 字节，**非预乘**。
/// @param has_alpha 非 0 时第四通道参与编码；为 0 时按不透明处理。
/// @param quality   0–100。
/// @param out       成功时指向新分配的缓冲区，由 `dsh_webp_free` 释放。
/// @return 字节数；0 表示失败（此时 `*out` 未被设置）。
size_t dsh_webp_encode_rgba(const uint8_t *rgba, int width, int height,
                            int stride, int has_alpha, float quality,
                            uint8_t **out);

void dsh_webp_free(uint8_t *data);

#endif
