#include "TouchInput.h"
#ifdef ARDUINO_ARCH_ESP32
#include <Arduino.h>
#include <Wire.h>
#include <TouchDrvCSTXXX.hpp>
#include <esp_timer.h>
#endif

namespace copilot {
namespace {
const char* error = nullptr;
#ifdef ARDUINO_ARCH_ESP32
TouchDrvCST92xx controller;
TouchGestureTracker tracker;
portMUX_TYPE touchLock = portMUX_INITIALIZER_UNLOCKED;
volatile bool pending = false;
bool initialized = false;
// Reading the controller is what releases its interrupt line, and that read only
// happens when an edge has set `pending`. If an edge is missed, or arrives while
// the flag is already set, the line can stay asserted with no further edge to
// wake us and touch would stop for good with no error reported. Sweeping the
// controller occasionally clears any latched state and also recovers the missed
// touch itself.
uint32_t lastTouchReadMs = 0;

void IRAM_ATTR interrupt() {
  portENTER_CRITICAL_ISR(&touchLock);
  pending = true;
  portEXIT_CRITICAL_ISR(&touchLock);
}
#endif
}

const char* touchInputError() { return error; }

bool initializeTouchInput() {
  error = nullptr;
#ifdef ARDUINO_ARCH_ESP32
  if (initialized) return true;
  controller.setPins(kTouchReset, kTouchInterrupt);
  if (!controller.begin(Wire, CST92XX_SLAVE_ADDRESS, kTouchSda, kTouchScl)) {
    error = "CST9217 touch controller initialization failed.";
    return false;
  }
  if (controller.getSupportTouchPoint() != 2) {
    error = "Unexpected touch controller point capacity.";
    return false;
  }
  controller.setMaxCoordinates(kDisplaySize - 1, kDisplaySize - 1);
  controller.setMirrorXY(true, true);
  Wire.setTimeOut(8);
  pinMode(kTouchInterrupt, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(kTouchInterrupt), interrupt, FALLING);
  initialized = true;
  return true;
#else
  error = "Physical touch input requires the ESP32 device.";
  return false;
#endif
}

bool pollTouchGesture(TouchGesture& gesture) {
#ifdef ARDUINO_ARCH_ESP32
  if (!initialized) {
    error = "Touch input was not initialized.";
    return false;
  }
  portENTER_CRITICAL(&touchLock);
  const bool ready = pending;
  pending = false;
  portEXIT_CRITICAL(&touchLock);
  const uint32_t now = esp_timer_get_time() / 1000;
  const bool sweep = now - lastTouchReadMs >= kTouchSweepMs;
  if (!ready && !tracker.active() && !sweep) return false;
  lastTouchReadMs = now;
  int16_t x[2] = {}, y[2] = {};
  const uint8_t count = controller.getPoint(x, y, 2);
  // An idle sweep that finds nothing must not reach the tracker, or the sweep
  // itself could be read as the end of a gesture that never began.
  if (!ready && !tracker.active() && !count) return false;
  return tracker.sample(count != 0, x[0], y[0], now, gesture);
#else
  (void)gesture;
  error = "Physical touch input requires the ESP32 device.";
  return false;
#endif
}
}
