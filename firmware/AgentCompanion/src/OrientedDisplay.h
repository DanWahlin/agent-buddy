#pragma once
#include "Config.h"
#include "ScreenOrientation.h"
#include <Arduino_GFX_Library.h>
#include <cstddef>
#include <cstdint>

namespace copilot {
class OrientedDisplay : public Arduino_Canvas {
 public:
  OrientedDisplay(Arduino_CO5300* panel, Arduino_DataBus* bus);
  bool begin(int32_t speed = GFX_NOT_DEFINED) override;
  void flush(bool forceFlush = false) override;
  bool flushFrame(const uint16_t* pixels, int x, int y, int width, int height);
  bool setAngle(float angle);
  float angle() const { return orientation_.angle(); }
  bool setTransferBuffer(uint8_t* buffer, size_t bytes);
  void setBrightness(uint8_t brightness) { panel_->setBrightness(brightness); }
  const char* error() const { return error_; }

 private:
  bool flushSource(const ScreenPixels& source);
  Arduino_CO5300* panel_;
  Arduino_DataBus* bus_;
  uint8_t* transferBuffer_ = nullptr;
  size_t transferBytes_ = 0;
  DisplayOrientation orientation_;
  bool frameMarginsDirty_ = true;
  const char* error_ = nullptr;
};
}
