#pragma once
#include "spi_master.h"
using gpio_num_t = int;
inline esp_err_t gpio_set_level(gpio_num_t pin, int level) {
  assert(pin == 12 && spi_stub::owner != nullptr);
  if (level) assert(spi_stub::owner->pending.empty());
  spi_stub::chipSelect = level;
  return ESP_OK;
}
