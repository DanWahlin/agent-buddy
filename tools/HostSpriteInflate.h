#pragma once
#include "../firmware/AgentCompanion/src/SpritePredictor.h"
#include <array>
#include <limits>
#include <zlib.h>

inline bool inflateSpriteHost(uint8_t* output, size_t outputSize,
                              const uint8_t* input, size_t inputSize, size_t width, size_t stride) {
  copilot::SpritePredictor predictor;
  if (!input || inputSize > std::numeric_limits<uInt>::max()
      || !predictor.reset(output, outputSize, width, stride)) return false;
  z_stream stream{};
  stream.next_in = const_cast<Bytef*>(input);
  stream.avail_in = static_cast<uInt>(inputSize);
  if (inflateInit(&stream) != Z_OK) return false;
  struct End {
    z_stream* stream;
    ~End() { inflateEnd(stream); }
  } end{&stream};
  std::array<uint8_t, 32768> filtered;
  for (;;) {
    stream.next_out = filtered.data();
    stream.avail_out = filtered.size();
    const auto before = stream.avail_in;
    const int status = inflate(&stream, Z_NO_FLUSH);
    const size_t bytes = filtered.size() - stream.avail_out;
    if ((status != Z_OK && status != Z_STREAM_END) || !predictor.consume(filtered.data(), bytes)) return false;
    if (status == Z_STREAM_END) return !stream.avail_in && predictor.complete();
    if (!bytes && stream.avail_in == before) return false;
  }
}
