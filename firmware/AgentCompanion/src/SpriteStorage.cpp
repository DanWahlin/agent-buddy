#include "SpriteStorage.h"
#include <algorithm>
#include <cstring>
#ifdef ARDUINO_ARCH_ESP32
#include <esp_heap_caps.h>
#include <esp_partition.h>
#include <mbedtls/sha256.h>
#endif

namespace copilot {
namespace {
const char* error = nullptr;
CharacterPack pack;
bool packReady = false;

#ifdef ARDUINO_ARCH_ESP32
constexpr uint32_t kSectorBytes = 4096;
constexpr uint32_t kEraseBytes = 65536;
esp_partition_mmap_handle_t mapping;
bool mapped = false;

struct Installation {
  bool active = false;
  uint8_t* firstSector = nullptr;
  uint32_t received = 0, total = 0, erasedEnd = 0;
  PackHeader header;
  mbedtls_sha256_context hash;
} install;

const esp_partition_t* assetsPartition() {
  return esp_partition_find_first(
      ESP_PARTITION_TYPE_DATA, static_cast<esp_partition_subtype_t>(0x40), "assets");
}

void unmap() {
  packReady = false;
  if (mapped) esp_partition_munmap(mapping);
  mapped = false;
}

// The digest covers the whole pack with its own SHA-256 field zeroed.
void hashRange(mbedtls_sha256_context& context, uint32_t offset, const uint8_t* data, size_t bytes) {
  static const uint8_t zeros[32] = {};
  const uint32_t end = offset + bytes;
  const uint32_t shaEnd = kPackShaOffset + sizeof(zeros);
  if (end <= kPackShaOffset || offset >= shaEnd) {
    mbedtls_sha256_update(&context, data, bytes);
    return;
  }
  const uint32_t before = offset < kPackShaOffset ? kPackShaOffset - offset : 0;
  const uint32_t hidden = std::min(end, shaEnd) - (offset + before);
  mbedtls_sha256_update(&context, data, before);
  mbedtls_sha256_update(&context, zeros, hidden);
  mbedtls_sha256_update(&context, data + before + hidden, bytes - before - hidden);
}

const char* verifyDigest(const uint8_t* bytes, size_t size, const uint8_t* expected) {
  mbedtls_sha256_context context;
  mbedtls_sha256_init(&context);
  uint8_t digest[32];
  const bool hashed = mbedtls_sha256_starts(&context, 0) == 0;
  if (hashed) hashRange(context, 0, bytes, size);
  const bool finished = hashed && mbedtls_sha256_finish(&context, digest) == 0;
  mbedtls_sha256_free(&context);
  return finished && std::memcmp(digest, expected, sizeof(digest)) == 0
      ? nullptr : "Character pack SHA-256 mismatch; reinstall the character.";
}

void finishHash() {
  mbedtls_sha256_free(&install.hash);
}
#endif
}

const char* spriteStorageError() { return error; }
const CharacterPack* characterPack() { return packReady ? &pack : nullptr; }

const uint8_t* spriteBlock(const SpriteBlock& block) {
  if (!packReady || !block.size || block.offset > pack.header.dataBytes
      || block.size > pack.header.dataBytes - block.offset)
    return nullptr;
  return pack.data + block.offset;
}

bool loadCharacterPack(const uint8_t* bytes, size_t size) {
  packReady = false;
  error = bindCharacterPack(bytes, size, size, pack);
  packReady = !error;
  return packReady;
}

bool initializeSpriteStorage() {
#ifdef ARDUINO_ARCH_ESP32
  if (packReady) return true;
  error = nullptr;
  const auto* partition = assetsPartition();
  if (!partition) {
    error = "Assets partition is missing. Perform a complete firmware upload.";
    return false;
  }
  uint8_t header[kPackHeaderBytes];
  PackHeader parsed;
  if (esp_partition_read(partition, 0, header, sizeof(header)) != ESP_OK) {
    error = "Assets partition read failed.";
    return false;
  }
  if ((error = parsePackHeader(header, sizeof(header), partition->size, parsed))) return false;
  const void* data = nullptr;
  if (esp_partition_mmap(partition, 0, parsed.totalBytes, ESP_PARTITION_MMAP_DATA,
                         &data, &mapping) != ESP_OK) {
    error = "Character pack flash mapping failed.";
    return false;
  }
  mapped = true;
  const auto* bytes = static_cast<const uint8_t*>(data);
  error = bindCharacterPack(bytes, parsed.totalBytes, partition->size, pack);
  if (!error) error = verifyDigest(bytes, parsed.totalBytes, pack.header.sha256);
  if (error) {
    unmap();
    return false;
  }
  packReady = true;
  return true;
#else
  if (!packReady && !error) error = "No character pack is loaded.";
  return packReady;
#endif
}

size_t characterPartitionBytes() {
#ifdef ARDUINO_ARCH_ESP32
  const auto* partition = assetsPartition();
  return partition ? partition->size : 0;
#else
  return 0;
#endif
}

#ifdef ARDUINO_ARCH_ESP32
const char* beginCharacterInstall() {
  const auto* partition = assetsPartition();
  if (install.active) return "A character installation is already in progress.";
  if (!partition) return "Assets partition is missing.";
  if (!install.firstSector) {
    install.firstSector = static_cast<uint8_t*>(
        heap_caps_malloc(kSectorBytes, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    if (!install.firstSector) return "Cannot allocate the installation buffer.";
  }
  unmap();
  // Erasing the header first means an interrupted install never looks valid.
  if (esp_partition_erase_range(partition, 0, kEraseBytes) != ESP_OK)
    return "Assets partition erase failed.";
  install.received = install.total = 0;
  install.erasedEnd = kEraseBytes;
  mbedtls_sha256_init(&install.hash);
  if (mbedtls_sha256_starts(&install.hash, 0) != 0) {
    finishHash();
    return "SHA-256 initialization failed.";
  }
  install.active = true;
  return nullptr;
}

const char* writeCharacterInstall(const uint8_t* data, size_t bytes) {
  const auto* partition = assetsPartition();
  if (!install.active || !partition) return "No character installation is in progress.";
  while (bytes) {
    const uint32_t offset = install.received;
    if (install.total && offset >= install.total)
      return "Character pack is longer than its header declares.";
    size_t count = bytes;
    if (offset < kSectorBytes) count = std::min<size_t>(count, kSectorBytes - offset);
    if (install.total) count = std::min<size_t>(count, install.total - offset);
    hashRange(install.hash, offset, data, count);
    if (offset < kSectorBytes) {
      std::memcpy(install.firstSector + offset, data, count);
    } else {
      while (install.erasedEnd < offset + count) {
        const uint32_t size = std::min<uint32_t>(kEraseBytes, partition->size - install.erasedEnd);
        if (!size || esp_partition_erase_range(partition, install.erasedEnd, size) != ESP_OK)
          return "Assets partition erase failed.";
        install.erasedEnd += size;
      }
      if (esp_partition_write(partition, offset, data, count) != ESP_OK)
        return "Assets partition write failed.";
    }
    install.received += count;
    data += count;
    bytes -= count;
    if (!install.total && install.received >= kPackHeaderBytes) {
      if (const char* invalid = parsePackHeader(
              install.firstSector, kPackHeaderBytes, partition->size, install.header))
        return invalid;
      install.total = install.header.totalBytes;
      if (install.received > install.total)
        return "Character pack is longer than its header declares.";
    }
  }
  return nullptr;
}

const char* finishCharacterInstall() {
  const auto* partition = assetsPartition();
  if (!install.active || !partition) return "No character installation is in progress.";
  if (!install.total || install.received != install.total)
    return "Character pack transfer is incomplete.";
  uint8_t digest[32];
  const bool finished = mbedtls_sha256_finish(&install.hash, digest) == 0;
  finishHash();
  install.active = false;
  if (!finished || std::memcmp(digest, install.header.sha256, sizeof(digest)) != 0) {
    esp_partition_erase_range(partition, 0, kSectorBytes);
    return "Character pack SHA-256 mismatch.";
  }
  if (esp_partition_write(partition, 0, install.firstSector,
                          std::min(kSectorBytes, install.total)) != ESP_OK) {
    esp_partition_erase_range(partition, 0, kSectorBytes);
    return "Assets partition header write failed.";
  }
  // Re-read from flash so the installed bytes, not the received stream, are verified.
  if (!initializeSpriteStorage()) {
    esp_partition_erase_range(partition, 0, kSectorBytes);
    return error;
  }
  return nullptr;
}

void abortCharacterInstall() {
  const auto* partition = assetsPartition();
  if (install.active) finishHash();
  install.active = false;
  unmap();
  if (partition) esp_partition_erase_range(partition, 0, kSectorBytes);
}

uint32_t characterInstallReceived() { return install.received; }
uint32_t characterInstallTotal() { return install.total; }
const char* characterInstallName() { return install.total ? install.header.name : nullptr; }
#else
const char* beginCharacterInstall() { return "Character installation requires the device."; }
const char* writeCharacterInstall(const uint8_t*, size_t) {
  return "Character installation requires the device.";
}
const char* finishCharacterInstall() { return "Character installation requires the device."; }
void abortCharacterInstall() {}
uint32_t characterInstallReceived() { return 0; }
uint32_t characterInstallTotal() { return 0; }
const char* characterInstallName() { return nullptr; }
#endif
}
