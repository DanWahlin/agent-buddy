#include <Arduino.h>
#include <Arduino_GFX_Library.h>
#include <Preferences.h>
#include <esp_heap_caps.h>
#include <esp_timer.h>
#include <esp_system.h>
#include <miniz.h>
#include <algorithm>
#include <cstring>
#include <cstdarg>
#include <atomic>
#include <mbedtls/base64.h>
#include <hal/usb_serial_jtag_ll.h>
#include <soc/usb_serial_jtag_struct.h>
#include "src/SpriteRenderer.h"
#include "src/FullFrameRenderer.h"
#include "src/NetworkManager.h"
#include "src/SpritePredictor.h"
#include "src/SpriteStorage.h"
#include "src/CharacterMotion.h"
#include "src/AudioPlayer.h"
#include "src/AgentBadges.h"
#include "src/CharacterEffects.h"
#include "src/CharacterFrame.h"
#include "src/Deadline.h"
#include "src/DeviceCommands.h"
#include "src/TouchInput.h"
#include "src/ButtonInput.h"
#include "src/SettingsMenu.h"
#include "src/Motion.h"
#include "src/OrientedDisplay.h"
#include "src/OrientationSensor.h"
#include "src/OrientationSettings.h"
#include "src/UsbSerialWatchdog.h"
#include "src/boards/BoardDrivers.h"

using namespace copilot;

namespace {
OrientedDisplay display(&board::displayPanel(), &board::displayBus());
QueueHandle_t freeFrames, readyFrames, commands;
TaskHandle_t renderTask;
SpriteRenderer* patchRenderer = nullptr;
FullFrameRenderer* fullFrameRenderer = nullptr;
CharacterEffects* effects;
AgentBadges agentBadges;
tinfl_decompressor inflater;
alignas(4) uint8_t inflateHistory[TINFL_LZ_DICT_SIZE];
SpritePredictor spritePredictor;
uint32_t inflateTimeUs = 0, predictTimeUs = 0;
constexpr size_t kTransferBytes = 16 * 1024;
static_assert(kCharacterUploadChunkBytes <= kTransferBytes,
              "Character upload chunks are staged in the display transfer buffer.");
uint8_t* transferBuffer;
std::atomic<uint32_t> droppedLogs{0};
// The render task reads the memory-mapped pack; installation pauses it before erasing flash.
portMUX_TYPE renderLock = portMUX_INITIALIZER_UNLOCKED;
bool renderPaused = false;
bool renderActive = false;
bool characterReady = false;
bool installStarted = false;
// Set once the renderer has stopped; until then the mapped pack and the display belong to it.
bool installOwnsFlash = false;
uint32_t restartAt = 0;
uint32_t worstPresentationGap = 0;
// How many blink buffers fit in internal RAM, and how much was free before they were allocated.
unsigned patchBuffersInternal = 0;
size_t startupFreeInternal = 0;
bool captureInterrupted = false;
SettingsMenu settings(kBrightness);
NetworkManager network;
OrientationSensor orientationSensor;
ButtonPressTracker bootButton;
uint32_t buttonPresses = 0;
int16_t orientationOffsetTenths = 0;
bool orientationDirty = false;
constexpr char kPreferencesNamespace[] = "agent-companion";
constexpr char kSoundPreference[] = "sound";
constexpr char kSoundVolumePreference[] = "volume";
constexpr char kOrientationPreference[] = "orient-offset";

void logMessage(const char* format, ...) {
  char message[384];
  va_list arguments;
  va_start(arguments, format);
  const int length = vsnprintf(message, sizeof(message), format, arguments);
  va_end(arguments);
  if (length < 0 || static_cast<size_t>(length) >= sizeof(message) || !Serial
      || Serial.availableForWrite() < length) {
    ++droppedLogs;
    return;
  }
  if (Serial.write(reinterpret_cast<const uint8_t*>(message), length) != static_cast<size_t>(length)) ++droppedLogs;
}

bool updateOrientation() {
  bool changed = orientationDirty;
  orientationDirty = false;
  if (orientationSensor.update()) changed = display.setAngle(orientationSensor.angle()) || changed;
  if (!changed) return false;
  setTouchRotation(display.angle());
  return true;
}

struct Frame {
  uint16_t* pixels = nullptr;
  uint32_t renderUs = 0, motionUs = 0, decodeUs = 0, compositeUs = 0, eyesUs = 0, effectsUs = 0,
      inflateUs = 0, predictUs = 0;
  CharacterState state;
};
Frame frames[2];

[[noreturn]] void fatal(const char* message) {
  for (;;) {
    logMessage("FATAL: %s\n", message);
    delay(2000);
  }
}

void flushDisplay() {
  display.flush();
  if (display.error()) fatal(display.error());
}

void* allocate(size_t bytes, uint32_t capabilities, const char* error) {
  void* result = heap_caps_malloc(bytes, capabilities | MALLOC_CAP_8BIT);
  if (!result) fatal(error);
  return result;
}

bool inflatePose(uint8_t* output, size_t outputSize, const uint8_t* input, size_t inputSize, size_t width, size_t stride) {
  if (!spritePredictor.reset(output, outputSize, width, stride)) return false;
  tinfl_init(&inflater);
  size_t consumed = 0;
  for (;;) {
    size_t inBytes = inputSize - consumed, outBytes = sizeof(inflateHistory);
    const int64_t started = esp_timer_get_time();
    // Keep filtered history intact: inverse prediction writes only to the destination.
    const auto status = tinfl_decompress(&inflater, input + consumed, &inBytes,
        inflateHistory, inflateHistory, &outBytes, TINFL_FLAG_PARSE_ZLIB_HEADER);
    const int64_t inflated = esp_timer_get_time();
    inflateTimeUs += inflated - started;
    consumed += inBytes;
    if (status < TINFL_STATUS_DONE || !spritePredictor.consume(inflateHistory, outBytes)) return false;
    predictTimeUs += esp_timer_get_time() - inflated;
    if (status == TINFL_STATUS_DONE) return consumed == inputSize && spritePredictor.complete();
    if (status != TINFL_STATUS_HAS_MORE_OUTPUT || outBytes != sizeof(inflateHistory)) return false;
  }
}

void animate(void*) {
  CharacterMotion motion(esp_random());
  if (motion.error()) fatal(motion.error());
  CharacterSprite sprite(patchRenderer, fullFrameRenderer);
  const bool fullFrame = sprite.fullFrame();
  // A copy: an install unmaps the pack while this task may still step.
  const PackHeader pack = characterPack()->header;
  int64_t previous = esp_timer_get_time();
  for (;;) {
    Frame* frame;
    xQueueReceive(freeFrames, &frame, portMAX_DELAY);
    const int64_t start = esp_timer_get_time();
    ModeRequest command;
    while (xQueueReceive(commands, &command, 0) == pdTRUE) {
      if (!applyModeRequest(motion, command)) fatal(motion.error());
    }
    stepCharacterMotion(motion, (start - previous) / 1000000.0, pack);
    frame->motionUs = esp_timer_get_time() - start;
    previous = start;
    frame->state = motion.state();
    const int64_t restoreStart = esp_timer_get_time();
    if (!effects->restore(frame->pixels)) fatal(effects->error());
    const uint32_t restoreUs = esp_timer_get_time() - restoreStart;
    inflateTimeUs = predictTimeUs = 0;
    portENTER_CRITICAL(&renderLock);
    const bool paused = renderPaused;
    renderActive = !paused;
    portEXIT_CRITICAL(&renderLock);
    // Installation erases the mapped pack and always restarts the device afterwards.
    if (paused) vTaskSuspend(nullptr);
    const bool rendered = sprite.render(frame->state, frame->pixels);
    portENTER_CRITICAL(&renderLock);
    renderActive = false;
    portEXIT_CRITICAL(&renderLock);
    if (!rendered) fatal(sprite.error());
    const int64_t effectStart = esp_timer_get_time();
    if (!effects->render(frame->state, frame->pixels)) fatal(effects->error());
    frame->effectsUs = restoreUs + esp_timer_get_time() - effectStart;
    frame->renderUs = esp_timer_get_time() - start;
    frame->decodeUs = fullFrame ? 0 : patchRenderer->decodeUs;
    frame->compositeUs = fullFrame ? 0 : patchRenderer->compositeUs;
    frame->eyesUs = fullFrame ? 0 : patchRenderer->eyesUs;
    frame->inflateUs = inflateTimeUs;
    frame->predictUs = predictTimeUs;
    xQueueSend(readyFrames, &frame, portMAX_DELAY);
  }
}

void waitUntil(int64_t deadline) {
  int64_t remaining = deadline - esp_timer_get_time();
  if (remaining <= 0) return;
  const TickType_t ticks = pdMS_TO_TICKS(remaining / 1000);
  if (ticks > 1) vTaskDelay(ticks - 1);
  remaining = deadline - esp_timer_get_time();
  if (remaining > 0) delayMicroseconds(static_cast<uint32_t>(remaining));
}

bool writeCapture(const uint8_t* data, size_t bytes) {
  size_t sent = 0;
  int64_t progress = esp_timer_get_time();
  while (sent < bytes) {
    const int available = Serial.availableForWrite();
    const size_t count = available > 0
        ? Serial.write(data + sent, std::min<size_t>(available, bytes - sent)) : 0;
    sent += count;
    if (count) progress = esp_timer_get_time();
    else if (esp_timer_get_time() - progress > 5000000) {
      logMessage("\nCAPTURE_ERROR USB write timed out\n");
      return false;
    }
    if (!count) delay(1);
  }
  return true;
}

bool captureFrame(const Frame& frame) {
  captureInterrupted = true;
  constexpr size_t bytes = kCharacterFrameWidth * kCharacterFrameHeight * 2;
  char header[256];
  const int length = snprintf(header, sizeof(header),
      "CAPTURE_POSE direction=%u frame=%u blink=%u\n"
      "CAPTURE_STATE mode=%u requested=%u seconds=%.9g event=%u\n"
      "CAPTURE_CHARACTER %s\n"
      "FRAME_BE %d %d %u\n",
      static_cast<unsigned>(frame.state.pose.direction), static_cast<unsigned>(frame.state.pose.index),
      static_cast<unsigned>(frame.state.pose.blinkLevel), static_cast<unsigned>(frame.state.mode),
      static_cast<unsigned>(frame.state.requestedMode), frame.state.effectSeconds, frame.state.eventId,
      characterPack() ? characterPack()->header.id : "none",
      kCharacterFrameWidth, kCharacterFrameHeight, static_cast<unsigned>(bytes));
  if (length < 0 || static_cast<size_t>(length) >= sizeof(header)) {
    logMessage("CAPTURE_ERROR header formatting failed\n");
    return false;
  }
  const char end[] = "\nEND_FRAME\n";
  return writeCapture(reinterpret_cast<const uint8_t*>(header), length)
      && writeCapture(reinterpret_cast<const uint8_t*>(frame.pixels), bytes)
      && writeCapture(reinterpret_cast<const uint8_t*>(end), sizeof(end) - 1);
}

const char* modeName(CharacterMode mode) {
  switch (mode) {
    case CharacterMode::Idle: return "idle";
    case CharacterMode::Surprise: return "surprise";
    case CharacterMode::Working: return "working";
    case CharacterMode::Complete: return "complete";
    case CharacterMode::Attention: return "attention";
    case CharacterMode::Sleep: return "sleep";
  }
  return "invalid";
}

// The character mode a mode command requests; false for any other command.
bool requestedMode(DeviceCommand command, CharacterMode& mode) {
  switch (command) {
    case DeviceCommand::Idle: mode = CharacterMode::Idle; return true;
    case DeviceCommand::Surprise: mode = CharacterMode::Surprise; return true;
    case DeviceCommand::Working: mode = CharacterMode::Working; return true;
    case DeviceCommand::Complete: mode = CharacterMode::Complete; return true;
    case DeviceCommand::Attention: mode = CharacterMode::Attention; return true;
    default: return false;
  }
}

// The mode command a settings button sends, or DeviceCommand::None.
DeviceCommand settingsModeCommand(SettingsAction action) {
  switch (action) {
    case SettingsAction::Idle: return DeviceCommand::Idle;
    case SettingsAction::Surprise: return DeviceCommand::Surprise;
    case SettingsAction::Working: return DeviceCommand::Working;
    case SettingsAction::Complete: return DeviceCommand::Complete;
    case SettingsAction::Attention: return DeviceCommand::Attention;
    default: return DeviceCommand::None;
  }
}

bool sendModeRequest(CharacterMode mode) {
  const ModeRequest request{mode};
  if (xQueueSend(commands, &request, 0) == pdTRUE) return true;
  logMessage("COMMAND_ERROR mode queue full\n");
  return false;
}

void queueMode(DeviceCommand command) {
  if (!characterReady) {
    // The shell acknowledges states so the daemon stays connected until a pack is installed.
    logMessage("COMMAND accepted=%s\n", commandName(command));
    return;
  }
  CharacterMode mode;
  if (!requestedMode(command, mode)) {
    logMessage("COMMAND_ERROR unknown mode\n");
    return;
  }
  if (sendModeRequest(mode)) logMessage("COMMAND accepted=%s\n", commandName(command));
}

void queueTouchSurprise() {
  if (characterReady && sendModeRequest(CharacterMode::Surprise))
    logMessage("COMMAND accepted=surprise source=touch\n");
}

// Opens the settings namespace. On failure it logs failureLog and returns false.
bool openPreferences(Preferences& preferences, const char* failureLog) {
  if (preferences.begin(kPreferencesNamespace, false)) return true;
  logMessage("%s", failureLog);
  return false;
}

uint8_t loadSoundVolume() {
  Preferences preferences;
  if (!openPreferences(preferences, "SETTINGS_ERROR sound preference open failed\n"))
    return kDefaultSoundVolume;
  uint8_t stored;
  if (preferences.isKey(kSoundVolumePreference)) {
    stored = preferences.getUChar(kSoundVolumePreference, kDefaultSoundVolume);
  } else {
    const uint8_t legacy = preferences.getUChar(kSoundPreference, 1);
    stored = legacy == 0 ? 0 : legacy == 2 ? 100 : kDefaultSoundVolume;
    if (preferences.putUChar(kSoundVolumePreference, stored) != 1)
      logMessage("SETTINGS_ERROR sound preference migration failed\n");
  }
  preferences.end();
  if (stored > 100) {
    logMessage("SETTINGS_ERROR invalid sound volume=%u\n", static_cast<unsigned>(stored));
    return kDefaultSoundVolume;
  }
  return stored;
}

void saveSoundVolume(uint8_t volume) {
  Preferences preferences;
  if (!openPreferences(preferences, "SETTINGS_ERROR sound preference open failed\n")) return;
  if (preferences.putUChar(kSoundVolumePreference, volume) != 1)
    logMessage("SETTINGS_ERROR sound preference write failed\n");
  preferences.end();
}

int16_t loadOrientationOffset() {
  Preferences preferences;
  if (!openPreferences(preferences, "ORIENTATION_ERROR preference open failed; using zero trim\n"))
    return 0;
  if (preferences.isKey(kOrientationPreference)
      && preferences.getType(kOrientationPreference) != PT_I16) {
    preferences.end();
    logMessage("ORIENTATION_ERROR invalid preference type; using zero trim\n");
    return 0;
  }
  const int16_t tenths = preferences.getShort(kOrientationPreference, 0);
  preferences.end();
  if (!validOrientationOffset(tenths)) {
    logMessage("ORIENTATION_ERROR invalid stored trim=%d; using zero trim\n", tenths);
    return 0;
  }
  return tenths;
}

int16_t currentOrientationOffset() { return orientationOffsetTenths; }

const char* configureOrientation(int16_t tenths) {
  if (!validOrientationOffset(tenths)) return "Invalid orientation offset.";
  if (installStarted || restartAt || network.firmwareRestarting()
      || network.firmwareApproval() != NetworkManager::FirmwareApproval::None)
    return "Wait for the current installation or firmware request to finish.";
  if (tenths == orientationOffsetTenths) return nullptr;
  Preferences preferences;
  if (!openPreferences(preferences, "ORIENTATION_ERROR preference open failed\n"))
    return "Could not open orientation preferences.";
  const bool saved = preferences.putShort(kOrientationPreference, tenths) == sizeof(tenths);
  preferences.end();
  if (!saved) {
    logMessage("ORIENTATION_ERROR preference write failed\n");
    return "Could not save orientation preferences.";
  }
  orientationOffsetTenths = tenths;
  orientationDirty = display.setTrim(tenths * kOrientationPi / 1800.0f) || orientationDirty;
  return nullptr;
}

const NetworkManager::OrientationControl kOrientationControl{
    currentOrientationOffset, configureOrientation};

void queueModeCue(CharacterMode mode) {
  switch (mode) {
    case CharacterMode::Working: queueAudioCue(AudioCue::Working); break;
    case CharacterMode::Attention: queueAudioCue(AudioCue::Attention); break;
    case CharacterMode::Complete: queueAudioCue(AudioCue::Complete); break;
    case CharacterMode::Surprise: queueAudioCue(AudioCue::Surprise); break;
    case CharacterMode::Idle:
    case CharacterMode::Sleep: break;
  }
}

// Native RGB565 UI colors. CharacterEffects colors are byte-swapped; do not mix them.
namespace ui_color {
constexpr uint16_t kText = 0xE73F;
constexpr uint16_t kMuted = 0x8C71;
constexpr uint16_t kAccent = 0x867F;
constexpr uint16_t kSuccess = 0x47E9;
constexpr uint16_t kWarning = 0xFD20;
constexpr uint16_t kError = 0xF249;
constexpr uint16_t kBackground = 0x0842;
constexpr uint16_t kPanel = 0x10A5;
constexpr uint16_t kPanelBorder = 0x31CC;
constexpr uint16_t kButton = 0x18E7;
constexpr uint16_t kButtonActive = 0x2372;
constexpr uint16_t kButtonBorder = 0x5D19;
}

int textWidth(const char* text, uint8_t size) {
  return static_cast<int>(std::strlen(text)) * 6 * size;
}

void drawText(const char* text, int x, int y, uint8_t size, uint16_t color) {
  display.setTextColor(color);
  display.setTextSize(size);
  display.setCursor(x, y);
  display.print(text);
}

void drawCenteredText(const char* text, int y, uint8_t size, uint16_t color) {
  drawText(text, (kDisplaySize - textWidth(text, size)) / 2, y, size, color);
}

void drawSettingsButton(const SettingsRect& rect, const char* label, bool selected,
                        uint8_t textSize = 2) {
  using namespace ui_color;
  display.fillRoundRect(rect.x, rect.y, rect.width, rect.height, 10,
                        selected ? kButtonActive : kButton);
  display.drawRoundRect(rect.x, rect.y, rect.width, rect.height, 10,
                        selected ? kAccent : kButtonBorder);
  drawText(label, rect.x + std::max(10, (rect.width - textWidth(label, textSize)) / 2),
           rect.y + (rect.height - 8 * textSize) / 2, textSize, kText);
}

// A centered title above a "-" value "+" row. The value box fills the gap between the buttons.
void drawStepper(const char* title, const SettingsRect& down, const SettingsRect& up,
                 const char* value, int valueX) {
  drawCenteredText(title, down.y - 20, 2, ui_color::kText);
  drawSettingsButton(down, "-", false, 3);
  drawSettingsButton(up, "+", false, 3);
  const int boxX = down.x + down.width + 6;
  display.fillRoundRect(boxX, down.y, up.x - 6 - boxX, down.height, 10, ui_color::kBackground);
  drawText(value, valueX, down.y + 11, 2, ui_color::kText);
}

struct WifiStatus {
  const char* label;
  const char* headline;
  uint16_t color;
};

WifiStatus wifiStatus() {
  using namespace ui_color;
  if (network.connected()) return {"Connected", "Wi-Fi connected", kSuccess};
  if (network.setupActive()) return {"Setup active", "Wi-Fi setup active", kWarning};
  if (network.configured()) return {"Disconnected", "Wi-Fi disconnected", kError};
  return {"Not configured", "Wi-Fi not set up", kMuted};
}

// Copies value, or its first maxCharacters - 3 characters followed by "...".
void fitText(char* output, size_t capacity, const char* value, size_t maxCharacters) {
  if (std::strlen(value) <= maxCharacters) snprintf(output, capacity, "%s", value);
  else snprintf(output, capacity, "%.*s...", static_cast<int>(maxCharacters - 3), value);
}

void drawWifiStatusButton() {
  using namespace ui_color;
  const WifiStatus status = wifiStatus();
  constexpr SettingsRect area = settings_layout::kWifiStatus;
  // Two size-2 lines fit within the round display's visible width at the top.
  display.fillRoundRect(area.x, area.y, area.width, area.height, 14, kButton);
  display.drawRoundRect(area.x, area.y, area.width, area.height, 14, status.color);
  char ssid[24];
  const char* detail = "Tap to set up";
  if (network.configured()) {
    fitText(ssid, sizeof(ssid), network.ssid(), 18);
    detail = ssid;
  }
  drawCenteredText(status.headline, area.y + 8, 2, status.color);
  drawCenteredText(detail, area.y + 28, 2, network.connected() ? kText : kMuted);
}

void drawSettingsMenu(CharacterMode selected) {
  using namespace ui_color;
  using namespace settings_layout;
  display.fillScreen(0);
  drawWifiStatusButton();
  display.fillRoundRect(38, 92, 390, 336, 28, kPanel);
  display.drawRoundRect(38, 92, 390, 336, 28, kPanelBorder);
  char value[8];
  snprintf(value, sizeof(value), "%u%%",
           static_cast<unsigned>((settings.brightness() * 100 + 127) / 255));
  drawStepper("Brightness", kBrightnessDown, kBrightnessUp, value, 211);
  const bool soundOff = settings.soundVolume() == 0;
  if (soundOff) snprintf(value, sizeof(value), "Off");
  else snprintf(value, sizeof(value), "%u%%", static_cast<unsigned>(settings.soundVolume()));
  drawStepper("Volume", kVolumeDown, kVolumeUp, value, soundOff ? 215 : 211);
  drawText("Character", 185, 222, 2, kText);
  // Only the installed pack is on the device; the daemon installs a different one.
  display.fillRoundRect(58, 244, 350, 34, 10, kBackground);
  drawCenteredText(characterPack() ? characterPack()->header.name : "None", 253, 2, kText);
  drawCenteredText("Character state", 286, 2, kText);
  for (const LabeledButton& button : kModeButtons) {
    CharacterMode mode;
    const bool active = requestedMode(settingsModeCommand(button.action), mode) && mode == selected;
    drawSettingsButton(button.rect, button.label, active, button.textSize);
  }
  flushDisplay();
}

void drawNetworkSettings() {
  using namespace ui_color;
  const WifiStatus status = wifiStatus();
  display.fillScreen(0);
  drawText("Wi-Fi", 153, 48, 3, kText);
  display.fillRoundRect(38, 92, 390, 350, 28, kPanel);
  display.fillCircle(60, 125, 7, status.color);
  drawText(status.label, 72, 116, 2, status.color);
  if (network.configured()) {
    char ssid[40];
    fitText(ssid, sizeof(ssid), network.ssid(), 26);
    drawText(ssid, 72, 146, 2, network.connected() ? kText : kMuted);
    char address[32];
    snprintf(address, sizeof(address), "IP %s",
             network.connected() ? network.address() : "not assigned");
    drawText(address, 72, 172, 1, kMuted);
  }
  if (network.setupActive()) {
    drawText(network.setupName(), 72, 202, 2, kText);
    drawText("Password and pairing code:", 72, 232, 1, kText);
    drawText(network.pairingCode(), 162, 254, 3, kText);
    drawText("Open http://192.168.4.1", 124, 294, 1, kText);
  } else {
    drawText("Start setup to connect or reconfigure.", 86, 218, 1, kMuted);
  }
  drawSettingsButton(settings_layout::kWifiSetup,
                     network.setupActive() ? "Restart setup" : "Setup Wi-Fi",
                     network.setupActive());
  drawSettingsButton(settings_layout::kBack, "Back", false);
  flushDisplay();
}

void clearCharacterMargins() {
  display.fillRect(0, 0, kCharacterFrameX, kDisplaySize, 0);
  display.fillRect(kCharacterFrameX + kCharacterFrameWidth, 0,
                   kDisplaySize - kCharacterFrameX - kCharacterFrameWidth, kDisplaySize, 0);
}

// An open menu suppresses the frame transfer, so the panel holds whatever the
// menu last drew. It closes after kSettingsIdleTimeoutMs without input, so a menu
// left open, or one that cannot be closed because touch stopped responding, can
// never strand the display.
uint32_t settingsActivityMs = 0;

// Every close path goes through here so the log always says why the menu went away.
void closeSettings(const char* reason) {
  settings.close();
  clearCharacterMargins();
  logMessage("SETTINGS closed=%s\n", reason);
}

void closeIdleSettings() {
  if (!settings.isOpen()) return;
  // The Wi-Fi setup page shows the pairing code the user is typing on another device.
  if (settings.networkPage() && network.setupActive()) settingsActivityMs = millis();
  if (millis() - settingsActivityMs > kSettingsIdleTimeoutMs) closeSettings("timeout");
}

void handleTouchGesture(const TouchGesture& gesture, const Frame& frame) {
  // Any gesture counts as activity, including ones the menu ignores.
  settingsActivityMs = millis();
  if (gesture.kind == TouchGestureKind::SwipeUp && !settings.isOpen()) {
    settings.open();
    queueAudioCue(AudioCue::Settings);
    drawSettingsMenu(frame.state.requestedMode);
    logMessage("SETTINGS opened\n");
    return;
  }
  if (gesture.kind == TouchGestureKind::SwipeDown && settings.isOpen()) {
    queueAudioCue(AudioCue::Settings);
    closeSettings("swipe");
    return;
  }
  if (gesture.kind != TouchGestureKind::Tap) return;
  if (!settings.isOpen()) {
    const int x = gesture.endX - kCharacterFrameX, y = gesture.endY;
    if (x >= 0 && y >= 0 && x < kCharacterFrameWidth && y < kCharacterFrameHeight
        && frame.pixels[y * kCharacterFrameWidth + x] != 0) {
      logMessage("TOUCH tap x=%d y=%d\n", gesture.endX, gesture.endY);
      queueTouchSurprise();
    }
    return;
  }
  const SettingsAction action = settings.tap(gesture.endX, gesture.endY);
  switch (action) {
    case SettingsAction::BrightnessDown:
    case SettingsAction::BrightnessUp:
      display.setBrightness(settings.brightness());
      queueAudioCue(AudioCue::Settings);
      drawSettingsMenu(frame.state.requestedMode);
      logMessage("SETTINGS brightness=%u\n", static_cast<unsigned>(settings.brightness()));
      break;
    case SettingsAction::SoundDown:
    case SettingsAction::SoundUp:
      setSoundVolume(settings.soundVolume());
      saveSoundVolume(settings.soundVolume());
      queueAudioCue(AudioCue::Settings);
      drawSettingsMenu(frame.state.requestedMode);
      logMessage("SETTINGS sound_volume=%u\n",
                 static_cast<unsigned>(settings.soundVolume()));
      break;
    case SettingsAction::Wifi:
      settings.openNetwork();
      queueAudioCue(AudioCue::Settings);
      drawNetworkSettings();
      break;
    case SettingsAction::WifiSetup:
      if (!network.startSetup()) logMessage("WIFI_ERROR setup access point failed\n");
      queueAudioCue(AudioCue::Settings);
      drawNetworkSettings();
      logMessage("WIFI setup=%s code=%s\n", network.setupName(), network.pairingCode());
      break;
    case SettingsAction::Back:
      settings.back();
      queueAudioCue(AudioCue::Settings);
      drawSettingsMenu(frame.state.requestedMode);
      break;
    case SettingsAction::Idle:
    case SettingsAction::Surprise:
    case SettingsAction::Working:
    case SettingsAction::Complete:
    case SettingsAction::Attention:
      closeSettings("mode");
      queueMode(settingsModeCommand(action));
      break;
    case SettingsAction::Close:
      queueAudioCue(AudioCue::Settings);
      closeSettings("button");
      break;
    case SettingsAction::None: break;
  }
}

void sendUploadMessage(const char* message) {
  writeCapture(reinterpret_cast<const uint8_t*>(message), std::strlen(message));
}

bool pauseRendering() {
  portENTER_CRITICAL(&renderLock);
  renderPaused = true;
  portEXIT_CRITICAL(&renderLock);
  const uint32_t started = millis();
  for (;;) {
    portENTER_CRITICAL(&renderLock);
    const bool active = renderActive;
    portEXIT_CRITICAL(&renderLock);
    if (!active) return true;
    if (millis() - started > kRenderPauseTimeoutMs) return false;
    delay(1);
  }
}

void drawInstallScreen(const char* source) {
  updateOrientation();
  display.fillScreen(0);
  display.setBrightness(settings.brightness());
  drawCenteredText("Installing character", 140, 2, ui_color::kText);
  drawCenteredText(source, 208, 2, ui_color::kMuted);
  display.drawRoundRect(83, 238, 300, 24, 8, ui_color::kButtonBorder);
  flushDisplay();
}

// The pack's display name arrives in its header, shortly after the transfer starts.
void drawInstallName() {
  static bool drawn = false;
  const char* name = characterInstallName();
  if (drawn || !name) return;
  drawn = true;
  const bool large = textWidth(name, 3) <= 340;
  drawCenteredText(name, large ? 172 : 176, large ? 3 : 2, ui_color::kAccent);
}

void drawInstallProgress(uint32_t received, uint32_t total) {
  static int shown = -1;
  const bool orientationChanged = updateOrientation();
  drawInstallName();
  const int percent = total ? static_cast<int>(uint64_t(received) * 100 / total) : 0;
  if (percent == shown && !orientationChanged) return;
  shown = percent;
  display.fillRoundRect(86, 241, std::max(1, 294 * percent / 100), 18, 6, ui_color::kButtonActive);
  char label[8];
  snprintf(label, sizeof(label), "%d%%", percent);
  display.fillRect(183, 276, 100, 16, 0);
  drawCenteredText(label, 276, 2, ui_color::kText);
  flushDisplay();
}

void drawInstallResult(const char* error) {
  updateOrientation();
  display.fillRect(40, 300, 386, 60, 0);
  if (error) {
    drawCenteredText("Install failed", 306, 2, ui_color::kError);
    char detail[64];
    fitText(detail, sizeof(detail), error, 50);
    drawCenteredText(detail, 332, 1, ui_color::kMuted);
  } else {
    drawCenteredText("Installed. Restarting...", 306, 2, ui_color::kSuccess);
  }
  flushDisplay();
}

// Stops pack reads, then erases the old pack; every attempt ends in a restart.
const char* startInstall(const char* source) {
  installStarted = true;
  if (characterReady && !pauseRendering()) return "Renderer did not pause.";
  installOwnsFlash = true;
  drawInstallScreen(source);
  logMessage("CHARACTER install=started source=%s\n", source);
  return beginCharacterInstall();
}

unsigned stalls = 0, resyncs = 0;

[[noreturn]] void restartAfterUsbInstall(const char* error) {
  char message[160];
  if (error) {
    if (installOwnsFlash) abortCharacterInstall();
    snprintf(message, sizeof(message), "UPLOAD_ERROR %s\n", error);
  } else {
    snprintf(message, sizeof(message), "UPLOAD_OK character=%s stalls=%u resyncs=%u rebooting\n",
             characterPack()->header.id, stalls, resyncs);
  }
  if (installOwnsFlash) drawInstallResult(error);
  sendUploadMessage(message);
  delay(error ? 2000 : 500);
  ESP.restart();
  for (;;) {}
}

void installCharacterFromUsb() {
  if (const char* error = startInstall("over USB")) restartAfterUsbInstall(error);
  char ready[80];
  snprintf(ready, sizeof(ready), "UPLOAD_READY max_bytes=%u chunk=%u\n",
           static_cast<unsigned>(characterPartitionBytes()),
           static_cast<unsigned>(kCharacterUploadChunkBytes));
  sendUploadMessage(ready);
  Serial.setTimeout(100);
  unsigned kicks = 0;
  for (;;) {
    const uint32_t received = characterInstallReceived();
    const uint32_t total = characterInstallTotal();
    if (total && received == total) break;
    const size_t expected = total
        ? std::min<size_t>(kCharacterUploadChunkBytes, total - received)
        : kCharacterUploadChunkBytes;
    size_t buffered = 0;
    uint32_t progress = millis();
    while (buffered < expected) {
      const size_t count = Serial.readBytes(
          reinterpret_cast<char*>(transferBuffer + buffered), expected - buffered);
      buffered += count;
      if (count) {
        progress = millis();
        kicks = 0;
        continue;
      }
      if (millis() - progress < kCharacterUploadStallMs) continue;
      // USB Serial/JTAG reception can stall until the device transmits; a short line resumes it.
      if (kicks < kCharacterUploadKicks) {
        ++kicks;
        ++stalls;
        char wait[64];
        snprintf(wait, sizeof(wait), "UPLOAD_WAIT received=%u buffered=%u\n",
                 static_cast<unsigned>(received), static_cast<unsigned>(buffered));
        sendUploadMessage(wait);
        progress = millis();
        continue;
      }
      // Still stalled: discard the partial chunk once the line is quiet, then ask for it again.
      if (++resyncs > kCharacterUploadRetries) restartAfterUsbInstall("timeout");
      char retry[48];
      snprintf(retry, sizeof(retry), "UPLOAD_RETRY received=%u\n", static_cast<unsigned>(received));
      sendUploadMessage(retry);
      for (uint32_t quiet = millis(), started = quiet;
           millis() - quiet < kCharacterUploadQuietMs && millis() - started < 3000;) {
        if (Serial.available()) {
          Serial.read();
          quiet = millis();
        } else {
          delay(1);
        }
      }
      snprintf(retry, sizeof(retry), "UPLOAD_RESEND received=%u\n", static_cast<unsigned>(received));
      sendUploadMessage(retry);
      buffered = 0;
      kicks = 0;
      progress = millis();
    }
    if (const char* error = writeCharacterInstall(transferBuffer, buffered))
      restartAfterUsbInstall(error);
    char acknowledgement[64];
    snprintf(acknowledgement, sizeof(acknowledgement), "UPLOAD_ACK received=%u total=%u\n",
             static_cast<unsigned>(characterInstallReceived()),
             static_cast<unsigned>(characterInstallTotal()));
    sendUploadMessage(acknowledgement);
    drawInstallProgress(characterInstallReceived(), characterInstallTotal());
  }
  restartAfterUsbInstall(finishCharacterInstall());
}

const char* beginWifiInstall() {
  return startInstall("over Wi-Fi");
}

const char* writeWifiInstall(const uint8_t* data, size_t bytes) {
  const char* error = writeCharacterInstall(data, bytes);
  drawInstallProgress(characterInstallReceived(), characterInstallTotal());
  return error;
}

const char* finishWifiInstall() {
  const char* error = finishCharacterInstall();
  if (error) abortCharacterInstall();
  drawInstallResult(error);
  restartAt = deadlineAfter(millis(), error ? 2000 : 750);
  return error;
}

void abortWifiInstall(const char* error) {
  // If the renderer never paused, leave the installed pack alone and just restart.
  if (installOwnsFlash) {
    abortCharacterInstall();
    drawInstallResult(error);
  }
  if (installStarted) restartAt = deadlineAfter(millis(), 2000);
}

const char* installedCharacterId() {
  return characterPack() ? characterPack()->header.id : "none";
}

const NetworkManager::CharacterUpload kWifiUpload{
    beginWifiInstall, writeWifiInstall, finishWifiInstall, abortWifiInstall,
    installedCharacterId};

void drawShellScreen() {
  display.fillScreen(0);
  drawWifiStatusButton();
  drawCenteredText("No character installed", 196, 2, ui_color::kText);
  drawCenteredText("Connect USB or Wi-Fi and run", 236, 1, ui_color::kMuted);
  drawCenteredText("npm run character", 256, 2, ui_color::kMuted);
  drawCenteredText(spriteStorageError() ? spriteStorageError() : "", 300, 1, ui_color::kMuted);
  flushDisplay();
}

bool queueNetworkMode(const char* state) {
  const DeviceCommand command = modeCommand(state);
  if (command == DeviceCommand::Invalid) return false;
  queueMode(command);
  return true;
}

bool handleBadgePacket(const char* packet, char* response, size_t responseSize) {
  if (!packet || !response || responseSize == 0) return false;
  response[0] = '\0';
  const auto reject = [&] {
    snprintf(response, responseSize, "COMMAND_ERROR %s", agentBadges.error());
    return false;
  };
  if (packet[0] == '%') {
    if (!agentBadges.setIconPacket(packet + 1)) return reject();
    const char* separator = std::strchr(packet + 1, ':');
    snprintf(response, responseSize, "ICON accepted=%.*s",
             separator ? static_cast<int>(separator - (packet + 1)) : 0, packet + 1);
    return true;
  }
  if (packet[0] == '&') {
    if (!agentBadges.setActivePacket(packet + 1)) return reject();
    snprintf(response, responseSize, "AGENTS accepted=%u", static_cast<unsigned>(agentBadges.activeCount()));
    return true;
  }
  if (packet[0] == '$') {
    if (!agentBadges.setUsagePacket(packet + 1)) return reject();
    snprintf(response, responseSize, "USAGE accepted=%u", static_cast<unsigned>(agentBadges.usage().count));
    return true;
  }
  snprintf(response, responseSize, "COMMAND_ERROR invalid badge packet");
  return false;
}

bool decodeWifiValue(const char* encoded, size_t encodedLength, char* output,
                     size_t outputCapacity, bool required) {
  size_t decodedLength = 0;
  if (encodedLength == 0) {
    output[0] = '\0';
    return !required;
  }
  if (mbedtls_base64_decode(reinterpret_cast<unsigned char*>(output), outputCapacity - 1,
                            &decodedLength,
                            reinterpret_cast<const unsigned char*>(encoded),
                            encodedLength) != 0
      || decodedLength >= outputCapacity
      || std::memchr(output, '\0', decodedLength)) return false;
  output[decodedLength] = '\0';
  return !required || decodedLength > 0;
}

void reportWifiScanLine(const char* line) {
  logMessage("%s\n", line);
}

void configureWifi(const char* payload) {
  const char* separator = std::strchr(payload, ':');
  if (!separator || std::strchr(separator + 1, ':')) {
    logMessage("WIFI_ERROR invalid packet\n");
    return;
  }
  char ssid[33] = {};
  char password[65] = {};
  if (!decodeWifiValue(payload, separator - payload, ssid, sizeof(ssid), true)
      || !decodeWifiValue(separator + 1, std::strlen(separator + 1),
                          password, sizeof(password), false)
      || !network.configure(ssid, password)) {
    logMessage("WIFI_ERROR invalid credentials or storage failure\n");
    return;
  }
  logMessage("WIFI configured device_id=%s token=%s\n",
             network.deviceId(), network.token());
}

void processCommand(DeviceCommand command, const DeviceCommands& parser, const Frame* frame) {
  switch (command) {
    case DeviceCommand::ConfigureOrientation: {
      int16_t tenths;
      if (!parseOrientationOffset(parser.payload(), tenths)) {
        logMessage("COMMAND_ERROR invalid orientation offset\n");
        break;
      }
      if (const char* error = configureOrientation(tenths)) {
        logMessage("COMMAND_ERROR %s\n", error);
        break;
      }
      logMessage("ORIENTATION_SETTINGS offset_tenths=%d\n", orientationOffsetTenths);
      break;
    }
    case DeviceCommand::GetOrientation:
      logMessage("ORIENTATION_SETTINGS offset_tenths=%d\n", orientationOffsetTenths);
      break;
    case DeviceCommand::None: break;
    case DeviceCommand::Invalid: logMessage("COMMAND_ERROR invalid or incomplete packet\n"); break;
    case DeviceCommand::Capture:
      if (frame) captureFrame(*frame);
      else logMessage("CAPTURE_ERROR no character installed\n");
      break;
    case DeviceCommand::Heap:
      if (!heap_caps_check_integrity_all(true)) fatal("Heap integrity check failed.");
      logMessage("HEAP integrity=ok\n");
      break;
    case DeviceCommand::Info: {
      const CharacterPack* pack = characterPack();
      char ssid[48];
      network.encodedSsid(ssid, sizeof(ssid));
      logMessage("INFO protocol=%u uptime_ms=%llu reset_reason=%u mode=%s requested=%s assets=%u "
                 "max_gap_us=%u dropped_logs=%u audio_ready=%u sound_volume=%u character=%s "
                 "patch_ram=adaptive patch_internal=%u startup_internal=%u wifi_connected=%u ssid_b64=%s firmware=%s\n",
                    kDeviceProtocol, static_cast<unsigned long long>(esp_timer_get_time() / 1000),
                    static_cast<unsigned>(esp_reset_reason()),
                    frame ? modeName(frame->state.mode) : "none",
                    frame ? modeName(frame->state.requestedMode) : "none",
                    static_cast<unsigned>(pack ? pack->header.totalBytes : 0), worstPresentationGap,
                    droppedLogs.load(std::memory_order_relaxed), static_cast<unsigned>(audioReady()),
                    static_cast<unsigned>(soundVolume()), installedCharacterId(),
                    patchBuffersInternal, static_cast<unsigned>(startupFreeInternal),
                    static_cast<unsigned>(network.connected()), ssid, network.firmwareId());
      if (pack) {
        logMessage("CHARACTER id=%s layout=%s bytes=%u name=%s\n", pack->header.id,
                   pack->header.layout == PackLayout::FullFrame ? "full-frame" : "base-patch",
                   static_cast<unsigned>(pack->header.totalBytes), pack->header.name);
      } else {
        logMessage("CHARACTER id=none reason=%s\n", spriteStorageError());
      }
      logMessage("WIFI configured=%u connected=%u address=%s setup=%u\n",
                 static_cast<unsigned>(network.configured()),
                 static_cast<unsigned>(network.connected()), network.address(),
                 static_cast<unsigned>(network.setupActive()));
      break;
    }
    case DeviceCommand::UploadCharacter:
      installCharacterFromUsb();
      break;
    case DeviceCommand::ConfigureWifi:
      configureWifi(parser.payload());
      break;
    case DeviceCommand::ScanWifi:
      if (!network.startScan(reportWifiScanLine)) logMessage("WIFI_SCAN_ERROR scan unavailable\n");
      break;
    case DeviceCommand::DefineAgentIcon:
    case DeviceCommand::SetAgentBadges:
    case DeviceCommand::SetUsage: {
      char response[96];
      char packet[196];
      snprintf(packet, sizeof(packet), "%c%s", badgePrefix(command), parser.payload());
      handleBadgePacket(packet, response, sizeof(response));
      logMessage("%s\n", response);
      break;
    }
    default: queueMode(command); break;
  }
}

// One parser for both loops: the device restarts between the shell and a character.
DeviceCommands commandParser;
UsbSerialWatchdog usbSerialWatchdog;

constexpr uint32_t kUsbSerialInterrupts = USB_SERIAL_JTAG_INTR_SERIAL_IN_EMPTY
    | USB_SERIAL_JTAG_INTR_SERIAL_OUT_RECV_PKT | USB_SERIAL_JTAG_INTR_BUS_RESET;

bool beginSerial() {
  const bool sendBufferReady = Serial.setTxBufferSize(2048) == 2048;
  // Character uploads send one acknowledged chunk at a time; HWCDC drops bytes when full.
  const bool receiveBufferReady = Serial.setRxBufferSize(kCharacterUploadRxBufferBytes)
      == kCharacterUploadRxBufferBytes;
  Serial.setTxTimeoutMs(0);
  Serial.begin(115200);
  if (!sendBufferReady || !receiveBufferReady) return false;
  Serial.setDebugOutput(true);
  return true;
}

void checkUsbSerial() {
  switch (usbSerialWatchdog.poll(usb_serial_jtag_ll_rxfifo_data_available(), millis())) {
    case UsbSerialWatchdog::Action::None: break;
    case UsbSerialWatchdog::Action::EnableInterrupts:
      usb_serial_jtag_ll_ena_intr_mask(kUsbSerialInterrupts);
      break;
    case UsbSerialWatchdog::Action::Restart:
      // Only this loop reads the port, and error logs from other tasks are rare.
      Serial.end();
      if (!beginSerial()) ++droppedLogs;
      logMessage("USB serial restarted\n");
      break;
  }
}

// For GET /status over Wi-Fi, which still works when the USB serial port does not.
int writeUsbSerialDiagnostics(char* output, size_t capacity) {
  return snprintf(output, capacity,
                  "{\"interruptEnable\":%u,\"interruptRaw\":%u,\"rxPending\":%s,"
                  "\"interruptEnables\":%u,\"restarts\":%u}",
                  static_cast<unsigned>(usb_serial_jtag_ll_get_intr_ena_status()),
                  static_cast<unsigned>(USB_SERIAL_JTAG.int_raw.val),
                  usb_serial_jtag_ll_rxfifo_data_available() ? "true" : "false",
                  static_cast<unsigned>(usbSerialWatchdog.interruptEnables()),
                  static_cast<unsigned>(usbSerialWatchdog.restarts()));
}

void processSerialCommands(const Frame* frame, unsigned maxBytes) {
  checkUsbSerial();
  processCommand(commandParser.expire(esp_timer_get_time() / 1000), commandParser, frame);
  for (unsigned read = 0; read < maxBytes && Serial.available(); ++read)
    processCommand(commandParser.feed(static_cast<char>(Serial.read()), esp_timer_get_time() / 1000),
                   commandParser, frame);
}
}

// Wi-Fi and TCP/IP allocate internal RAM after the character starts, and again whenever Wi-Fi is set
// up later. Blink buffers use internal RAM only while kPatchInternalReserveBytes stays free for them,
// so a pack with large blink patches can't starve the network. The rest go to PSRAM.
void* allocatePatchBuffer(size_t bytes, const char* error) {
  constexpr uint32_t caps = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
  if (heap_caps_get_free_size(caps) >= bytes + kPatchInternalReserveBytes) {
    if (void* result = heap_caps_malloc(bytes, caps)) {
      ++patchBuffersInternal;
      return result;
    }
  }
  return allocate(bytes, MALLOC_CAP_SPIRAM, error);
}

void startCharacter() {
  const PackHeader& pack = characterPack()->header;
  for (auto& frame : frames) {
    frame.pixels = static_cast<uint16_t*>(allocate(kCharacterFrameWidth * kCharacterFrameHeight * 2,
        MALLOC_CAP_SPIRAM, "Framebuffer PSRAM allocation failed."));
    std::memset(frame.pixels, 0, kCharacterFrameWidth * kCharacterFrameHeight * 2);
    Frame* pointer = &frame;
    xQueueSend(freeFrames, &pointer, portMAX_DELAY);
  }
  if (pack.layout == PackLayout::FullFrame) {
    auto* scratch = static_cast<uint16_t*>(allocate(
        kCharacterFrameWidth * kFrameHeight * sizeof(uint16_t), MALLOC_CAP_SPIRAM,
        "Full-frame blink buffer allocation failed."));
    auto* cached = static_cast<uint16_t*>(allocate(
        kCharacterFrameWidth * kCharacterFrameHeight * sizeof(uint16_t), MALLOC_CAP_SPIRAM,
        "Full-frame decoded cache allocation failed."));
    fullFrameRenderer = new (allocate(sizeof(FullFrameRenderer), MALLOC_CAP_INTERNAL,
        "Renderer allocation failed.")) FullFrameRenderer(scratch, cached, inflatePose);
  } else {
    const size_t patchPixels = std::max<size_t>(1, pack.maxPatchPixels);
    const size_t patchBytes = patchPixels * sizeof(uint16_t);
    startupFreeInternal = heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    auto* firstOpenPatch = static_cast<uint16_t*>(allocatePatchBuffer(
        patchBytes, "First open-eye cache allocation failed."));
    auto* secondOpenPatch = static_cast<uint16_t*>(allocatePatchBuffer(
        patchBytes, "Second open-eye cache allocation failed."));
    auto* patch = static_cast<uint16_t*>(allocatePatchBuffer(
        patchBytes, "Blink patch allocation failed."));
    patchRenderer = new (allocate(sizeof(SpriteRenderer), MALLOC_CAP_INTERNAL,
        "Renderer allocation failed.")) SpriteRenderer(
            firstOpenPatch, secondOpenPatch, patch, patchPixels, frames[0].pixels,
            frames[1].pixels, inflatePose, kCharacterFrameWidth, kCharacterFrameHeight);
  }
  // Leave internal RAM for Wi-Fi bursts; restoration records do not require DMA.
  void* effectMemory = allocate(sizeof(CharacterEffects), MALLOC_CAP_SPIRAM, "Effects allocation failed.");
  auto* badgeOverlay = static_cast<uint16_t*>(allocate(
      CharacterEffects::kOverlayScratchPixels * sizeof(uint16_t), MALLOC_CAP_SPIRAM,
      "Badge overlay allocation failed."));
  effects = new (effectMemory) CharacterEffects(frames[0].pixels, frames[1].pixels, &agentBadges, badgeOverlay);
  // Warm both frame caches before starting the presentation clock and brightness fade.
  CharacterSprite sprite(patchRenderer, fullFrameRenderer);
  for (auto& frame : frames) {
    if (!sprite.render(CharacterState{}, frame.pixels)) fatal(sprite.error());
  }
  if (xTaskCreatePinnedToCore(animate, "copilot-render", 16384, nullptr, 1,
                              &renderTask, 0) != pdPASS) fatal("Render task creation failed.");
}

void setup() {
  if (!beginSerial()) fatal("USB buffer allocation failed.");
  if (!psramFound()) fatal("8 MB OPI PSRAM not detected.");
  logMessage("\nAgent Companion character shell / %s (%s)\nPanel: %s, touch: %s\nPSRAM: %u bytes\n",
             board::kName, board::kId, board::kDisplayPanelName, board::kTouchControllerName,
             ESP.getPsramSize());
  if (!display.begin(kSpiFrequency)) fatal(display.error());
  display.setBrightness(0);
  display.fillScreen(0);
  characterReady = initializeSpriteStorage();
  if (!characterReady) logMessage("CHARACTER id=none reason=%s\n", spriteStorageError());
  if (!initializeTouchInput()) fatal(touchInputError());
  pinMode(kBootButtonPin, INPUT_PULLUP);
  orientationOffsetTenths = loadOrientationOffset();
  orientationDirty = display.setTrim(orientationOffsetTenths * kOrientationPi / 1800.0f);
  // Start Wi-Fi before renderer and audio allocations so the radio stack can reserve contiguous
  // internal RAM. The character allocator will move optional patch buffers to PSRAM as needed.
  network.begin(queueNetworkMode, &kWifiUpload, handleBadgePacket, &kOrientationControl,
                writeUsbSerialDiagnostics);
  if (!orientationSensor.begin()) {
    logMessage("ORIENTATION disabled reason=%s\n", orientationSensor.error());
  } else {
    logMessage("ORIENTATION sensor=%s mode=continuous\n", board::kImuName);
  }
  const uint8_t storedSoundVolume = loadSoundVolume();
  settings.setSoundVolume(storedSoundVolume);
  setSoundVolume(storedSoundVolume);
  beginAudio();
  transferBuffer = static_cast<uint8_t*>(heap_caps_aligned_alloc(
      16, kTransferBytes, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL));
  if (!transferBuffer) fatal("DMA staging allocation failed.");
  if (!display.setTransferBuffer(transferBuffer, kTransferBytes)) fatal(display.error());
  freeFrames = xQueueCreate(2, sizeof(Frame*));
  readyFrames = xQueueCreate(2, sizeof(Frame*));
  commands = xQueueCreate(8, sizeof(ModeRequest));
  if (!freeFrames || !readyFrames || !commands) fatal("Frame or command queue allocation failed.");
  if (characterReady) startCharacter();
  if (!characterReady) {
    drawShellScreen();
    display.setBrightness(settings.brightness());
  }
  logMessage("READY: %dx%d, target %d fps, character=%s bytes=%u\n",
             kDisplaySize, kDisplaySize, kTargetFps, installedCharacterId(),
             static_cast<unsigned>(characterReady ? characterPack()->header.totalBytes : 0));
}

// A BOOT button press asks the computer to open Settings. USB gets a line now; over Wi-Fi the
// daemon sees the count go up in GET /status. While a Wi-Fi firmware update waits, the press
// allows the update instead.
void pollBootButton() {
  if (!bootButton.sample(digitalRead(kBootButtonPin) == LOW, millis())) return;
  if (network.approveFirmware()) {
    logMessage("BUTTON firmware allowed\n");
    return;
  }
  network.setButtonPresses(++buttonPresses);
  logMessage("BUTTON settings presses=%u\n", static_cast<unsigned>(buttonPresses));
}

// The prompt replaces the character while a Wi-Fi firmware update waits for the BOOT press, and
// stays until the device restarts into the new firmware. Returns true while it shows.
bool showFirmwarePrompt(bool shell) {
  enum class Prompt : uint8_t { None, Waiting, Allowed, Restarting };
  static Prompt shown = Prompt::None;
  Prompt prompt = Prompt::None;
  if (network.firmwareRestarting()) prompt = Prompt::Restarting;
  else if (network.firmwareApproval() == NetworkManager::FirmwareApproval::Waiting) prompt = Prompt::Waiting;
  else if (network.firmwareApproval() == NetworkManager::FirmwareApproval::Allowed) prompt = Prompt::Allowed;
  if (prompt == shown) return prompt != Prompt::None;
  shown = prompt;
  if (prompt == Prompt::None) {
    if (shell) drawShellScreen();
    else clearCharacterMargins();
    return false;
  }
  if (settings.isOpen()) closeSettings("firmware");
  display.fillScreen(0);
  display.setBrightness(settings.brightness());
  drawCenteredText("Firmware update", 150, 3, ui_color::kText);
  if (prompt == Prompt::Waiting) {
    drawCenteredText("Press BOOT to allow it", 206, 2, ui_color::kAccent);
    drawCenteredText("Did not start an update? Do nothing.", 246, 1, ui_color::kMuted);
    drawCenteredText("The request stops in 60 seconds.", 266, 1, ui_color::kMuted);
  } else if (prompt == Prompt::Allowed) {
    drawCenteredText("Allowed. Receiving...", 206, 2, ui_color::kSuccess);
  } else {
    drawCenteredText("Installed. Restarting...", 206, 2, ui_color::kSuccess);
  }
  flushDisplay();
  return true;
}

// Without a pack the shell keeps USB, Wi-Fi setup, and installation available.
void shellLoop() {
  static uint32_t networkRevision = UINT32_MAX;
  network.update();
  const bool orientationChanged = updateOrientation();
  if (restartAt || installStarted) return;
  const bool prompt = showFirmwarePrompt(true);
  if (network.revision() != networkRevision) {
    if (!prompt) drawShellScreen();
    networkRevision = network.revision();
  }
  if (orientationChanged) flushDisplay();
  pollBootButton();
  processSerialCommands(nullptr, 64);
  delay(5);
}

void loop() {
  static uint64_t lastReport = esp_timer_get_time();
  static uint64_t renderTotal = 0, transferTotal = 0;
  static uint32_t frameCount = 0, maxRender = 0, fadeFrame = 0;
  static int64_t nextPresentation = 0, previousPresentation = 0;
  static uint32_t minGap = UINT32_MAX, maxGap = 0;
  static uint32_t previousEvent = UINT32_MAX;
  static CharacterMode previousMode = CharacterMode::Idle;
  static uint32_t networkRevision = UINT32_MAX;
  if (restartAt) {
    network.update();
    if (elapsed(millis(), restartAt)) ESP.restart();
    delay(5);
    return;
  }
  if (!characterReady) {
    shellLoop();
    return;
  }
  network.update();
  const bool orientationChanged = updateOrientation();
  if (installStarted) return;
  Frame* frame;
  if (xQueueReceive(readyFrames, &frame, pdMS_TO_TICKS(3000)) != pdTRUE) fatal("Renderer stalled.");
  const bool prompt = showFirmwarePrompt(false);
  if (settings.isOpen() && network.revision() != networkRevision) {
    if (settings.networkPage()) drawNetworkSettings();
    else drawSettingsMenu(frame->state.requestedMode);
    networkRevision = network.revision();
  }
  // Pace presentation, not decoding: cached frames must not arrive earlier than newly decoded poses.
  waitUntil(nextPresentation);
  const int64_t start = esp_timer_get_time();
  nextPresentation = start + 1000000 / kTargetFps;
  if (previousPresentation) {
    const uint32_t gap = start - previousPresentation;
    minGap = std::min(minGap, gap);
    maxGap = std::max(maxGap, gap);
    worstPresentationGap = std::max(worstPresentationGap, gap);
  }
  previousPresentation = start;
  uint32_t transferUs = 0;
  if (!settings.isOpen() && !prompt) {
    if (!display.flushFrame(
            frame->pixels, kCharacterFrameX, 0, kCharacterFrameWidth, kCharacterFrameHeight))
      fatal(display.error());
  } else if (orientationChanged) {
    flushDisplay();
  }
  transferUs = esp_timer_get_time() - start;
  if (fadeFrame <= 40) {
    display.setBrightness(static_cast<uint8_t>(settings.brightness() * smoother(fadeFrame / 40.0f)));
    ++fadeFrame;
  }
  TouchGesture gesture;
  if (pollTouchGesture(gesture) && !prompt) handleTouchGesture(gesture, *frame);
  if (touchInputError()) fatal(touchInputError());
  pollBootButton();
  closeIdleSettings();
  processSerialCommands(frame, 8);
  if (frame->state.eventId != previousEvent || frame->state.mode != previousMode) {
    logMessage("STATE mode=%s requested=%s event=%u\n", modeName(frame->state.mode),
                  modeName(frame->state.requestedMode), frame->state.eventId);
    if (frame->state.mode != previousMode) queueModeCue(frame->state.mode);
    previousEvent = frame->state.eventId;
    previousMode = frame->state.mode;
  }
  if (captureInterrupted) {
    previousPresentation = nextPresentation = 0;
    captureInterrupted = false;
  }
  renderTotal += frame->renderUs;
  transferTotal += transferUs;
  maxRender = std::max(maxRender, frame->renderUs);
  ++frameCount;
  const auto timing = *frame;
  xQueueSend(freeFrames, &frame, portMAX_DELAY);
  const uint64_t now = esp_timer_get_time();
  if (now - lastReport >= 5000000) {
    if (Serial) {
      logMessage("PERF fps=%.1f render=%.2fms transfer=%.2fms max_render=%.2fms free_psram=%u dropped_logs=%u\n",
                    frameCount * 1000000.0 / (now - lastReport),
                    renderTotal / (1000.0 * frameCount), transferTotal / (1000.0 * frameCount),
                    maxRender / 1000.0, ESP.getFreePsram(), droppedLogs.load(std::memory_order_relaxed));
      logMessage("ORIENTATION available=%u angle=%.1f display_angle=%.1f accel=%.3f,%.3f,%.3f\n",
                    orientationSensor.available(), orientationSensor.angle() * 180.0f / kOrientationPi,
                    display.angle() * 180.0f / kOrientationPi,
                    orientationSensor.accelerometerX(), orientationSensor.accelerometerY(),
                    orientationSensor.accelerometerZ());
      logMessage("SCANOUT compose=%uus spi_wait=%uus\n", display.composeUs(), display.writeUs());
      logMessage("STAGES motion=%uus decode=%uus composite=%uus eyes=%uus effects=%uus inflate=%uus predict=%uus\n",
                    timing.motionUs, timing.decodeUs, timing.compositeUs, timing.eyesUs, timing.effectsUs,
                    timing.inflateUs, timing.predictUs);
      logMessage("PACING min_gap_us=%u max_gap_us=%u\n",
                    minGap == UINT32_MAX ? 0 : minGap, maxGap);
      constexpr uint32_t internalCaps = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
      // ESP-IDF reports stack high-water marks in bytes, unlike vanilla FreeRTOS.
      logMessage("MEM free_internal=%u min_internal=%u largest_internal=%u free_psram=%u "
                    "render_stack_free=%u display_stack_free=%u\n",
                    static_cast<unsigned>(heap_caps_get_free_size(internalCaps)),
                    static_cast<unsigned>(heap_caps_get_minimum_free_size(internalCaps)),
                    static_cast<unsigned>(heap_caps_get_largest_free_block(internalCaps)), ESP.getFreePsram(),
                    static_cast<unsigned>(uxTaskGetStackHighWaterMark(renderTask)),
                    static_cast<unsigned>(uxTaskGetStackHighWaterMark(nullptr)));
      logMessage("POSE direction=%u frame=%u blink=%u\n", static_cast<unsigned>(timing.state.pose.direction),
                    static_cast<unsigned>(timing.state.pose.index), static_cast<unsigned>(timing.state.pose.blinkLevel));
    }
    frameCount = maxRender = 0;
    minGap = UINT32_MAX;
    maxGap = 0;
    renderTotal = transferTotal = 0;
    lastReport = now;
  }
}
