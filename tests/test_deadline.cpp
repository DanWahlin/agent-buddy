#include "../firmware/AgentCompanion/src/Deadline.h"
#include <cassert>
#include <iostream>

int main() {
  using copilot::deadlineAfter;
  using copilot::elapsed;
  static_assert(deadlineAfter(100, 50) == 150);
  // A deadline that wraps onto 0 must not read as "no deadline".
  static_assert(deadlineAfter(UINT32_MAX, 1) == 1);
  static_assert(deadlineAfter(UINT32_MAX - 9, 20) == 10);

  assert(!elapsed(1000, 0));
  assert(!elapsed(149, 150));
  assert(elapsed(150, 150));
  assert(elapsed(151, 150));
  // Comparisons stay correct across the millis() wrap.
  const uint32_t wrapped = deadlineAfter(UINT32_MAX - 9, 20);
  assert(!elapsed(UINT32_MAX - 5, wrapped));
  assert(elapsed(10, wrapped));
  std::cout << "deadline tests passed\n";
}
