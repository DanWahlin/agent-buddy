#include "../firmware/AgentCompanion/src/UsbSerialWatchdog.h"
#include <cassert>
#include <cstdint>
#include <iostream>

int main() {
  using copilot::UsbSerialWatchdog;
  using Action = UsbSerialWatchdog::Action;
  constexpr uint32_t stuck = UsbSerialWatchdog::kStuckMs;

  // Data that the firmware reads soon is normal.
  UsbSerialWatchdog normal;
  assert(normal.poll(true, 1000) == Action::None);
  assert(normal.poll(true, 1000 + stuck - 1) == Action::None);
  assert(normal.poll(false, 1000 + stuck) == Action::None);
  assert(normal.poll(true, 1000 + stuck + 1) == Action::None);
  assert(normal.interruptEnables() == 0 && normal.restarts() == 0);

  // Stuck data: enable the interrupts first, then restart, then start again from the interrupts.
  UsbSerialWatchdog watchdog;
  assert(watchdog.poll(true, 100) == Action::None);
  assert(watchdog.poll(true, 100 + stuck) == Action::EnableInterrupts);
  assert(watchdog.poll(true, 100 + stuck + 1) == Action::None);
  assert(watchdog.poll(true, 100 + 2 * stuck) == Action::Restart);
  assert(watchdog.poll(true, 100 + 3 * stuck) == Action::EnableInterrupts);
  assert(watchdog.interruptEnables() == 2 && watchdog.restarts() == 1);

  // Enabling the interrupts fixed it: the next stuck time starts with the interrupts again.
  assert(watchdog.poll(false, 100 + 3 * stuck + 1) == Action::None);
  assert(watchdog.poll(true, 100 + 4 * stuck) == Action::None);
  assert(watchdog.poll(true, 100 + 5 * stuck) == Action::EnableInterrupts);

  // Correct across the millis() wrap, and a start time of 0 still counts.
  UsbSerialWatchdog wrapped;
  assert(wrapped.poll(true, UINT32_MAX - 10) == Action::None);
  assert(wrapped.poll(true, stuck - 20) == Action::None);
  assert(wrapped.poll(true, stuck - 11) == Action::EnableInterrupts);
  UsbSerialWatchdog zero;
  assert(zero.poll(true, 0) == Action::None);
  assert(zero.poll(true, stuck + 1) == Action::EnableInterrupts);

  std::cout << "USB serial watchdog tests passed\n";
}
