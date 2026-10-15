#include "../firmware/AgentCompanion/src/boards/waveshare_amoled_175/BoardVariant.h"
#include <cassert>
#include <cstdint>
#include <cstring>
#include <initializer_list>
#include <iostream>
#include <vector>

namespace {
using copilot::board::Variant;

// Runs detectVariant() with these Wire.endTransmission() results; returns the variant and the count of probes.
std::pair<Variant, size_t> detect(std::initializer_list<uint8_t> results) {
  std::vector<uint8_t> queue(results);
  size_t probes = 0;
  const Variant variant = copilot::board::detectVariant([&] {
    assert(probes < queue.size());
    return queue[probes++];
  });
  return {variant, probes};
}
}  // namespace

int main() {
  using copilot::board::audioMclkPin;
  using copilot::board::variantName;
  static_assert(audioMclkPin(Variant::Standard) == 42);
  static_assert(audioMclkPin(Variant::C) == 16);
  assert(std::strcmp(variantName(Variant::Standard), "standard") == 0);
  assert(std::strcmp(variantName(Variant::C), "c") == 0);

  constexpr uint8_t acknowledged = 0, notAcknowledged = 2, other = 4, timeout = 5;
  // The expander answers: the 1.75, -B, or -G.
  assert(detect({acknowledged}) == std::make_pair(Variant::Standard, size_t{1}));
  // Nothing at the expander address: the 1.75-C.
  assert(detect({notAcknowledged}) == std::make_pair(Variant::C, size_t{1}));
  // Bus errors are tried again, and a clear answer after them decides.
  assert(detect({timeout, notAcknowledged}) == std::make_pair(Variant::C, size_t{2}));
  assert(detect({other, timeout, acknowledged}) == std::make_pair(Variant::Standard, size_t{3}));
  // Errors on every try keep Standard, which never drives the others' expansion header pin.
  assert(detect({timeout, other, timeout}) == std::make_pair(Variant::Standard, size_t{3}));
  std::cout << "board variant tests passed\n";
}
