#include "../firmware/AgentCompanion/src/SpeechWire.h"

#include <array>
#include <cassert>
#include <cstring>
#include <iostream>

using namespace copilot;

static std::array<uint8_t, kSpeechHeaderBytes> header(uint8_t version, uint8_t format,
                                                      uint16_t rate, uint32_t frames,
                                                      uint32_t flags = 0) {
  std::array<uint8_t, kSpeechHeaderBytes> bytes{};
  std::memcpy(bytes.data(), "ACSP", 4);
  bytes[4] = version;
  bytes[5] = format;
  bytes[6] = rate & 0xff;
  bytes[7] = rate >> 8;
  for (unsigned i = 0; i < 4; ++i) {
    bytes[8 + i] = (frames >> (i * 8)) & 0xff;
    bytes[12 + i] = (flags >> (i * 8)) & 0xff;
  }
  return bytes;
}

int main() {
  SpeechHeader parsed{};
  auto valid = header(kSpeechWireVersion, kSpeechFormatPcmS16LeMono,
                      kSpeechSampleRate, 1200);
  assert(parseSpeechHeader(valid.data(), valid.size(),
                           valid.size() + 1200 * 2, parsed) == nullptr);
  assert(parsed.frames == 1200);

  auto badMagic = valid;
  badMagic[0] = 'X';
  assert(std::strcmp(parseSpeechHeader(badMagic.data(), badMagic.size(),
                                      badMagic.size() + 2400, parsed),
                     "Invalid speech magic.") == 0);
  assert(parseSpeechHeader(valid.data(), valid.size() - 1,
                           valid.size() + 2400, parsed));
  assert(parseSpeechHeader(header(2, 1, 24000, 1).data(), kSpeechHeaderBytes,
                           kSpeechHeaderBytes + 2, parsed));
  assert(parseSpeechHeader(header(1, 2, 24000, 1).data(), kSpeechHeaderBytes,
                           kSpeechHeaderBytes + 2, parsed));
  assert(parseSpeechHeader(header(1, 1, 16000, 1).data(), kSpeechHeaderBytes,
                           kSpeechHeaderBytes + 2, parsed));
  assert(parseSpeechHeader(header(1, 1, 24000, 0).data(), kSpeechHeaderBytes,
                           kSpeechHeaderBytes, parsed));
  assert(parseSpeechHeader(header(1, 1, 24000, kMaxSpeechFrames + 1).data(),
                           kSpeechHeaderBytes, kMaxSpeechRequestBytes + 2, parsed));
  assert(parseSpeechHeader(header(1, 1, 24000, 1, 1).data(), kSpeechHeaderBytes,
                           kSpeechHeaderBytes + 2, parsed));
  assert(parseSpeechHeader(valid.data(), valid.size(),
                           valid.size() + 2398, parsed));
  std::cout << "PASS: speech wire format, limits, and length validation\n";
}
