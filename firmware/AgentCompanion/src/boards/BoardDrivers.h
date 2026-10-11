#pragma once
// Device-only drivers for the selected board. See BoardConfig.h.
#include "BoardConfig.h"
#if defined(AGENT_BOARD_WAVESHARE_AMOLED_175)
#include "waveshare_amoled_175/BoardDrivers.h"
#else  // The default board in firmware/boards.json.
#include "waveshare_amoled_175/BoardDrivers.h"
#endif
