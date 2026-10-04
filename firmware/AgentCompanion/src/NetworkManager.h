#pragma once

#include <cstddef>
#include <cstdint>

namespace copilot {
class NetworkManager {
 public:
  using CommandHandler = bool (*)(const char*);
  using BadgeHandler = bool (*)(const char* packet, char* response, size_t responseSize);
  // Streams an authenticated POST /character body into the device's pack installer.
  struct CharacterUpload {
    const char* (*begin)();
    const char* (*write)(const uint8_t* data, size_t bytes);
    const char* (*finish)();
    void (*abort)(const char* error);
    const char* (*installedId)();
  };

  void begin(CommandHandler commandHandler, const CharacterUpload* upload,
             BadgeHandler badgeHandler = nullptr);
  void update();
  bool startSetup();
  bool configure(const char* ssid, const char* password);
  // Scans for nearby networks without blocking; update() reports each result line through report.
  bool startScan(void (*report)(const char* line));

  bool configured() const { return configured_; }
  bool connected() const { return connected_; }
  bool setupActive() const { return setupActive_; }
  const char* ssid() const { return ssid_; }
  // Writes the network name as base64, since names may hold spaces, quotes, or any other byte.
  void encodedSsid(char* output, size_t capacity) const;
  const char* address() const { return address_; }
  const char* setupName() const { return setupName_; }
  const char* pairingCode() const { return pairingCode_; }
  const char* deviceId() const { return deviceId_; }
  const char* token() const { return token_; }
  // The first 16 hex digits of the running firmware's ELF SHA-256, as GET /status reports it.
  const char* firmwareId() const { return firmwareId_; }
  uint32_t revision() const { return revision_; }
  // How many times the BOOT button was pressed since startup; GET /status reports it.
  void setButtonPresses(uint32_t presses) { buttonPresses_ = presses; }
  // A Wi-Fi firmware update needs a BOOT press on the device. The daemon asks first (Waiting),
  // the press allows one upload (Allowed), and each state ends after kFirmwareApprovalMs.
  enum class FirmwareApproval : uint8_t { None, Waiting, Allowed };
  FirmwareApproval firmwareApproval() const;
  // Called on a BOOT press while the approval waits. Returns false when nothing waits.
  bool approveFirmware();
  // The device received new firmware and restarts into it.
  bool firmwareRestarting() const { return restartAt_ != 0; }

 private:
  void configureRoutes();
  void connect();
  void handleConfigure();
  void handlePair();
  void handleState();
  void handleIcon();
  void handleBadge(const char* fallback);
  void handleCharacterBody();
  void handleCharacterResponse();
  void handleFirmwareBody();
  void handleFirmwareResponse();
  void handleFirmwareApproval();
  void confirmFirmware();
  void handleDiscovery();
  void updateConnection();
  void updateScan();
  void stopSetup();
  void ensureIdentity();
  void setChanged();
  bool authorized() const;
  bool setupClient() const;

  CommandHandler commandHandler_ = nullptr;
  BadgeHandler badgeHandler_ = nullptr;
  const CharacterUpload* upload_ = nullptr;
  const char* uploadError_ = nullptr;
  bool uploadAuthorized_ = false;
  bool uploadStarted_ = false;
  const char* firmwareError_ = nullptr;
  bool firmwareAuthorized_ = false;
  bool firmwareStarted_ = false;
  bool firmwarePending_ = false;
  FirmwareApproval firmwareApproval_ = FirmwareApproval::None;
  uint32_t firmwareApprovalUntil_ = 0;
  uint32_t restartAt_ = 0;
  char firmwareId_[17] = {};
  char ssid_[33] = {};
  char password_[65] = {};
  char token_[33] = {};
  char deviceId_[17] = {};
  char hostname_[33] = {};
  char address_[16] = {};
  char setupName_[33] = {};
  char pairingCode_[9] = {};
  uint32_t bootId_ = 0;
  bool configured_ = false;
  bool connected_ = false;
  bool setupActive_ = false;
  bool serverStarted_ = false;
  bool discoveryStarted_ = false;
  bool identityReady_ = false;
  bool scanning_ = false;
  void (*scanReport_)(const char* line) = nullptr;
  uint32_t setupDeadline_ = 0;
  uint32_t stopSetupAt_ = 0;
  uint32_t reconnectAt_ = 0;
  uint32_t revision_ = 0;
  uint32_t buttonPresses_ = 0;
};
}
