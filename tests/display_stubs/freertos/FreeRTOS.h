#pragma once
#include <cstdint>
using TickType_t = uint32_t;
constexpr TickType_t portMAX_DELAY = UINT32_MAX;
inline TickType_t pdMS_TO_TICKS(uint32_t milliseconds) { return milliseconds; }
