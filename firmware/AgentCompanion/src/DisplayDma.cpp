#include "DisplayDma.h"
#include "Config.h"
#include <Arduino_GFX_Library.h>
#include <driver/gpio.h>
#include <freertos/FreeRTOS.h>
#include <cstring>

namespace copilot {
DisplayDma::~DisplayDma() {
  if (active_) finish();
  if (device_ && !pending_) {
    const esp_err_t result = spi_bus_remove_device(device_);
    if (result != ESP_OK) log_e("Display DMA cleanup failed: %d", result);
  }
}

bool DisplayDma::begin(int32_t speed) {
  error_ = nullptr;
  spi_device_interface_config_t config{};
  config.command_bits = 8;
  config.address_bits = 24;
  config.mode = 0;
  config.clock_source = SPI_CLK_SRC_DEFAULT;
  config.clock_speed_hz = speed > 0 ? speed : kSpiFrequency;
  config.spics_io_num = -1;
  config.flags = SPI_DEVICE_HALFDUPLEX;
  config.queue_size = 2;
  if (spi_bus_add_device(ESP32QSPI_SPI_HOST, &config, &device_) != ESP_OK) {
    error_ = "Display DMA device initialization failed.";
    return false;
  }
  return true;
}

void DisplayDma::setBuffer(uint8_t* buffer, size_t bytes) {
  buffer_ = buffer;
  bufferBytes_ = bytes / 2;
}

bool DisplayDma::start() {
  error_ = nullptr;
  if (!device_ || !buffer_ || active_ || pending_) {
    error_ = "Display DMA was not initialized or is still active.";
    return false;
  }
  if (spi_device_acquire_bus(device_, portMAX_DELAY) != ESP_OK) {
    error_ = "Display DMA bus acquisition failed.";
    return false;
  }
  active_ = true;
  next_ = pending_ = 0;
  first_ = true;
  if (gpio_set_level(static_cast<gpio_num_t>(kDisplayCsPin), 0) != ESP_OK) {
    error_ = "Display DMA chip selection failed.";
    spi_device_release_bus(device_);
    active_ = false;
    return false;
  }
  return true;
}

bool DisplayDma::wait() {
  const auto* expected = &transactions_[(next_ + 2 - pending_) & 1].base;
  spi_transaction_t* completed = nullptr;
  if (spi_device_get_trans_result(device_, &completed, pdMS_TO_TICKS(1000)) != ESP_OK) {
    error_ = "Display DMA transfer timed out.";
    return false;
  }
  --pending_;
  if (completed != expected) {
    error_ = "Display DMA transfer order was invalid.";
    return false;
  }
  return true;
}

uint8_t* DisplayDma::acquire() {
  if (!active_ || error_) return nullptr;
  if (pending_ == 2 && !wait()) return nullptr;
  return buffer_ + next_ * bufferBytes_;
}

bool DisplayDma::submit(size_t bytes) {
  if (!active_ || error_ || pending_ == 2 || !bytes || bytes > bufferBytes_) {
    if (!error_) error_ = "Invalid display DMA transfer.";
    return false;
  }
  auto& transaction = transactions_[next_];
  std::memset(&transaction, 0, sizeof(transaction));
  transaction.base.flags = SPI_TRANS_MODE_QIO;
  if (first_) {
    transaction.base.cmd = 0x32;
    transaction.base.addr = 0x003C00;
  } else {
    transaction.base.flags |= SPI_TRANS_VARIABLE_CMD | SPI_TRANS_VARIABLE_ADDR
                              | SPI_TRANS_VARIABLE_DUMMY;
  }
  transaction.base.tx_buffer = buffer_ + next_ * bufferBytes_;
  transaction.base.length = bytes * 8;
  if (spi_device_queue_trans(device_, &transaction.base, pdMS_TO_TICKS(1000)) != ESP_OK) {
    error_ = "Display DMA transfer submission failed.";
    return false;
  }
  ++pending_;
  next_ ^= 1;
  first_ = false;
  return true;
}

bool DisplayDma::finish() {
  if (!active_) return error_ == nullptr;
  while (pending_) {
    if (!wait()) return false;
  }
  if (gpio_set_level(static_cast<gpio_num_t>(kDisplayCsPin), 1) != ESP_OK)
    error_ = "Display DMA chip deselection failed.";
  spi_device_release_bus(device_);
  active_ = false;
  return error_ == nullptr;
}
}
