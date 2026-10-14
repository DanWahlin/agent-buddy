#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>

namespace copilot {
constexpr size_t kSpeechHeaderBytes = 16;
constexpr uint8_t kSpeechWireVersion = 1;
constexpr uint8_t kSpeechFormatPcmS16LeMono = 1;
constexpr uint32_t kSpeechSampleRate = 24000;
constexpr uint32_t kMaxSpeechSeconds = 15;
constexpr uint32_t kMaxSpeechFrames = kSpeechSampleRate * kMaxSpeechSeconds;
constexpr size_t kMaxSpeechPayloadBytes = kMaxSpeechFrames * sizeof(int16_t);
constexpr size_t kMaxSpeechRequestBytes = kSpeechHeaderBytes + kMaxSpeechPayloadBytes;

struct SpeechHeader {
  uint32_t frames;
};

inline uint16_t speechReadLe16(const uint8_t* data) {
  return static_cast<uint16_t>(data[0])
      | static_cast<uint16_t>(data[1]) << 8;
}

inline uint32_t speechReadLe32(const uint8_t* data) {
  return static_cast<uint32_t>(data[0])
      | static_cast<uint32_t>(data[1]) << 8
      | static_cast<uint32_t>(data[2]) << 16
      | static_cast<uint32_t>(data[3]) << 24;
}

inline const char* parseSpeechHeader(const uint8_t* data, size_t bytes,
                                     size_t requestBytes, SpeechHeader& header) {
  if (!data || bytes != kSpeechHeaderBytes)
    return "Invalid speech header.";
  if (std::memcmp(data, "ACSP", 4) != 0)
    return "Invalid speech magic.";
  if (data[4] != kSpeechWireVersion)
    return "Unsupported speech version.";
  if (data[5] != kSpeechFormatPcmS16LeMono)
    return "Unsupported speech format.";
  if (speechReadLe16(data + 6) != kSpeechSampleRate)
    return "Unsupported speech sample rate.";
  header.frames = speechReadLe32(data + 8);
  if (speechReadLe32(data + 12) != 0)
    return "Invalid speech header flags.";
  if (header.frames == 0)
    return "Speech audio is empty.";
  if (header.frames > kMaxSpeechFrames)
    return "Speech audio exceeds 15 seconds.";
  const size_t expected = kSpeechHeaderBytes
      + static_cast<size_t>(header.frames) * sizeof(int16_t);
  if (requestBytes != expected)
    return "Speech content length does not match its header.";
  return nullptr;
}
}
