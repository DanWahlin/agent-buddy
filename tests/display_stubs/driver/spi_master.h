#pragma once
#include <Arduino_GFX_Library.h>
#include <freertos/FreeRTOS.h>
#include <cassert>
#include <deque>

using esp_err_t = int;
constexpr esp_err_t ESP_OK = 0, ESP_FAIL = -1;
constexpr int SPI2_HOST = 2, SPI_CLK_SRC_DEFAULT = 1;
constexpr unsigned SPI_DEVICE_HALFDUPLEX = 1;
constexpr unsigned SPI_TRANS_MODE_QIO = 2;
constexpr unsigned SPI_TRANS_VARIABLE_CMD = 4;
constexpr unsigned SPI_TRANS_VARIABLE_ADDR = 8;
constexpr unsigned SPI_TRANS_VARIABLE_DUMMY = 16;

struct spi_device_interface_config_t {
  int command_bits, address_bits, mode, clock_source, clock_speed_hz, spics_io_num;
  unsigned flags;
  int queue_size;
};
struct spi_transaction_t {
  unsigned flags;
  uint16_t cmd;
  uint64_t addr;
  size_t length;
  const void* tx_buffer;
};
struct spi_transaction_ext_t {
  spi_transaction_t base;
  uint8_t command_bits, address_bits, dummy_bits;
};
struct SpiDevice {
  std::deque<spi_transaction_t*> pending;
  Arduino_DataBus* sink;
  unsigned submissions = 0;
};
using spi_device_handle_t = SpiDevice*;

namespace spi_stub {
inline Arduino_DataBus* sink = nullptr;
inline spi_device_handle_t owner = nullptr;
inline unsigned maxPending = 0;
inline int failSubmission = -1;
inline int chipSelect = 1;
}

inline esp_err_t spi_bus_add_device(int host, const spi_device_interface_config_t* config,
                                   spi_device_handle_t* device) {
  assert(host == SPI2_HOST && config->queue_size == 2 && config->spics_io_num == -1);
  assert(config->command_bits == 8 && config->address_bits == 24);
  assert(config->clock_source == SPI_CLK_SRC_DEFAULT);
  *device = new SpiDevice{{}, spi_stub::sink};
  return ESP_OK;
}
inline esp_err_t spi_bus_remove_device(spi_device_handle_t device) {
  assert(device->pending.empty() && spi_stub::owner != device);
  delete device;
  return ESP_OK;
}
inline esp_err_t spi_device_acquire_bus(spi_device_handle_t device, TickType_t timeout) {
  assert(timeout == portMAX_DELAY && spi_stub::owner == nullptr);
  spi_stub::owner = device;
  device->submissions = 0;
  return ESP_OK;
}
inline void spi_device_release_bus(spi_device_handle_t device) {
  assert(spi_stub::owner == device && device->pending.empty() && spi_stub::chipSelect == 1);
  spi_stub::owner = nullptr;
}
inline esp_err_t spi_device_queue_trans(spi_device_handle_t device, spi_transaction_t* transaction,
                                      TickType_t) {
  assert(spi_stub::owner == device && spi_stub::chipSelect == 0);
  assert(device->pending.size() < 2 && transaction->length % 32 == 0);
  if (spi_stub::failSubmission == static_cast<int>(device->submissions++)) {
    spi_stub::failSubmission = -1;
    return ESP_FAIL;
  }
  if (transaction->flags & SPI_TRANS_VARIABLE_CMD) {
    const auto* extended = reinterpret_cast<const spi_transaction_ext_t*>(transaction);
    assert(extended->command_bits == 0 && extended->address_bits == 0 && extended->dummy_bits == 0);
  } else {
    assert(device->pending.empty() && transaction->cmd == 0x32 && transaction->addr == 0x003C00);
  }
  device->pending.push_back(transaction);
  spi_stub::maxPending = std::max(spi_stub::maxPending, static_cast<unsigned>(device->pending.size()));
  return ESP_OK;
}
inline esp_err_t spi_device_get_trans_result(spi_device_handle_t device,
                                           spi_transaction_t** completed, TickType_t) {
  assert(spi_stub::owner == device && !device->pending.empty());
  *completed = device->pending.front();
  device->pending.pop_front();
  const auto* bytes = static_cast<const uint8_t*>((*completed)->tx_buffer);
  const auto* first = device->sink->dmaBuffer;
  assert(bytes == first || bytes == first + device->sink->dmaBytes / 2);
  const size_t count = (*completed)->length / 8;
  assert(count <= device->sink->dmaBytes / 2);
  device->sink->bytes.insert(device->sink->bytes.end(), bytes, bytes + count);
  return ESP_OK;
}
