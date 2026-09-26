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
  if (!ready && !tracker.active()) return false;
  int16_t x[2] = {}, y[2] = {};
  const uint8_t count = controller.getPoint(x, y, 2);
  return tracker.sample(count != 0, x[0], y[0], esp_timer_get_time() / 1000, gesture);
#else
  (void)gesture;
  error = "Physical touch input requires the ESP32 device.";
  return false;
#endif
}
}
