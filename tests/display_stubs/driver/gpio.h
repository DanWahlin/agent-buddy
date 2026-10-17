#pragma once
#include "spi_master.h"
using gpio_num_t = int;
inline esp_err_t gpio_set_level(gpio_num_t pin, int level) {
  assert(spi_stub::owner != nullptr);
  if (pin == spi_stub::dcPin) {
    // Pixel data needs data/command high before chip select.
    assert(level == 1 && spi_stub::chipSelect == 1);
    spi_stub::dataCommand = level;
    return ESP_OK;
  }
  assert(pin == spi_stub::csPin);
  if (level) assert(spi_stub::owner->pending.empty());
  spi_stub::chipSelect = level;
  return ESP_OK;
}
