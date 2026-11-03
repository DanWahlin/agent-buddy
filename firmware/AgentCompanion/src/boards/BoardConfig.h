#pragma once
// Selects the board for this build. Each board lives in src/boards/<directory>/ and has:
//   BoardConfig.h   pins, panel size, chip addresses, and names (no vendor libraries)
//   BoardDrivers.h  driver types and the display bus and panel objects (device only)
// tools/arduino.sh passes the board's define from firmware/boards.json. Without a define,
// the build uses the first board, so the Arduino IDE and the native tests still work.
// tests/test_boards.py keeps this list, BoardDrivers.h, and firmware/boards.json in step.
#if defined(AGENT_BOARD_WAVESHARE_AMOLED_175)
#include "waveshare_amoled_175/BoardConfig.h"
#elif defined(AGENT_BOARD_WAVESHARE_LCD_154)
#include "waveshare_lcd_154/BoardConfig.h"
#elif defined(AGENT_BOARD_WAVESHARE_AMOLED_206)
#include "waveshare_amoled_206/BoardConfig.h"
#else  // The default board in firmware/boards.json.
#include "waveshare_amoled_175/BoardConfig.h"
#endif
