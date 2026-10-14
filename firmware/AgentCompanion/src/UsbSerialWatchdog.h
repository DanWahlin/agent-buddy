#pragma once
#include <cstdint>

namespace copilot {
// Watches the USB serial port for data that the host sent but the firmware never read. After a
// host restart, the ESP32-S3 USB serial port can stop taking data: the bytes stay in its receive
// FIFO, no interrupt reads them, and the host blocks. Replugging the cable fixes it; this does
// the same in firmware. First it enables the interrupts again; if that does not help, it asks
// for a restart of the USB serial port.
class UsbSerialWatchdog {
 public:
  enum class Action : uint8_t { None, EnableInterrupts, Restart };

  // Data left in the FIFO this long, with the interrupts on, means nothing reads it.
  static constexpr uint32_t kStuckMs = 2000;

  // `rxPending` is true when the receive FIFO holds data.
  Action poll(bool rxPending, uint32_t nowMs) {
    if (!rxPending) {
      since_ = 0;
      interruptsEnabled_ = false;
      return Action::None;
    }
    if (!since_) {
      since_ = nowMs ? nowMs : 1;
      return Action::None;
    }
    if (nowMs - since_ < kStuckMs) return Action::None;
    since_ = nowMs ? nowMs : 1;
    if (!interruptsEnabled_) {
      interruptsEnabled_ = true;
      ++interruptEnables_;
      return Action::EnableInterrupts;
    }
    interruptsEnabled_ = false;
    ++restarts_;
    return Action::Restart;
  }

  uint32_t interruptEnables() const { return interruptEnables_; }
  uint32_t restarts() const { return restarts_; }

 private:
  uint32_t since_ = 0;
  bool interruptsEnabled_ = false;
  uint32_t interruptEnables_ = 0;
  uint32_t restarts_ = 0;
};
}
