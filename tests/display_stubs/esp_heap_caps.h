#pragma once
#include <cstdlib>

constexpr unsigned MALLOC_CAP_SPIRAM = 1;
constexpr unsigned MALLOC_CAP_8BIT = 2;

inline void* heap_caps_aligned_alloc(size_t alignment, size_t bytes, unsigned) {
  void* memory = nullptr;
  return posix_memalign(&memory, alignment, bytes) == 0 ? memory : nullptr;
}
