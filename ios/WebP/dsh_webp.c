#include "dsh_webp.h"

#include "src/webp/encode.h"

size_t dsh_webp_encode_rgba(const uint8_t *rgba, int width, int height,
                            int stride, int has_alpha, float quality,
                            uint8_t **out) {
  WebPConfig config;
  if (!WebPConfigPreset(&config, WEBP_PRESET_PHOTO, quality)) return 0;
  // 归一化的输出会被上游逐字节重新解码校验，稳定比快一点更重要。
  config.thread_level = 0;
  if (!WebPValidateConfig(&config)) return 0;

  WebPPicture picture;
  if (!WebPPictureInit(&picture)) return 0;
  picture.use_argb = 1;
  picture.width = width;
  picture.height = height;

  WebPMemoryWriter writer;
  WebPMemoryWriterInit(&writer);
  picture.writer = WebPMemoryWrite;
  picture.custom_ptr = &writer;

  // ImportRGBX 忽略第四字节：CGBitmapContext 的 `noneSkipLast` 缓冲区里
  // 那一字节是未定义的，当成 alpha 用会编出一张随机透明的图。
  const int imported = has_alpha ? WebPPictureImportRGBA(&picture, rgba, stride)
                                 : WebPPictureImportRGBX(&picture, rgba, stride);
  if (!imported) {
    WebPPictureFree(&picture);
    WebPMemoryWriterClear(&writer);
    return 0;
  }

  const int ok = WebPEncode(&config, &picture);
  WebPPictureFree(&picture);
  if (!ok) {
    WebPMemoryWriterClear(&writer);
    return 0;
  }

  *out = writer.mem;  // 所有权交给调用方，见 dsh_webp_free
  return writer.size;
}

void dsh_webp_free(uint8_t *data) { WebPFree(data); }
